import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Actor } from '../ports/actor-provider';
import { AuditEntry } from '../ports/audit-sink';
import { Row } from '../ports/repository';
import { fakeSchema } from '../testing/fake-schema';
import { memoryRepository } from '../testing/memory-repository';
import { CrudError } from './crud-error';
import { CrudService } from './crud-service';
import { EntityRules, defineEntity } from './entity-rules';

const schema = fakeSchema({
  Customer: {
    fields: {
      id: { type: 'number', isId: true, isGenerated: true },
      companyId: { type: 'number' },
      name: {},
      cnpj: { isUnique: true },
      secret: {},
      score: { type: 'number', nullable: true },
      createdAt: { type: 'date', isGenerated: true },
      inactiveAt: { type: 'date', nullable: true },
    },
    relations: { contacts: { target: 'Contact', toMany: true } },
  },
  Contact: { fields: { id: { type: 'number', isId: true }, phone: {} } },
});

const rules: EntityRules = {
  entity: 'customer',
  model: 'Customer',
  expose: ['list', 'getById', 'create', 'update', 'archive', 'restore', 'upsert'],
  permissions: {
    list: 'list_clientes',
    getById: 'list_clientes',
    create: 'create_clientes',
    update: 'update_clientes',
    archive: 'inactive_clientes',
    upsert: 'upsert_clientes',
  },
  upsertKey: 'cnpj',
  filterable: ['name', 'cnpj', 'createdAt'],
  sortable: ['name', 'createdAt'],
  maskedFields: ['secret'],
  includable: ['contacts'],
  aggregatable: ['name', 'companyId'],
  softDelete: { field: 'inactiveAt' },
};

const NOW = new Date('2026-08-30T12:00:00.000Z');

interface Ctx {
  companyId: number;
  actor: Actor | null;
}

const ALL = [
  'list_clientes',
  'create_clientes',
  'update_clientes',
  'inactive_clientes',
  'upsert_clientes',
];

const ctx = (companyId: number, permissions: string[] = ALL): Ctx => ({
  companyId,
  actor: { type: 'user', id: '7', permissions, requestId: 'req-1', ip: '10.0.0.1' },
});

const seed = (): Row[] => [
  { id: 1, companyId: 1, name: 'Alfa', cnpj: '111', secret: 's1', createdAt: new Date('2026-01-10'), inactiveAt: null },
  { id: 2, companyId: 1, name: 'Beta', cnpj: '222', secret: 's2', createdAt: new Date('2026-03-10'), inactiveAt: new Date('2026-04-01') },
  { id: 3, companyId: 2, name: 'Gama', cnpj: '333', secret: 's3', createdAt: new Date('2026-02-10'), inactiveAt: null },
];

let repo: ReturnType<typeof memoryRepository>;
let audit: AuditEntry[];
let def: ReturnType<typeof defineEntity>;

function build(overrides: Partial<EntityRules> = {}, options: { restrictedWrite?: 'reject' | 'ignore' } = {}) {
  def = defineEntity({ ...rules, ...overrides }, { schema, scopeField: 'companyId', ...options });
  repo = memoryRepository({ customer: seed() });
  audit = [];
  return new CrudService<Ctx>({
    repository: repo,
    scope: { field: 'companyId', resolve: (context) => context.companyId },
    actor: { resolve: (context) => context.actor },
    audit: { write: async (entries) => { audit.push(...entries); } },
    permissions: { has: (actor, permission) => Boolean(actor.permissions?.includes(permission)) },
    clock: () => NOW,
  });
}

beforeEach(() => { build(); });

describe('CrudService — escopo de tenant', () => {
  it('list só devolve linhas do escopo', async () => {
    const result = await build().list(def, {}, ctx(1));
    expect(result.rows.map((row) => row.id)).toEqual([2, 1]);
    expect(result.total).toBe(2);
  });

  // `where: { id }` sem a coluna de tenant seria IDOR entre tenants.
  it('getById de outro tenant é 404, não vazamento', async () => {
    const service = build();
    await expect(service.getById(def, 3, ctx(1))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('update de outro tenant é 404', async () => {
    const service = build();
    await expect(service.update(def, 3, { name: 'x' }, ctx(1))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(repo.rows('customer').find((row) => row.id === 3)!.name).toBe('Gama');
  });

  it('archive de outro tenant é 404', async () => {
    const service = build();
    await expect(service.archive(def, 3, ctx(1))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('create força o escopo do ator, ignorando o corpo', async () => {
    const service = build();
    const created = await service.create(def, { name: 'Novo', cnpj: '999' }, ctx(2));
    expect(created.companyId).toBe(2);
  });

  it('upsert é escopado: mesma chave em tenant diferente cria nova linha', async () => {
    const service = build();
    const result = await service.upsert(def, { cnpj: '111', name: 'Alfa Dois' }, ctx(2));
    expect(result.companyId).toBe(2);
    expect(repo.rows('customer').filter((row) => row.cnpj === '111')).toHaveLength(2);
  });
});

describe('CrudService — coerção de tipos (multipart)', () => {
  it('create com corpo todo string grava tipado', async () => {
    const service = build();
    const created = await service.create(def, { name: 'Novo', cnpj: '999', score: '2' }, ctx(1));
    expect(created.score).toBe(2);
  });

  it(':id string da URL encontra o registro', async () => {
    const service = build();
    expect((await service.getById(def, '1', ctx(1))).id).toBe(1);
    expect((await service.update(def, '1', { name: 'X' }, ctx(1))).name).toBe('X');
  });

  it(':id não numérico em pk numérica é 404', async () => {
    const service = build();
    await expect(service.getById(def, 'my-courses', ctx(1))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('CrudService — mass-assignment', () => {
  // Ex.: PUT /user/self não pode aceitar profileId nem companyId no corpo.
  it('campo restrito no corpo é 400 com o campo apontado', async () => {
    const service = build();
    await expect(service.update(def, 1, { name: 'x', companyId: 99 }, ctx(1))).rejects.toMatchObject(
      { code: 'VALIDATION_FAILED', field: 'companyId' },
    );
  });

  it('pk não é gravável no update', async () => {
    const service = build();
    await expect(service.update(def, 1, { id: 42 }, ctx(1))).rejects.toMatchObject({ field: 'id' });
  });

  it('campo desconhecido é ignorado, não é erro', async () => {
    const service = build();
    const updated = await service.update(def, 1, { name: 'Alfa2', inventado: true }, ctx(1));
    expect(updated.name).toBe('Alfa2');
    expect(updated.inventado).toBeUndefined();
  });

  it("restrictedWrite 'ignore': campo restrito é descartado e o resto é gravado", async () => {
    const service = build({}, { restrictedWrite: 'ignore' });
    const updated = await service.update(def, 1, { id: 42, companyId: 99, name: 'Alfa3' }, ctx(1));
    expect(updated.id).toBe(1);
    expect(updated.companyId).toBe(1);
    expect(updated.name).toBe('Alfa3');
  });

  it('corpo que não é objeto é 400', async () => {
    const service = build();
    await expect(service.create(def, [1, 2], ctx(1))).rejects.toBeInstanceOf(CrudError);
  });
});

describe('CrudService — autorização', () => {
  it('sem a permissão da op é 403', async () => {
    const service = build();
    await expect(service.update(def, 1, { name: 'x' }, ctx(1, ['list_clientes']))).rejects.toMatchObject(
      { code: 'FORBIDDEN' },
    );
  });

  // A trava não é o guard do framework: é o serviço. Consumidor sem a camada
  // NestJS continua protegido.
  it('op fora do expose é 404, mesmo com permissão', async () => {
    // upsertKey precisa cair junto: declará-la sem 'upsert' no expose é BootError.
    const service = build({
      expose: ['list'],
      permissions: { list: 'list_clientes' },
      upsertKey: undefined,
    });
    await expect(service.create(def, { name: 'x' }, ctx(1))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('sem ator identificado é 401, nunca ator default', async () => {
    const service = build();
    await expect(service.list(def, {}, { companyId: 1, actor: null })).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });

  it('o default do PermissionChecker nega tudo', async () => {
    const service = new CrudService<Ctx>({
      repository: memoryRepository({ customer: seed() }),
      actor: { resolve: (context) => context.actor },
    });
    await expect(service.list(def, {}, ctx(1))).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('CrudService — arquivamento', () => {
  it('archive grava a data e restore limpa', async () => {
    const service = build();
    const archived = await service.archive(def, 1, ctx(1));
    expect(archived.inactiveAt).toEqual(NOW);
    const restored = await service.restore(def, 1, ctx(1));
    expect(restored.inactiveAt).toBeNull();
  });

  it('restore de registro vivo é 409, nunca no-op silencioso', async () => {
    const service = build();
    await expect(service.restore(def, 1, ctx(1))).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('restore reusa a permissão do archive', async () => {
    const service = build();
    await service.archive(def, 1, ctx(1));
    await expect(service.restore(def, 1, ctx(1, ['inactive_clientes']))).resolves.toBeTruthy();
  });
});

describe('CrudService — contrato de listagem herdado', () => {
  it('active=true traz só os vivos e active=false só os inativos', async () => {
    const service = build();
    expect((await service.list(def, { active: 'true' }, ctx(1))).rows.map((r) => r.id)).toEqual([1]);
    expect((await service.list(def, { active: 'false' }, ctx(1))).rows.map((r) => r.id)).toEqual([2]);
  });

  it('active com valor inválido é 400', async () => {
    const service = build();
    await expect(service.list(def, { active: 'talvez' }, ctx(1))).rejects.toMatchObject({
      field: 'active',
    });
  });

  it('startedAt/endedAt filtram createdAt', async () => {
    const service = build();
    const result = await service.list(def, { startedAt: '2026-02-01', endedAt: '2026-12-31' }, ctx(1));
    expect(result.rows.map((row) => row.id)).toEqual([2]);
  });

  it('maxLimit da entidade sobrescreve o teto do parser', async () => {
    const service = build({ maxLimit: 1000 });
    expect((await service.list(def, { limit: '999' }, ctx(1))).limit).toBe(999);
    await expect(build().list(def, { limit: '999' }, ctx(1))).rejects.toMatchObject({ field: 'limit' });
  });

  it('limit=all desliga a paginação', async () => {
    const service = build();
    expect((await service.list(def, { limit: 'all' }, ctx(1))).limit).toBe('all');
  });

  it('show monta include só do que é declarado includável', async () => {
    const service = build();
    const spy = vi.spyOn(repo, 'findMany');
    await service.list(def, { show: '[contacts]' }, ctx(1));
    expect(spy.mock.calls[0]![1].include).toEqual({ contacts: true });
  });

  it('show com relação não declarada é 400', async () => {
    const service = build();
    await expect(service.list(def, { show: 'pedidos' }, ctx(1))).rejects.toMatchObject({
      code: 'FILTER_NOT_ALLOWED',
      field: 'pedidos',
    });
  });

  it('filtro fora da allowlist vira erro de request com o campo', async () => {
    const service = build();
    await expect(service.list(def, { secret: 'x' }, ctx(1))).rejects.toMatchObject({
      code: 'FILTER_NOT_ALLOWED',
      field: 'secret',
    });
  });

  it('ordenação padrão é pk desc', async () => {
    const service = build();
    expect((await service.list(def, {}, ctx(1))).rows.map((row) => row.id)).toEqual([2, 1]);
  });
});

describe('CrudService — agregações', () => {
  it('devolve o bloco no formato herdado, escopado ao tenant', async () => {
    const service = build();
    const result = await service.list(def, { '-aggregate': 'name:count' }, ctx(1));
    expect(result.aggregations).toEqual({ Alfa: { _count: 1 }, Beta: { _count: 1 } });
  });

  it('respeita os filtros da própria listagem', async () => {
    const service = build();
    const result = await service.list(def, { '-aggregate': 'name:count', active: 'true' }, ctx(1));
    expect(result.aggregations).toEqual({ Alfa: { _count: 1 } });
  });

  // Sem allowlist, agregação viraria porta para somar qualquer coluna.
  it('campo fora da allowlist de agregação é 400', async () => {
    const service = build();
    await expect(service.list(def, { '-aggregate': 'secret:count' }, ctx(1))).rejects.toMatchObject({
      code: 'FILTER_NOT_ALLOWED',
      field: 'secret',
    });
  });

  // Erro de agregação nunca pode virar resposta sem o bloco.
  it('sintaxe inválida é 400, nunca resposta sem o bloco', async () => {
    const service = build();
    await expect(service.list(def, { '-aggregate': 'name:mediana:x' }, ctx(1))).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      field: '-aggregate',
    });
  });

  it('sem -aggregate a chave nem aparece na resposta', async () => {
    const service = build();
    expect('aggregations' in (await service.list(def, {}, ctx(1)))).toBe(false);
  });
});

describe('CrudService — mascaramento e auditoria', () => {
  it('campo mascarado sai da resposta', async () => {
    const service = build();
    const row = await service.getById(def, 1, ctx(1));
    expect(row.secret).toBeUndefined();
    expect(row.name).toBe('Alfa');
  });

  it('auditoria grava uma linha por coluna alterada', async () => {
    const service = build();
    await service.update(def, 1, { name: 'Alfa2', cnpj: '111' }, ctx(1));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'update',
      entity: 'customer',
      entityId: '1',
      column: 'name',
      oldValue: 'Alfa',
      newValue: 'Alfa2',
      requestId: 'req-1',
      ip: '10.0.0.1',
      scopeId: 1,
      occurredAt: NOW,
    });
  });

  it('valor de campo mascarado nunca vai em claro para a auditoria', async () => {
    const service = build();
    await service.update(def, 1, { secret: 'novo' }, ctx(1));
    expect(audit[0]).toMatchObject({ column: 'secret', oldValue: '***', newValue: '***' });
  });

  it('create audita as colunas gravadas', async () => {
    const service = build();
    await service.create(def, { name: 'Novo', cnpj: '999' }, ctx(1));
    expect(audit.map((entry) => entry.column).sort()).toEqual(['cnpj', 'companyId', 'name']);
    expect(audit.every((entry) => entry.action === 'create' && entry.oldValue === null)).toBe(true);
  });

  it('archive audita a coluna de arquivamento', async () => {
    const service = build();
    await service.archive(def, 1, ctx(1));
    expect(audit[0]).toMatchObject({ action: 'archive', column: 'inactiveAt' });
  });
});

describe('CrudService — hooks', () => {
  it('preWrite pode substituir o data', async () => {
    const service = build({
      hooks: { preWrite: ({ data }) => ({ ...data, name: String(data.name).toUpperCase() }) },
    });
    const created = await service.create(def, { name: 'novo', cnpj: '999' }, ctx(1));
    expect(created.name).toBe('NOVO');
  });

  it('preWrite recebe o registro atual no update', async () => {
    const seen: Row[] = [];
    const service = build({
      hooks: { preWrite: ({ existing }) => { if (existing) seen.push(existing); } },
    });
    await service.update(def, 1, { name: 'x' }, ctx(1));
    expect(seen[0]).toMatchObject({ id: 1, name: 'Alfa' });
  });

  it('preList acrescenta filtro em AND', async () => {
    const service = build({
      hooks: { preList: () => ({ kind: 'cmp', path: ['name'], operator: 'eq', value: 'Alfa' }) },
    });
    expect((await service.list(def, {}, ctx(1))).rows.map((row) => row.id)).toEqual([1]);
  });

  it('postWrite roda depois da escrita e pode abortar', async () => {
    const service = build({
      hooks: { postWrite: () => { throw new Error('regra de negócio'); } },
    });
    await expect(service.create(def, { name: 'x', cnpj: '999' }, ctx(1))).rejects.toThrow('regra de negócio');
  });
});

describe('CrudService — self', () => {
  // ator id '1' → linha id 1 (companyId 1)
  const selfRules: Partial<EntityRules> = {
    expose: ['getSelf', 'updateSelf'],
    permissions: {},
    upsertKey: undefined,
    selfRestricted: ['cnpj'],
  };
  const noPerms = (companyId: number): Ctx => ({
    companyId,
    actor: { type: 'user', id: '1', permissions: [] },
  });

  it('getSelf devolve a própria linha sem exigir permissão', async () => {
    const service = build(selfRules);
    expect((await service.getSelf(def, noPerms(1))).id).toBe(1);
  });

  it('getSelf respeita o escopo: ator de outra empresa é 404', async () => {
    const service = build(selfRules);
    await expect(service.getSelf(def, noPerms(2))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('updateSelf grava campos permitidos', async () => {
    const service = build(selfRules);
    expect((await service.updateSelf(def, { name: 'Eu' }, noPerms(1))).name).toBe('Eu');
  });

  it("restrictedWrite 'ignore' não vale para updateSelf (escalada continua 400)", async () => {
    const service = build(selfRules, { restrictedWrite: 'ignore' });
    await expect(service.updateSelf(def, { name: 'x', cnpj: '999' }, noPerms(1))).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      field: 'cnpj',
    });
  });

  // Estrutural: campo em selfRestricted é 400 explícito.
  it('updateSelf rejeita campo de selfRestricted com o campo apontado', async () => {
    const service = build(selfRules);
    await expect(service.updateSelf(def, { cnpj: '999' }, noPerms(1))).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      field: 'cnpj',
    });
  });

  it('updateSelf também rejeita escopo e pk', async () => {
    const service = build(selfRules);
    await expect(service.updateSelf(def, { companyId: 2 }, noPerms(1))).rejects.toMatchObject({ field: 'companyId' });
  });

  it('self sem expose é 404', async () => {
    const service = build();
    await expect(service.getSelf(def, noPerms(1))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('CrudService — ops públicas', () => {
  const anon: Ctx = { companyId: 1, actor: null };

  const pub = (ops: Array<'list' | 'getById'>): Partial<EntityRules> => ({
    publicOps: ops,
    permissions: Object.fromEntries(Object.entries(rules.permissions).filter(([k]) => !ops.includes(k as never))),
  });

  it('list pública dispensa ator e permissão', async () => {
    const service = build(pub(['list']));
    expect((await service.list(def, {}, anon)).total).toBe(2);
  });

  it('getById pública', async () => {
    const service = build(pub(['list', 'getById']));
    expect((await service.getById(def, 1, anon)).id).toBe(1);
  });

  it('op não pública continua exigindo ator', async () => {
    const service = build(pub(['list']));
    await expect(service.getById(def, 1, anon)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('escrita nunca é pública (lei de boot)', () => {
    expect(() => build({ publicOps: ['create' as never] })).toThrow(/não pode ser pública/);
  });

  it('op pública precisa estar no expose', () => {
    expect(() => build({ expose: ['list'], permissions: {}, upsertKey: undefined, publicOps: ['getById'] }))
      .toThrow(/não está no expose/);
  });

  it('permissão declarada em op pública é BootError (letra morta)', () => {
    expect(() => build({ publicOps: ['list'] })).toThrow(/não aceita/);
  });
});

describe('CrudService — authenticatedOps e publicMaskedFields', () => {
  const noListPerm = { ...rules.permissions, list: undefined } as EntityRules['permissions'];

  it('op autenticada exige ator mas não permissão', async () => {
    const service = build({ authenticatedOps: ['list'], permissions: noListPerm });
    expect((await service.list(def, {}, ctx(1, []))).total).toBe(2);
    await expect(service.list(def, {}, { companyId: 1, actor: null })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('permissão declarada para op autenticada é BootError', () => {
    expect(() => build({ authenticatedOps: ['list'], permissions: noListPerm })).not.toThrow();
    // permissions.list segue declarada → conflito explícito
    expect(() => build({ authenticatedOps: ['list'] })).toThrow(/não aceita/);
  });

  it('publicMaskedFields some só na resposta pública', async () => {
    const service = build({
      expose: ['list', 'listPublic'], permissions: { list: 'list_clientes' }, upsertKey: undefined,
      publicMaskedFields: ['cnpj'],
    });
    const pub = await service.listPublic(def, {}, { companyId: 1, actor: null });
    expect(pub.rows[0]!.cnpj).toBeUndefined();
    const adm = await service.list(def, {}, ctx(1));
    expect(adm.rows[0]!.cnpj).toBeDefined();
    expect(adm.rows[0]!.secret).toBeUndefined(); // maskedFields vale sempre
  });
});

describe('CrudService — escopo próprio da entidade', () => {
  it('rules.scope substitui o resolver do projeto', async () => {
    const service = build({ scope: { field: 'id', resolve: (c: Ctx) => Number(c.actor?.id) } as never });
    // ator id '7' não existe → nada; com id '1' → só a linha 1, mesmo pedindo companyId 2
    expect((await service.list(def, {}, ctx(1))).total).toBe(0);
    const asOne: Ctx = { companyId: 2, actor: { type: 'user', id: '1', permissions: ALL } };
    expect((await service.list(def, {}, asOne)).rows.map((r) => r.id)).toEqual([1]);
  });
});

describe('CrudService — escopo pela própria pk', () => {
  const asTrainee = (id: string): Ctx => ({ companyId: 1, actor: { type: 'user', id, permissions: ALL } });
  const pkScope = { scope: { field: 'id', resolve: (c: Ctx) => Number(c.actor?.id) } as never };

  // fails-without: o filtro saía id=X AND id=X e o adapter Prisma recusava o
  // campo repetido no where único (500 no PUT /student/:id do próprio aluno).
  it('atualiza o próprio registro', async () => {
    const service = build(pkScope);
    expect((await service.update(def, '1', { name: 'Eu' }, asTrainee('1'))).name).toBe('Eu');
  });

  it('id de outro é 404, sem tocar o banco', async () => {
    const service = build(pkScope);
    await expect(service.update(def, '3', { name: 'x' }, asTrainee('1'))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('CrudService — listPublic', () => {
  const anon: Ctx = { companyId: 1, actor: null };
  const rules: Partial<EntityRules> = { expose: ['list', 'listPublic'], permissions: { list: 'l' }, upsertKey: undefined };

  it('convive com a list autenticada: pública só traz vivos', async () => {
    const service = build(rules);
    expect((await service.listPublic(def, {}, anon)).rows.map((r) => r.id)).toEqual([1]);
    expect((await service.list(def, {}, ctx(1, ['l']))).total).toBe(2);
  });

  // fails-without: sem a sobrescrita, ?active=false listaria inativos na vitrine.
  it('ignora active= do cliente', async () => {
    const service = build(rules);
    expect((await service.listPublic(def, { active: 'false' }, anon)).rows.map((r) => r.id)).toEqual([1]);
  });

  it('list continua exigindo ator', async () => {
    await expect(build(rules).list(def, {}, anon)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('não aceita permissão declarada', () => {
    expect(() => build({ ...rules, permissions: { list: 'l', listPublic: 'x' } })).toThrow(/não aceita/);
  });
});

describe('CrudService — hooks recebem o contexto e compõem', () => {
  it('preWrite recebe o request', async () => {
    let seen: unknown;
    const service = build({ hooks: { preWrite: ({ context }) => { seen = context; } } });
    const context = ctx(1);
    await service.create(def, { name: 'x', cnpj: '9' }, context);
    expect(seen).toBe(context);
  });

  it('hooks recebem hookDeps injetadas', async () => {
    let seen: unknown;
    def = defineEntity({ ...rules, hooks: { preWrite: ({ deps }) => { seen = deps; } } }, { schema, scopeField: 'companyId' });
    const service = new CrudService<Ctx>({
      repository: memoryRepository({ customer: seed() }),
      scope: { field: 'companyId', resolve: (c) => c.companyId },
      actor: { resolve: (c) => c.actor },
      permissions: { has: () => true },
      hookDeps: { prisma: 'client' },
    });
    await service.create(def, { name: 'x', cnpj: '9' }, ctx(1));
    expect(seen).toEqual({ prisma: 'client' });
  });

  it('composeHooks encadeia preWrite e soma preList em AND', async () => {
    const { composeHooks } = await import('./hooks');
    const service = build({
      hooks: composeHooks(
        { preWrite: ({ data }) => ({ ...data, name: `${data.name}-a` }) },
        { preWrite: ({ data }) => ({ ...data, name: `${data.name}-b` }) },
        { preList: () => ({ kind: 'cmp', path: ['name'], operator: 'eq', value: 'Alfa' }) },
        { preList: () => ({ kind: 'cmp', path: ['cnpj'], operator: 'eq', value: '111' }) },
      ),
    });
    const created = await service.create(def, { name: 'x', cnpj: '9' }, ctx(1));
    expect(created.name).toBe('x-a-b');
    expect((await service.list(def, {}, ctx(1))).rows.map((r) => r.id)).toEqual([1]);
  });
});

describe('CrudService — upsert', () => {
  it('atualiza quando a chave já existe no escopo', async () => {
    const service = build();
    const result = await service.upsert(def, { cnpj: '111', name: 'Alfa Atualizado' }, ctx(1));
    expect(result.id).toBe(1);
    expect(repo.rows('customer')).toHaveLength(3);
  });

  it('cria quando a chave não existe', async () => {
    const service = build();
    await service.upsert(def, { cnpj: '444', name: 'Delta' }, ctx(1));
    expect(repo.rows('customer')).toHaveLength(4);
  });

  // Upsert sem chave poderia casar o primeiro registro da tabela.
  it('upsert sem a chave no corpo é 400, nunca casa registro arbitrário', async () => {
    const service = build();
    await expect(service.upsert(def, { name: 'Sem Chave' }, ctx(1))).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      field: 'cnpj',
    });
    expect(repo.rows('customer')).toHaveLength(3);
  });
});
