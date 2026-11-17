import { Actor, ActorProvider } from '../ports/actor-provider';
import { AuditEntry, AuditSink, noopAuditSink } from '../ports/audit-sink';
import { PermissionChecker, denyAllPermissionChecker } from '../ports/permission-checker';
import { Repository, Row } from '../ports/repository';
import { ScopeResolver } from '../ports/scope-resolver';
import { aggregateFields, parseAggregateSpec, toLegacyShape } from '../query/aggregate';
import { FilterNode, and } from '../query/filter-ir';
import { parseQuery } from '../query/parser';
import { QueryParseError } from '../query/query-error';
import { coerceId, coerceRow } from './coerce';
import { CrudError } from './crud-error';
import { EntityDefinition, ExposedOp, INHERENTLY_PUBLIC_OPS, WriteOp } from './entity-rules';

export interface ListResult {
  total: number;
  rows: Row[];
  page: number;
  limit: number | 'all';
  /** Presente só quando `-aggregate` é pedido. */
  aggregations?: Record<string, unknown>;
}

export interface CrudServiceDeps<Ctx = unknown> {
  repository: Repository;
  scope?: ScopeResolver<Ctx>;
  actor?: ActorProvider<Ctx>;
  audit?: AuditSink;
  permissions?: PermissionChecker;
  /** Relógio injetável — auditoria e archive precisam ser determinísticos em teste. */
  clock?: () => Date;
  /**
   * Dependências que os hooks recebem (`deps`): o client do ORM para tabelas
   * de junção, serviços do projeto etc. Evita singletons/setters globais.
   */
  hookDeps?: Record<string, unknown>;
}

const MASK = '***';

function eq(path: string[], value: unknown): FilterNode {
  return { kind: 'cmp', path, operator: 'eq', value: value as never };
}

function serialize(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * Execução das operações genéricas.
 *
 * Três invariantes que aqui são estruturais, não convenção:
 *
 * 1. **Escopo em toda leitura e escrita por id.** Um `where: { id }` sem a
 *    coluna de tenant é IDOR entre tenants. Aqui o filtro de escopo é montado
 *    no núcleo, não no controller.
 * 2. **Permissão verificada no serviço**, não só no guard. Consumidor sem a
 *    camada de framework continua protegido; o guard é otimização, não a trava.
 * 3. **Auditoria na MESMA transação** da mutação. Log fire-and-forget perde
 *    evento exatamente quando ele importa.
 */
export class CrudService<Ctx = unknown> {
  private readonly repository: Repository;
  private readonly scope?: ScopeResolver<Ctx>;
  private readonly actorProvider?: ActorProvider<Ctx>;
  private readonly audit: AuditSink;
  private readonly permissions: PermissionChecker;
  private readonly clock: () => Date;
  private readonly hookDeps: Record<string, unknown>;

  constructor(deps: CrudServiceDeps<Ctx>) {
    this.hookDeps = deps.hookDeps ?? {};
    this.repository = deps.repository;
    if (deps.scope) this.scope = deps.scope;
    if (deps.actor) this.actorProvider = deps.actor;
    this.audit = deps.audit ?? noopAuditSink;
    this.permissions = deps.permissions ?? denyAllPermissionChecker;
    this.clock = deps.clock ?? (() => new Date());
  }

  async list(
    def: EntityDefinition,
    query: Record<string, string | string[] | undefined>,
    context: Ctx,
  ): Promise<ListResult> {
    return this.listWith(def, 'list', query, context);
  }

  /** `GET /public`: só vivos, ignorando qualquer `active=` do cliente. */
  async listPublic(
    def: EntityDefinition,
    query: Record<string, string | string[] | undefined>,
    context: Ctx,
  ): Promise<ListResult> {
    return this.listWith(def, 'listPublic', { ...query, active: 'true' }, context);
  }

  private async listWith(
    def: EntityDefinition,
    op: 'list' | 'listPublic',
    query: Record<string, string | string[] | undefined>,
    context: Ctx,
  ): Promise<ListResult> {
    await this.authorize(def, op, context);
    const scopeId = this.scopeIdOf(def, context);

    let parsed;
    try {
      parsed = parseQuery(query, {
        filterable: def.filterable,
        sortable: def.sortable,
        reserved: def.reservedKeys,
        ...(def.maxLimit !== undefined ? { maxLimit: def.maxLimit } : {}),
      });
    } catch (error) {
      throw this.asCrudError(error);
    }

    const extra = await def.rules.hooks?.preList?.({ context, deps: this.hookDeps, scopeId, repository: this.repository });
    const filter = and(
      [
        parsed.filter,
        this.scopeFilter(def, scopeId),
        this.activeFilter(def, query.active as string | undefined),
        this.createdAtFilter(query),
        extra || undefined,
      ].filter(Boolean) as FilterNode[],
    );

    const include = this.includeOf(def, query.show as string | string[] | undefined);
    const paginated = parsed.limit !== 'all' && query.all === undefined;

    const [total, rows] = await Promise.all([
      this.repository.count(def.delegate, filter),
      this.repository.findMany(def.delegate, {
        ...(filter ? { filter } : {}),
        orderBy: parsed.orderBy.length ? parsed.orderBy : [{ path: [def.idField], direction: 'desc' }],
        skip: paginated ? (parsed.page - 1) * (parsed.limit as number) : null,
        take: paginated ? (parsed.limit as number) : null,
        ...(include ? { include } : {}),
      }),
    ]);

    const aggregations = await this.aggregate(def, query['-aggregate'], filter);

    return {
      total,
      rows: rows.map((row) => this.mask(def, row, this.isPublicResponse(def, op))),
      page: parsed.page,
      limit: parsed.limit,
      ...(aggregations ? { aggregations } : {}),
    };
  }

  /**
   * `-aggregate=campo:count:sum:valor` — contrato herdado. Todo campo citado
   * passa pela allowlist `aggregatable`; sem ela, agregação seria porta para
   * somar qualquer coluna. Erro de sintaxe é 400 explícito, nunca uma
   * resposta silenciosa sem o bloco de agregação.
   */
  private async aggregate(
    def: EntityDefinition,
    raw: string | string[] | undefined,
    filter: FilterNode | undefined,
  ): Promise<Record<string, unknown> | undefined> {
    if (typeof raw !== 'string' || raw === '') return undefined;

    let spec;
    try {
      spec = parseAggregateSpec(raw);
    } catch (error) {
      throw new CrudError('VALIDATION_FAILED', (error as Error).message, '-aggregate');
    }
    for (const field of aggregateFields(spec)) {
      if (!def.aggregatable.includes(field)) {
        throw new CrudError('FILTER_NOT_ALLOWED', `Campo '${field}' não é agregável`, field);
      }
    }
    return toLegacyShape(await this.repository.aggregate(def.delegate, spec, filter));
  }

  async getById(def: EntityDefinition, id: unknown, context: Ctx): Promise<Row> {
    await this.authorize(def, 'getById', context);
    const scopeId = this.scopeIdOf(def, context);
    const row = await this.findScoped(def, id, scopeId);
    return this.mask(def, row, this.isPublicResponse(def, 'getById'));
  }

  async create(def: EntityDefinition, body: unknown, context: Ctx): Promise<Row> {
    await this.authorize(def, 'create', context);
    const actor = this.actorOf(context);
    const scopeId = this.scopeIdOf(def, context);
    const data = this.pickWritable(def, body, 'create');
    if (def.scopeField && scopeId !== undefined) data[def.scopeField] = scopeId;

    return this.repository.transaction(async (repo) => {
      const patched = (await def.rules.hooks?.preWrite?.({ context, deps: this.hookDeps, op: 'create', data, scopeId, repository: repo })) || data;
      const result = await repo.create(def.delegate, patched);
      await this.writeAudit(def, repo, actor, 'create', result, undefined, patched, scopeId);
      await def.rules.hooks?.postWrite?.({ context, deps: this.hookDeps, op: 'create', result, scopeId, repository: repo });
      return this.mask(def, result);
    });
  }

  /** `GET /self`: o id é o do ator. Sem permissão — a autorização é a identidade. */
  async getSelf(def: EntityDefinition, context: Ctx): Promise<Row> {
    this.assertExposed(def, 'getSelf');
    const actor = this.actorOf(context);
    const row = await this.findScoped(def, this.selfId(def, actor), this.scopeIdOf(def, context));
    return this.mask(def, row);
  }

  /** `PUT /self`: allowlist ainda mais estreita (`selfRestricted`). */
  async updateSelf(def: EntityDefinition, body: unknown, context: Ctx): Promise<Row> {
    this.assertExposed(def, 'updateSelf');
    const actor = this.actorOf(context);
    return this.writeById(def, 'updateSelf', this.selfId(def, actor), context, () =>
      this.pickWritable(def, body, 'updateSelf'),
    );
  }

  async update(def: EntityDefinition, id: unknown, body: unknown, context: Ctx): Promise<Row> {
    return this.writeById(def, 'update', id, context, (existing) => {
      void existing;
      return this.pickWritable(def, body, 'update');
    });
  }

  async archive(def: EntityDefinition, id: unknown, context: Ctx): Promise<Row> {
    return this.writeById(def, 'archive', id, context, () => ({
      [this.softDeleteField(def)]: this.clock(),
    }));
  }

  async restore(def: EntityDefinition, id: unknown, context: Ctx): Promise<Row> {
    return this.writeById(def, 'restore', id, context, (existing) => {
      const field = this.softDeleteField(def);
      // Restaurar quem já está vivo é curadoria explícita, nunca no-op silencioso.
      if (existing[field] === null || existing[field] === undefined) {
        throw new CrudError('CONFLICT', `${def.rules.entity} não está arquivado`);
      }
      return { [field]: null };
    });
  }

  async upsert(def: EntityDefinition, body: unknown, context: Ctx): Promise<Row> {
    await this.authorize(def, 'upsert', context);
    const actor = this.actorOf(context);
    const scopeId = this.scopeIdOf(def, context);
    const key = def.rules.upsertKey!;
    const data = this.pickWritable(def, body, 'create');

    const keyValue = data[key];
    if (keyValue === undefined || keyValue === null || keyValue === '') {
      throw new CrudError('VALIDATION_FAILED', `Campo '${key}' é obrigatório no upsert`, key);
    }
    if (def.scopeField && scopeId !== undefined) data[def.scopeField] = scopeId;

    const filter = and([eq([key], keyValue), this.scopeFilter(def, scopeId)].filter(Boolean) as FilterNode[])!;

    return this.repository.transaction(async (repo) => {
      const existing = await repo.findOne(def.delegate, filter);
      const patched =
        (await def.rules.hooks?.preWrite?.({
          context,
          deps: this.hookDeps,
          op: 'upsert',
          data,
          ...(existing ? { existing } : {}),
          scopeId,
          repository: repo,
        })) || data;
      const result = await repo.upsert(def.delegate, { filter, data: patched });
      await this.writeAudit(
        def,
        repo,
        actor,
        existing ? 'update' : 'create',
        result,
        existing ?? undefined,
        patched,
        scopeId,
      );
      await def.rules.hooks?.postWrite?.({
        context,
        deps: this.hookDeps,
        op: 'upsert',
        result,
        ...(existing ? { existing } : {}),
        scopeId,
        repository: repo,
      });
      return this.mask(def, result);
    });
  }

  // ── internos ─────────────────────────────────────────────────────────────

  private async writeById(
    def: EntityDefinition,
    op: Extract<WriteOp, 'update' | 'updateSelf' | 'archive' | 'restore'>,
    id: unknown,
    context: Ctx,
    buildData: (existing: Row) => Row,
  ): Promise<Row> {
    if (op !== 'updateSelf') await this.authorize(def, op, context);
    const actor = this.actorOf(context);
    const scopeId = this.scopeIdOf(def, context);
    const existing = await this.findScoped(def, id, scopeId);
    const data = buildData(existing);
    const filter = this.byIdFilter(def, existing[def.idField], scopeId);

    return this.repository.transaction(async (repo) => {
      const patched =
        (await def.rules.hooks?.preWrite?.({ context, deps: this.hookDeps, op, data, existing, scopeId, repository: repo })) || data;
      const result = await repo.update(def.delegate, { filter, data: patched });
      await this.writeAudit(def, repo, actor, op, result, existing, patched, scopeId);
      await def.rules.hooks?.postWrite?.({ context, deps: this.hookDeps, op, result, existing, scopeId, repository: repo });
      return this.mask(def, result);
    });
  }

  /** Toda busca por id passa por aqui — o escopo nunca é opcional. */
  private async findScoped(def: EntityDefinition, id: unknown, scopeId: unknown): Promise<Row> {
    const row = await this.repository.findOne(def.delegate, this.byIdFilter(def, coerceId(id, def.idFieldType), scopeId));
    if (!row) {
      throw new CrudError('NOT_FOUND', `${def.rules.entity} não encontrado`);
    }
    return row;
  }

  private byIdFilter(def: EntityDefinition, id: unknown, scopeId: unknown): FilterNode {
    // Escopo pela própria pk (tenant = a empresa; aluno = o próprio trainee):
    // id diferente do escopo não pode existir; igual dispensa a condição dupla.
    if (def.scopeField === def.idField && scopeId !== undefined) {
      if (String(id) !== String(scopeId)) {
        throw new CrudError('NOT_FOUND', `${def.rules.entity} não encontrado`);
      }
      return eq([def.idField], id);
    }
    return and([eq([def.idField], id), this.scopeFilter(def, scopeId)].filter(Boolean) as FilterNode[])!;
  }

  private scopeFilter(def: EntityDefinition, scopeId: unknown): FilterNode | undefined {
    if (!def.scopeField || scopeId === undefined) return undefined;
    return eq([def.scopeField], scopeId);
  }

  /** Eixo vivo/inativo do contrato herdado: `active=true|false`. */
  private activeFilter(def: EntityDefinition, active: string | undefined): FilterNode | undefined {
    if (active === undefined || !def.softDeleteField) return undefined;
    if (active === 'true') return { kind: 'cmp', path: [def.softDeleteField], operator: 'isNull', value: null };
    if (active === 'false') return { kind: 'cmp', path: [def.softDeleteField], operator: 'ne', value: null };
    throw new CrudError('VALIDATION_FAILED', "Campo 'active' deve ser true|false", 'active');
  }

  /** `startedAt`/`endedAt` do contrato herdado: intervalo em `createdAt`. */
  private createdAtFilter(
    query: Record<string, string | string[] | undefined>,
  ): FilterNode | undefined {
    const nodes: FilterNode[] = [];
    const bound = (raw: unknown, operator: 'gte' | 'lte'): void => {
      if (typeof raw !== 'string' || raw === '') return;
      const value = new Date(raw);
      if (Number.isNaN(value.getTime())) {
        throw new CrudError('VALIDATION_FAILED', `Data inválida em '${operator === 'gte' ? 'startedAt' : 'endedAt'}'`);
      }
      nodes.push({ kind: 'cmp', path: ['createdAt'], operator, value });
    };
    bound(query.startedAt, 'gte');
    bound(query.endedAt, 'lte');
    return and(nodes);
  }

  private includeOf(
    def: EntityDefinition,
    show: string | string[] | undefined,
  ): Record<string, unknown> | undefined {
    if (show === undefined) return undefined;
    const names = (Array.isArray(show) ? show : show.replace(/[[\]]/g, '').split(','))
      .map((name) => name.trim())
      .filter(Boolean);
    if (!names.length) return undefined;

    const include: Record<string, unknown> = {};
    for (const name of names) {
      if (!def.includable.includes(name)) {
        throw new CrudError('FILTER_NOT_ALLOWED', `Relação '${name}' não é includável`, name);
      }
      include[name] = def.rules.includes?.[name] ?? true;
    }
    return include;
  }

  private assertExposed(def: EntityDefinition, op: ExposedOp): void {
    if (!def.rules.expose.includes(op)) {
      throw new CrudError('NOT_FOUND', `Operação '${op}' não existe em ${def.rules.entity}`);
    }
  }

  /** O id "self" é o do ator, convertido para o tipo da pk quando numérica. */
  private selfId(def: EntityDefinition, actor: Actor): unknown {
    const numeric = Number(actor.id);
    return def.idFieldType === 'number' && Number.isFinite(numeric) ? numeric : actor.id;
  }

  private async authorize(def: EntityDefinition, op: ExposedOp, context: Ctx): Promise<void> {
    this.assertExposed(def, op);
    // Op pública: sem ator e sem permissão. Só list/getById chegam aqui assim
    // (validado no boot).
    if (INHERENTLY_PUBLIC_OPS.has(op) || (def.rules.publicOps as ExposedOp[] | undefined)?.includes(op)) return;
    const actor = this.actorOf(context);
    if (def.rules.authenticatedOps?.includes(op)) return;
    const permission = def.permissions[op]!;
    if (!(await this.permissions.has(actor, permission))) {
      throw new CrudError('FORBIDDEN', `Permissão '${permission}' exigida`);
    }
  }

  /** `QueryParseError` do parser puro vira erro de request com o campo apontado. */
  private asCrudError(error: unknown): unknown {
    if (!(error instanceof QueryParseError)) return error;
    const code = error.reason === 'not_allowed' ? 'FILTER_NOT_ALLOWED' : 'VALIDATION_FAILED';
    return new CrudError(code, error.message, error.field);
  }

  private actorOf(context: Ctx): Actor {
    const actor = this.actorProvider?.resolve(context) ?? null;
    if (!actor) {
      // Nunca há ator default. O `userId = 0` silencioso é a origem do
      // "evento do sistema" que a auditoria do legado nunca soube explicar.
      throw new CrudError('UNAUTHENTICATED', 'Requisição sem ator identificado');
    }
    return actor;
  }

  private scopeIdOf(def: EntityDefinition, context: Ctx): unknown {
    const resolver = (def.rules.scope as ScopeResolver<Ctx> | undefined) ?? this.scope;
    if (!def.scopeField || !resolver) return undefined;
    return resolver.resolve(context);
  }

  private softDeleteField(def: EntityDefinition): string {
    if (!def.softDeleteField) {
      throw new CrudError('CONFLICT', `${def.rules.entity} não tem coluna de arquivamento`);
    }
    return def.softDeleteField;
  }

  /**
   * Allowlist de gravação. Campo conhecido porém restrito na operação vira 400
   * com o campo apontado; campo desconhecido é ignorado. Descartar campo
   * restrito em silêncio esconderia tentativas de escalada de privilégio.
   */
  private pickWritable(
    def: EntityDefinition,
    body: unknown,
    op: 'create' | 'update' | 'updateSelf',
  ): Row {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new CrudError('VALIDATION_FAILED', 'O corpo da requisição deve ser um objeto');
    }
    const sets = {
      create: [def.writableFields, def.restrictedCreateFields],
      update: [def.updatableFields, def.restrictedUpdateFields],
      updateSelf: [def.selfUpdatableFields, def.restrictedSelfFields],
    } as const;
    const [allowed, restricted] = sets[op];

    const data: Row = {};
    for (const [key, value] of Object.entries(body as Row)) {
      if (allowed.has(key)) {
        data[key] = value;
      } else if (restricted.has(key)) {
        if (op !== 'updateSelf' && def.restrictedWrite === 'ignore') continue;
        throw new CrudError('VALIDATION_FAILED', `Campo '${key}' não é gravável`, key);
      }
    }
    return coerceRow(data, def.fieldTypes);
  }

  private mask(def: EntityDefinition, row: Row, publicResponse = false): Row {
    const masked = [
      ...(def.rules.maskedFields ?? []),
      ...(publicResponse ? def.rules.publicMaskedFields ?? [] : []),
    ];
    if (!masked.length) return row;
    const copy = { ...row };
    for (const field of masked) delete copy[field];
    return copy;
  }

  private isPublicResponse(def: EntityDefinition, op: ExposedOp): boolean {
    return INHERENTLY_PUBLIC_OPS.has(op) || Boolean((def.rules.publicOps as ExposedOp[] | undefined)?.includes(op));
  }

  private async writeAudit(
    def: EntityDefinition,
    repository: Repository,
    actor: Actor,
    action: string,
    result: Row,
    existing: Row | undefined,
    data: Row,
    scopeId: unknown,
  ): Promise<void> {
    if (this.audit === noopAuditSink) return;
    const masked = new Set(def.rules.maskedFields ?? []);
    const occurredAt = this.clock();
    const entityId = serialize(result[def.idField]) ?? '<unknown>';

    const entries: AuditEntry[] = [];
    for (const column of Object.keys(data)) {
      const oldValue = existing ? serialize(existing[column]) : null;
      const newValue = serialize(result[column]);
      if (oldValue === newValue) continue;
      entries.push({
        actor,
        action,
        entity: def.rules.entity,
        entityId,
        column,
        oldValue: masked.has(column) && oldValue !== null ? MASK : oldValue,
        newValue: masked.has(column) && newValue !== null ? MASK : newValue,
        scopeId,
        ...(actor.requestId ? { requestId: actor.requestId } : {}),
        ...(actor.ip ? { ip: actor.ip } : {}),
        occurredAt,
      });
    }
    if (entries.length) {
      void repository;
      await this.audit.write(entries);
    }
  }
}
