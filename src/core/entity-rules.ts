import { FilterableField } from '../query/parser';
import { DEFAULT_RESERVED_KEYS } from '../query/parser';
import { FieldMeta, ModelMeta, ScalarType, SchemaProvider } from '../ports/schema-provider';
import { ScopeResolver } from '../ports/scope-resolver';
import { BootError } from './boot-error';
import { EntityHooks } from './hooks';

/** Lista fechada de operações. Não há `delete`: inativação é `archive`. */
export const EXPOSABLE_OPS = [
  'list',
  'getById',
  'create',
  'update',
  'archive',
  'restore',
  'upsert',
  'getSelf',
  'updateSelf',
  'listPublic',
] as const;

export type ExposedOp = (typeof EXPOSABLE_OPS)[number];
export type WriteOp = Exclude<ExposedOp, 'list' | 'getById' | 'getSelf' | 'listPublic'>;

/**
 * Ops de "self": o id vem do ator, não da URL, e a autorização É a
 * identidade — por isso são as únicas ops que dispensam permissão declarada.
 */
export const SELF_OPS: ReadonlySet<ExposedOp> = new Set(['getSelf', 'updateSelf']);

/**
 * `listPublic` (`GET /public`): listagem aberta que convive com a `list`
 * autenticada da mesma entidade — vitrine do site ao lado do admin. Sempre
 * pública, sempre só registros vivos; dispensa e recusa permissão.
 */
export const INHERENTLY_PUBLIC_OPS: ReadonlySet<ExposedOp> = new Set(['listPublic']);

export interface SoftDelete {
  /** Coluna de data de inativação: `inactiveAt`, `archivedAt`, `deletedAt`… */
  field: string;
}

export interface EntityRules {
  /** Segmento de rota: `customer` → `/customer`. */
  entity: string;
  /** Nome do model no schema (vocabulário do SchemaProvider). */
  model: string;
  expose: ExposedOp[];
  /** Obrigatória para toda op exposta. `restore` reusa a do `archive`. */
  permissions: Partial<Record<ExposedOp, string>>;
  /** Allowlist de filtro. Aceita caminho de relação declarado (`trainee.name`). */
  filterable: string[];
  sortable: string[];
  /**
   * Com `autoWhitelist` ligado nas opções, desliga a liberação automática de
   * campos escalares para ESTA entidade: só vale o que está em
   * filterable/sortable.
   */
  strictWhitelist?: boolean;
  /** Omitidos da resposta e mascarados na auditoria. Não podem ser filtráveis. */
  maskedFields?: string[];
  /** Obrigatório se `upsert` ∈ expose. Precisa ser unique/id no schema. */
  upsertKey?: string;
  softDelete?: SoftDelete;
  /**
   * `'archive'` (default): restore reusa a permissão do archive e declarar
   * `permissions.restore` é BootError. `'own'`: o projeto tem permissões
   * separadas (ex.: `activate_x` e `inactive_x`) e então
   * `permissions.restore` passa a ser OBRIGATÓRIA. Nunca há override
   * silencioso: ou a permissão é derivada, ou é exigida.
   */
  restorePermission?: 'archive' | 'own';
  /** Libera `status`/`statusId` no update (restritos por padrão). */
  statusUpdatable?: boolean;
  /** Restrições extras de gravação, além das derivadas do schema. */
  neverWritable?: string[];
  /**
   * Campos que o próprio usuário NÃO pode alterar em `updateSelf`, além dos
   * já restritos no update (ex.: `profileId`, `isSeller`). Obrigatório
   * declarar quando `updateSelf` ∈ expose — mesmo que vazio — para a decisão
   * ser explícita: foi um `PUT /user/self` aceitando `profileId` que virava
   * qualquer usuário em admin.
   */
  selfRestricted?: string[];
  /**
   * Ops de leitura abertas sem autenticação (vitrine do site, tabelas de
   * domínio). Só `list`/`getById`; escrita pública não existe. Sem ator, o
   * escopo vem do que o ScopeResolver conseguir resolver do request (ex.:
   * `?companyId=`), ou nenhum.
   */
  publicOps?: Array<'list' | 'getById'>;
  /**
   * Ops que exigem ator autenticado mas NENHUMA permissão (ex.: galeria de
   * imagens acessível a qualquer usuário logado). Terceiro modo, explícito,
   * entre público e permissionado; permissão declarada para elas é BootError.
   */
  authenticatedOps?: ExposedOp[];
  /**
   * Campos ocultados SÓ nas respostas públicas (listPublic/publicOps). Para
   * ocultar em toda resposta use `maskedFields`.
   */
  publicMaskedFields?: string[];
  /** Teto de `limit` na listagem. Default do parser: 100. */
  maxLimit?: number;
  /**
   * Sobrescreve a coluna de escopo do projeto. Caso típico: a entidade do
   * próprio tenant, cujo escopo é a PK (`scopeField: 'id'`) — cada empresa só
   * lê e edita a si mesma.
   */
  scopeField?: string;
  /**
   * Resolver de escopo PRÓPRIO desta entidade, substituindo o do projeto.
   * Caso típico: entidades do aluno, escopadas por `traineeId` do token do
   * aluno em vez de `companyId` do usuário. `field` do resolver vira o
   * scopeField.
   */
  scope?: ScopeResolver<never>;
  /** Relações que o cliente pode pedir via `?show=`. Fora daqui = 400. */
  includable?: string[];
  /**
   * Campos que podem ser agrupados/somados via `?-aggregate=`. Sem allowlist
   * própria, agregação viraria porta para somar qualquer coluna da tabela.
   */
  aggregatable?: string[];
  /**
   * Configuração por relação repassada ao adapter (select/include aninhado).
   * Declarada na entidade — o cliente escolhe o NOME, nunca a forma.
   */
  includes?: Record<string, unknown>;
  hooks?: EntityHooks;
}

export interface FieldType {
  type: ScalarType;
  nullable: boolean;
  isList?: boolean;
  enumValues?: readonly string[];
}

export interface DefineEntityOptions {
  schema: SchemaProvider;
  /** Teto de `limit` para todas as entidades (a entidade pode sobrescrever). */
  maxLimit?: number;
  /** Coluna de escopo multi-tenant (`companyId`, `tenantId`). Ausente = single-tenant. */
  scopeField?: string;
  /** Chaves de query tratadas acima do parser. */
  reservedKeys?: string[];
  /**
   * Libera filtro e ordenação em TODO campo escalar do model, além do que a
   * entidade declara. Ficam de fora: campos mascarados (maskedFields e
   * publicMaskedFields, para não permitir sondagem), listas, JSON e chaves
   * reservadas (estas só no filtro). Relações continuam exigindo declaração
   * explícita (`trainee.name`). Uma entidade sai disso com `strictWhitelist`.
   *
   * Útil ao migrar um sistema cujo front já filtra/ordena por campos livres:
   * a allowlist escrita à mão quebra a tela que usa um campo esquecido.
   */
  autoWhitelist?: boolean;
  /**
   * O que fazer com campo NÃO gravável (pk, escopo, neverWritable) no corpo de
   * create/update: 'reject' (padrão) responde 400 apontando o campo;
   * 'ignore' descarta o campo e grava o resto. Em `updateSelf` é SEMPRE
   * 'reject' — ali o 400 denuncia tentativa de escalada de privilégio.
   *
   * 'ignore' serve a front que reenvia o objeto inteiro (`id`, `active`,
   * `createdAt`) num formulário de edição: o campo nunca é gravado de um jeito
   * ou de outro; recusar só quebra a tela.
   */
  restrictedWrite?: 'reject' | 'ignore';
}

export interface EntityDefinition {
  rules: EntityRules;
  /** Nome do delegate no ORM — camelCase do model. */
  delegate: string;
  idField: string;
  idFieldType: 'string' | 'number';
  /**
   * Tipo de cada coluna escalar — usado para converter o corpo da requisição.
   * multipart/form-data entrega tudo como string ("1", "true", ""); sem isto
   * o ORM recusa o valor.
   */
  fieldTypes: Readonly<Record<string, FieldType>>;
  /** O model tem a coluna de escopo → filtro por tenant é automático. */
  scoped: boolean;
  scopeField?: string;
  softDeleteField?: string;
  writableFields: ReadonlySet<string>;
  updatableFields: ReadonlySet<string>;
  /** Campos que EXISTEM mas são restritos: presentes no body → 400 com `field`. */
  restrictedCreateFields: ReadonlySet<string>;
  restrictedUpdateFields: ReadonlySet<string>;
  selfUpdatableFields: ReadonlySet<string>;
  restrictedSelfFields: ReadonlySet<string>;
  /** Allowlist de filtro já resolvida com tipo e cardinalidade. */
  filterable: Record<string, FilterableField>;
  sortable: string[];
  includable: string[];
  aggregatable: string[];
  reservedKeys: string[];
  maxLimit?: number;
  restrictedWrite: 'reject' | 'ignore';
  permissions: Partial<Record<ExposedOp, string>>;
}

const ROUTE_SEGMENT = /^[a-z][a-z0-9-_]*$/;
const STATUS_FIELDS = ['status', 'statusId'];

function must<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new BootError(message);
  return value;
}

function delegateOf(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1);
}

/**
 * Resolve um caminho da allowlist (`name` ou `trainee.name`) contra o schema.
 * Caminho inválido é BootError — o cliente nunca escolhe relação, ele usa uma
 * que a entidade declarou e que foi verificada na subida.
 */
function resolvePath(
  path: string,
  model: ModelMeta,
  schema: SchemaProvider,
  entity: string,
): FilterableField {
  const parts = path.split('.');
  if (parts.length === 1) {
    const field = must(
      model.fields.find((candidate) => candidate.name === path),
      `defineEntity(${entity}): campo '${path}' não existe em ${model.name}`,
    );
    return { type: field.type, nullable: field.nullable };
  }
  if (parts.length > 2) {
    throw new BootError(
      `defineEntity(${entity}): '${path}' tem mais de um nível de relação (não suportado)`,
    );
  }
  const [relationName, fieldName] = parts as [string, string];
  const relation = must(
    model.relations.find((candidate) => candidate.name === relationName),
    `defineEntity(${entity}): relação '${relationName}' não existe em ${model.name}`,
  );
  const target = must(
    schema.model(relation.target),
    `defineEntity(${entity}): model '${relation.target}' (relação '${relationName}') não existe`,
  );
  const field = must(
    target.fields.find((candidate) => candidate.name === fieldName),
    `defineEntity(${entity}): campo '${fieldName}' não existe em ${target.name}`,
  );
  return {
    type: field.type,
    nullable: field.nullable,
    relation: { path: [relationName], toMany: relation.toMany },
  };
}

function validateRoute(rules: EntityRules): void {
  if (!ROUTE_SEGMENT.test(rules.entity ?? '')) {
    throw new BootError(`defineEntity: entity '${rules.entity}' não é um segmento de rota válido`);
  }
}

/**
 * `restore` NUNCA tem permissão própria: reusa sempre a do `archive`. Declarar
 * `permissions.restore` é BootError, mesmo com o valor idêntico — override
 * silencioso é a classe de bug que este núcleo existe para eliminar.
 */
function derivePermissions(rules: EntityRules): Partial<Record<ExposedOp, string>> {
  const permissions = { ...rules.permissions };
  if (!rules.expose.includes('restore')) return permissions;

  if (rules.restorePermission === 'own') {
    if (!rules.permissions.restore) {
      throw new BootError(
        `defineEntity(${rules.entity}): restorePermission 'own' exige 'permissions.restore' declarada`,
      );
    }
    return permissions;
  }
  if (rules.permissions.restore !== undefined) {
    throw new BootError(
      `defineEntity(${rules.entity}): 'permissions.restore' não pode ser declarada sem restorePermission 'own'`,
    );
  }
  if (!rules.expose.includes('archive') || !rules.permissions.archive) {
    throw new BootError(
      `defineEntity(${rules.entity}): 'restore' exige 'archive' exposto com permissão declarada`,
    );
  }
  if (!rules.softDelete) {
    throw new BootError(
      `defineEntity(${rules.entity}): 'restore' exige softDelete declarado`,
    );
  }
  permissions.restore = rules.permissions.archive;
  return permissions;
}

function validateExpose(rules: EntityRules, permissions: Partial<Record<ExposedOp, string>>): void {
  if (!rules.expose.length) {
    throw new BootError(`defineEntity(${rules.entity}): expose vazio`);
  }
  for (const op of rules.authenticatedOps ?? []) {
    if (!rules.expose.includes(op)) {
      throw new BootError(`defineEntity(${rules.entity}): op autenticada '${op}' não está no expose`);
    }
    if (rules.publicOps?.includes(op as never)) {
      throw new BootError(`defineEntity(${rules.entity}): op '${op}' não pode ser pública e autenticada`);
    }
  }
  for (const op of rules.publicOps ?? []) {
    if (op !== 'list' && op !== 'getById') {
      throw new BootError(`defineEntity(${rules.entity}): op '${op}' não pode ser pública`);
    }
    if (!rules.expose.includes(op)) {
      throw new BootError(`defineEntity(${rules.entity}): op pública '${op}' não está no expose`);
    }
  }
  for (const op of rules.expose) {
    if (!EXPOSABLE_OPS.includes(op)) {
      throw new BootError(`defineEntity(${rules.entity}): op '${op}' fora da lista fechada`);
    }
    const permission = permissions[op];
    // Op pública (declarada ou inerente), de self ou só-autenticada: permissão
    // declarada seria letra morta e daria falsa sensação de proteção → erro.
    if (
      SELF_OPS.has(op) ||
      INHERENTLY_PUBLIC_OPS.has(op) ||
      rules.authenticatedOps?.includes(op) ||
      (rules.publicOps as ExposedOp[] | undefined)?.includes(op)
    ) {
      if (permission !== undefined) {
        throw new BootError(
          `defineEntity(${rules.entity}): op '${op}' não aceita permissão declarada`,
        );
      }
      continue;
    }
    if (typeof permission !== 'string' || permission.trim() === '') {
      throw new BootError(
        `defineEntity(${rules.entity}): op exposta '${op}' sem permissão declarada`,
      );
    }
  }
  if (rules.expose.includes('updateSelf') && rules.selfRestricted === undefined) {
    throw new BootError(
      `defineEntity(${rules.entity}): 'updateSelf' exige 'selfRestricted' declarado (pode ser [])`,
    );
  }
  if (rules.selfRestricted !== undefined && !rules.expose.includes('updateSelf')) {
    throw new BootError(
      `defineEntity(${rules.entity}): 'selfRestricted' declarado sem 'updateSelf' no expose`,
    );
  }
  if ((rules.expose.includes('archive') || rules.expose.includes('restore')) && !rules.softDelete) {
    throw new BootError(
      `defineEntity(${rules.entity}): 'archive'/'restore' exigem softDelete declarado`,
    );
  }
}

function validateUpsert(rules: EntityRules, model: ModelMeta): void {
  if (!rules.expose.includes('upsert')) {
    if (rules.upsertKey) {
      throw new BootError(
        `defineEntity(${rules.entity}): upsertKey declarada sem 'upsert' no expose`,
      );
    }
    return;
  }
  const key = must(
    rules.upsertKey,
    `defineEntity(${rules.entity}): 'upsert' exposto sem upsertKey — upsert sem chave natural casa o primeiro registro da tabela`,
  );
  const field = model.fields.find((candidate) => candidate.name === key);
  const unique =
    (field && (field.isId || field.isUnique)) ||
    model.uniques.some((set) => set.length === 1 && set[0] === key);
  if (!unique) {
    throw new BootError(
      `defineEntity(${rules.entity}): upsertKey '${key}' não tem constraint unique em ${model.name}`,
    );
  }
}

function deriveWritable(
  rules: EntityRules,
  model: ModelMeta,
  scopeField: string | undefined,
  idField: string,
): Pick<
  EntityDefinition,
  | 'writableFields'
  | 'updatableFields'
  | 'restrictedCreateFields'
  | 'restrictedUpdateFields'
  | 'selfUpdatableFields'
  | 'restrictedSelfFields'
> {
  const names = new Set(model.fields.map((field) => field.name));
  const never = new Set<string>(rules.neverWritable ?? []);
  if (scopeField) never.add(scopeField);
  if (rules.softDelete) never.add(rules.softDelete.field);

  const isWritable = (field: FieldMeta): boolean =>
    !field.isGenerated && !never.has(field.name);

  const writableFields = new Set(model.fields.filter(isWritable).map((field) => field.name));

  const updatableFields = new Set(writableFields);
  updatableFields.delete(idField);
  if (!rules.statusUpdatable) {
    for (const status of STATUS_FIELDS) updatableFields.delete(status);
  }

  // Restrito = existe no schema mas não é gravável nesta op. Presente no body
  // vira 400 com o campo apontado, nunca descarte silencioso — descarte
  // silencioso é o jeito clássico de esconder um mass assignment.
  const restrictedCreateFields = new Set<string>();
  for (const name of never) if (names.has(name)) restrictedCreateFields.add(name);

  const restrictedUpdateFields = new Set(restrictedCreateFields);
  restrictedUpdateFields.add(idField);
  if (!rules.statusUpdatable) {
    for (const status of STATUS_FIELDS) if (names.has(status)) restrictedUpdateFields.add(status);
  }

  const selfUpdatableFields = new Set(updatableFields);
  const restrictedSelfFields = new Set(restrictedUpdateFields);
  for (const field of rules.selfRestricted ?? []) {
    if (!names.has(field)) {
      throw new BootError(
        `defineEntity(${rules.entity}): campo '${field}' de selfRestricted não existe no model`,
      );
    }
    selfUpdatableFields.delete(field);
    restrictedSelfFields.add(field);
  }

  return {
    writableFields,
    updatableFields,
    restrictedCreateFields,
    restrictedUpdateFields,
    selfUpdatableFields,
    restrictedSelfFields,
  };
}

function validateWhitelists(
  rules: EntityRules,
  model: ModelMeta,
  schema: SchemaProvider,
  reservedKeys: string[],
): { filterable: Record<string, FilterableField> } {
  const masked = new Set(rules.maskedFields ?? []);
  const filterable: Record<string, FilterableField> = {};

  for (const path of rules.filterable) {
    // Campo filtrável que colide com chave reservada nunca chegaria ao parser —
    // seria ignorado em silêncio. Declaração ambígua é erro de boot.
    if (reservedKeys.includes(path)) {
      throw new BootError(
        `defineEntity(${rules.entity}): '${path}' é chave reservada e não pode ser declarada filtrável`,
      );
    }
    // Filtrar por campo mascarado permite descobrir o valor por sondagem.
    if (masked.has(path)) {
      throw new BootError(
        `defineEntity(${rules.entity}): '${path}' é mascarado e não pode ser filtrável`,
      );
    }
    if (model.fields.find((f) => f.name === path)?.isList) {
      throw new BootError(`defineEntity(${rules.entity}): '${path}' é lista — filtro sobre lista não é suportado`);
    }
    filterable[path] = resolvePath(path, model, schema, rules.entity);
  }

  for (const path of rules.sortable) {
    if (masked.has(path)) {
      throw new BootError(
        `defineEntity(${rules.entity}): '${path}' é mascarado e não pode ser ordenável`,
      );
    }
    resolvePath(path, model, schema, rules.entity);
  }

  for (const field of rules.aggregatable ?? []) {
    if (masked.has(field)) {
      throw new BootError(
        `defineEntity(${rules.entity}): '${field}' é mascarado e não pode ser agregável`,
      );
    }
    must(
      model.fields.find((candidate) => candidate.name === field),
      `defineEntity(${rules.entity}): campo agregável '${field}' não existe em ${model.name}`,
    );
  }

  for (const relation of rules.includable ?? []) {
    // `_count` é pseudo-relação de contagem (Prisma) — aceita por nome.
    if (relation === '_count') continue;
    must(
      model.relations.find((candidate) => candidate.name === relation),
      `defineEntity(${rules.entity}): relação includável '${relation}' não existe em ${model.name}`,
    );
  }

  for (const field of rules.publicMaskedFields ?? []) {
    must(
      model.fields.find((candidate) => candidate.name === field),
      `defineEntity(${rules.entity}): campo publicMasked '${field}' não existe em ${model.name}`,
    );
  }

  for (const field of rules.maskedFields ?? []) {
    must(
      model.fields.find((candidate) => candidate.name === field),
      `defineEntity(${rules.entity}): campo mascarado '${field}' não existe em ${model.name}`,
    );
  }

  return { filterable };
}

/**
 * Valida a declaração da entidade contra o schema e devolve a definição
 * compilada. Qualquer inconsistência é `BootError` — a aplicação não sobe.
 */
export function defineEntity(rules: EntityRules, options: DefineEntityOptions): EntityDefinition {
  validateRoute(rules);
  const model = must(
    options.schema.model(rules.model),
    `defineEntity(${rules.entity}): model '${rules.model}' não existe no schema`,
  );
  const reservedKeys = options.reservedKeys ?? DEFAULT_RESERVED_KEYS;

  const permissions = derivePermissions(rules);
  validateExpose(rules, permissions);
  validateUpsert(rules, model);

  if (rules.softDelete && !model.fields.some((f) => f.name === rules.softDelete!.field)) {
    throw new BootError(
      `defineEntity(${rules.entity}): coluna de softDelete '${rules.softDelete.field}' não existe em ${model.name}`,
    );
  }

  const idField = must(
    model.idField,
    `defineEntity(${rules.entity}): model '${rules.model}' tem pk composta — os generics precisam de um campo único para a rota /:id`,
  );

  const { filterable } = validateWhitelists(rules, model, options.schema, reservedKeys);
  const sortable = [...rules.sortable];
  if (options.autoWhitelist && !rules.strictWhitelist) {
    const hidden = new Set([...(rules.maskedFields ?? []), ...(rules.publicMaskedFields ?? [])]);
    for (const field of model.fields) {
      if (field.isList || field.type === 'json' || hidden.has(field.name)) continue;
      if (!(field.name in filterable) && !reservedKeys.includes(field.name)) {
        filterable[field.name] = resolvePath(field.name, model, options.schema, rules.entity);
      }
      if (!sortable.includes(field.name)) sortable.push(field.name);
    }
  }
  const scopeField = rules.scope?.field ?? rules.scopeField ?? options.scopeField;
  const scoped = scopeField !== undefined && model.fields.some((field) => field.name === scopeField);

  return {
    rules,
    permissions,
    delegate: delegateOf(rules.model),
    idField,
    idFieldType: model.fields.find((f) => f.name === idField)?.type === 'number' ? 'number' : 'string',
    fieldTypes: Object.fromEntries(
      model.fields.map((f) => [f.name, {
        type: f.type,
        nullable: f.nullable,
        ...(f.isList ? { isList: true } : {}),
        ...(f.enumValues ? { enumValues: f.enumValues } : {}),
      }]),
    ),
    scoped,
    ...(scoped ? { scopeField } : {}),
    ...(rules.softDelete ? { softDeleteField: rules.softDelete.field } : {}),
    filterable,
    sortable,
    includable: [...(rules.includable ?? [])],
    aggregatable: [...(rules.aggregatable ?? [])],
    reservedKeys: [...reservedKeys],
    restrictedWrite: options.restrictedWrite ?? 'reject',
    ...((rules.maxLimit ?? options.maxLimit) !== undefined ? { maxLimit: rules.maxLimit ?? options.maxLimit } : {}),
    ...deriveWritable(rules, model, scoped ? scopeField : undefined, idField),
  };
}
