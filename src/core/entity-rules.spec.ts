import { describe, expect, it } from 'vitest';

import { fakeSchema } from '../testing/fake-schema';
import { BootError } from './boot-error';
import { DefineEntityOptions, EntityRules, defineEntity } from './entity-rules';

const schema = fakeSchema({
  Customer: {
    fields: {
      id: { type: 'number', isId: true, isGenerated: true },
      companyId: { type: 'number' },
      name: {},
      cnpj: { isUnique: true },
      email: { nullable: true },
      secret: {},
      status: { type: 'number' },
      createdAt: { type: 'date', isGenerated: true },
      updatedAt: { type: 'date', isGenerated: true },
      inactiveAt: { type: 'date', nullable: true },
    },
    relations: {
      seller: { target: 'User' },
      contacts: { target: 'Contact', toMany: true },
    },
  },
  User: { fields: { id: { type: 'number', isId: true }, name: {} } },
  Contact: { fields: { id: { type: 'number', isId: true }, phone: {} } },
});

const base: EntityRules = {
  entity: 'customer',
  model: 'Customer',
  expose: ['list', 'getById', 'create', 'update'],
  permissions: {
    list: 'list_clientes',
    getById: 'list_clientes',
    create: 'create_clientes',
    update: 'update_clientes',
  },
  filterable: ['name', 'cnpj', 'createdAt'],
  sortable: ['name', 'createdAt'],
};

// Spread com `scopeField: undefined` sobrescreve de verdade — parâmetro com
// valor default NÃO seria sobrescrito por `undefined` explícito.
const define = (rules: Partial<EntityRules>, options: Partial<DefineEntityOptions> = {}) =>
  defineEntity({ ...base, ...rules } as EntityRules, {
    schema,
    scopeField: 'companyId',
    ...options,
  });

describe('defineEntity — declaração válida', () => {
  it('compila delegate, pk e escopo a partir do schema', () => {
    const def = define({});
    expect(def.delegate).toBe('customer');
    expect(def.idField).toBe('id');
    expect(def.scoped).toBe(true);
    expect(def.scopeField).toBe('companyId');
  });

  // Declarar o delegate à mão abre espaço para 'CourseClass' quando o client
  // só tem courseClass. Aqui o delegate é DERIVADO, não declarado.
  it('deriva o delegate em camelCase, sem depender de declaração', () => {
    const def = defineEntity(
      { ...base, entity: 'course-class', model: 'CourseClass' },
      { schema: fakeSchema({ CourseClass: { fields: { id: { isId: true }, name: {}, cnpj: {}, createdAt: {} } } }) },
    );
    expect(def.delegate).toBe('courseClass');
  });

  it('a entidade pode sobrescrever a coluna de escopo (tenant = a própria pk)', () => {
    const def = define({ scopeField: 'id' });
    expect(def.scopeField).toBe('id');
    expect(def.scoped).toBe(true);
    expect(def.writableFields.has('companyId')).toBe(true);
  });

  it('single-tenant quando não há scopeField', () => {
    expect(define({}, { scopeField: undefined }).scoped).toBe(false);
  });

  it('resolve tipo e cardinalidade dos caminhos filtráveis', () => {
    const def = define({ filterable: ['name', 'createdAt', 'seller.name', 'contacts.phone'] });
    expect(def.filterable.createdAt).toEqual({ type: 'date', nullable: false });
    expect(def.filterable['seller.name']!.relation).toEqual({ path: ['seller'], toMany: false });
    expect(def.filterable['contacts.phone']!.relation).toEqual({ path: ['contacts'], toMany: true });
  });
});

describe('defineEntity — permissão obrigatória', () => {
  // A lei central: autorização opt-in é o que produz rota aberta esquecida.
  it('op exposta sem permissão derruba o boot', () => {
    expect(() => define({ expose: [...base.expose, 'archive'], softDelete: { field: 'inactiveAt' } }))
      .toThrow(BootError);
  });

  it('permissão vazia conta como ausente', () => {
    expect(() => define({ permissions: { ...base.permissions, update: '  ' } })).toThrow(BootError);
  });

  it('expose vazio derruba o boot', () => {
    expect(() => define({ expose: [] })).toThrow(BootError);
  });

  it('segmento de rota inválido derruba o boot', () => {
    expect(() => define({ entity: 'Customer/Sub' })).toThrow(BootError);
  });

  // Achado em uso real: o provider compilava TODOS os models na subida e
  // estourava em qualquer tabela de junção. Model com pk composta agora
  // convive no schema e só é recusado quando alguém tenta declará-lo.
  it('model com pk composta é recusado na declaração, não na subida', () => {
    const junction = fakeSchema({
      PostTag: { fields: { postId: { type: 'number' }, tagId: { type: 'number' } }, idField: null },
    });
    expect(() =>
      defineEntity(
        { ...base, entity: 'post-tags', model: 'PostTag', filterable: [], sortable: [] },
        { schema: junction },
      ),
    ).toThrow(/pk composta/);
  });

  it('model inexistente derruba o boot', () => {
    expect(() => define({ model: 'Inexistente' })).toThrow(BootError);
  });
});

describe('defineEntity — lei do restore', () => {
  const withArchive: Partial<EntityRules> = {
    expose: ['list', 'getById', 'archive', 'restore'],
    permissions: { list: 'l', getById: 'l', archive: 'a' },
    softDelete: { field: 'inactiveAt' },
  };

  it('restore reusa a permissão do archive', () => {
    expect(define(withArchive).permissions.restore).toBe('a');
  });

  // fails-without: sem esta guarda, declarar permissions.restore seria
  // sobrescrito em silêncio — a classe de bug que o núcleo existe para matar.
  it('declarar permissions.restore é erro, mesmo com o mesmo valor', () => {
    expect(() =>
      define({ ...withArchive, permissions: { list: 'l', getById: 'l', archive: 'a', restore: 'a' } }),
    ).toThrow(BootError);
  });

  // Projetos com `activate_x` e `inactive_x` separadas: forçar a fusão seria
  // impor um modelo estrangeiro. O opt-in mantém a declaração explícita.
  it("restorePermission 'own' exige permissão própria declarada", () => {
    const def = define({
      ...withArchive,
      restorePermission: 'own',
      permissions: { list: 'l', getById: 'l', archive: 'a', restore: 'r' },
    });
    expect(def.permissions.restore).toBe('r');
  });

  it("restorePermission 'own' sem permissions.restore é erro", () => {
    expect(() => define({ ...withArchive, restorePermission: 'own' })).toThrow(/exige/);
  });

  it('restore sem archive exposto é erro', () => {
    expect(() =>
      define({
        expose: ['list', 'getById', 'restore'],
        permissions: { list: 'l', getById: 'l' },
        softDelete: { field: 'inactiveAt' },
      }),
    ).toThrow(BootError);
  });

  it('archive sem softDelete declarado é erro', () => {
    expect(() =>
      define({ expose: ['list', 'archive'], permissions: { list: 'l', archive: 'a' } }),
    ).toThrow(BootError);
  });

  it('coluna de softDelete inexistente é erro', () => {
    expect(() =>
      define({
        expose: ['list', 'archive'],
        permissions: { list: 'l', archive: 'a' },
        softDelete: { field: 'deletedAt' },
      }),
    ).toThrow(BootError);
  });
});

describe('defineEntity — ops de self', () => {
  const withSelf: Partial<EntityRules> = {
    expose: ['list', 'getSelf', 'updateSelf'],
    permissions: { list: 'l' },
    selfRestricted: ['status'],
  };

  it('self dispensa permissão: a autorização é a identidade', () => {
    const def = define(withSelf);
    expect(def.permissions.getSelf).toBeUndefined();
  });

  it('declarar permissão para op de self é erro', () => {
    expect(() => define({ ...withSelf, permissions: { list: 'l', getSelf: 'x' } })).toThrow(/não aceita/);
  });

  // PUT /user/self: a decisão sobre o que o próprio usuário pode
  // mudar tem que ser explícita, nunca herdada em silêncio.
  it('updateSelf exige selfRestricted declarado, mesmo vazio', () => {
    expect(() => define({ ...withSelf, selfRestricted: undefined })).toThrow(/selfRestricted/);
    expect(define({ ...withSelf, selfRestricted: [] }).selfUpdatableFields.has('name')).toBe(true);
  });

  it('selfRestricted estreita a allowlist do update', () => {
    const def = define({ ...withSelf, selfRestricted: ['email'] });
    expect(def.updatableFields.has('email')).toBe(true);
    expect(def.selfUpdatableFields.has('email')).toBe(false);
    expect(def.restrictedSelfFields.has('email')).toBe(true);
  });

  it('selfRestricted sem updateSelf é erro', () => {
    expect(() => define({ selfRestricted: [] })).toThrow(/selfRestricted/);
  });

  it('campo de selfRestricted inexistente é erro', () => {
    expect(() => define({ ...withSelf, selfRestricted: ['nope'] })).toThrow(BootError);
  });
});

describe('defineEntity — lei do upsert', () => {
  // Um upsert herdado de classe base, sem permissão e com where vazio,
  // casaria o primeiro registro da tabela.
  it('upsert sem upsertKey derruba o boot', () => {
    expect(() =>
      define({ expose: [...base.expose, 'upsert'], permissions: { ...base.permissions, upsert: 'u' } }),
    ).toThrow(/upsertKey/);
  });

  it('upsertKey sem constraint unique derruba o boot', () => {
    expect(() =>
      define({
        expose: [...base.expose, 'upsert'],
        permissions: { ...base.permissions, upsert: 'u' },
        upsertKey: 'name',
      }),
    ).toThrow(/unique/);
  });

  it('upsertKey unique é aceita', () => {
    const def = define({
      expose: [...base.expose, 'upsert'],
      permissions: { ...base.permissions, upsert: 'u' },
      upsertKey: 'cnpj',
    });
    expect(def.rules.upsertKey).toBe('cnpj');
  });

  it('upsertKey declarada sem upsert exposto é erro', () => {
    expect(() => define({ upsertKey: 'cnpj' })).toThrow(BootError);
  });
});

describe('defineEntity — allowlists', () => {
  it('campo filtrável inexistente derruba o boot', () => {
    expect(() => define({ filterable: ['inexistente'] })).toThrow(BootError);
  });

  it('relação não declarada no schema derruba o boot', () => {
    expect(() => define({ filterable: ['empresa.nome'] })).toThrow(BootError);
  });

  it('mais de um nível de relação não é suportado', () => {
    expect(() => define({ filterable: ['seller.company.name'] })).toThrow(/mais de um nível/);
  });

  // Pendência registrada no ADR-001, agora fechada: o parser ignoraria a chave
  // reservada em silêncio e o filtro declarado nunca funcionaria.
  it('campo filtrável que colide com chave reservada derruba o boot', () => {
    expect(() => define({ filterable: ['name', 'active'] })).toThrow(/reservada/);
  });

  it('campo mascarado não pode ser filtrável (sondagem de valor)', () => {
    expect(() => define({ filterable: ['name', 'secret'], maskedFields: ['secret'] }))
      .toThrow(/mascarado/);
  });

  it('campo mascarado não pode ser ordenável', () => {
    expect(() => define({ sortable: ['name', 'secret'], maskedFields: ['secret'] }))
      .toThrow(/mascarado/);
  });

  it('campo mascarado inexistente derruba o boot', () => {
    expect(() => define({ maskedFields: ['inexistente'] })).toThrow(BootError);
  });

  it('_count é includável sem existir como relação', () => {
    expect(define({ includable: ['_count'] }).includable).toEqual(['_count']);
  });

  it('relação includável inexistente derruba o boot', () => {
    expect(() => define({ includable: ['pedidos'] })).toThrow(BootError);
  });

  it('campo agregável inexistente derruba o boot', () => {
    expect(() => define({ aggregatable: ['inexistente'] })).toThrow(BootError);
  });

  it('campo mascarado não pode ser agregável', () => {
    expect(() => define({ aggregatable: ['secret'], maskedFields: ['secret'] })).toThrow(/mascarado/);
  });

  it('campo ordenável inexistente derruba o boot', () => {
    expect(() => define({ sortable: ['inexistente'] })).toThrow(BootError);
  });
});

describe('defineEntity — autoWhitelist', () => {
  const auto = (rules: Partial<EntityRules> = {}) => define(rules, { autoWhitelist: true });

  it('libera filtro e ordenação em todo campo escalar', () => {
    const def = auto();
    expect(Object.keys(def.filterable)).toEqual(expect.arrayContaining(['id', 'email', 'status', 'inactiveAt']));
    expect(def.sortable).toEqual(expect.arrayContaining(['id', 'email', 'status', 'name', 'createdAt']));
  });

  it('nunca libera campo mascarado nem publicMasked', () => {
    const def = auto({ maskedFields: ['secret'], publicMaskedFields: ['email'] });
    expect(def.filterable.secret).toBeUndefined();
    expect(def.filterable.email).toBeUndefined();
    expect(def.sortable).not.toContain('secret');
    expect(def.sortable).not.toContain('email');
  });

  it('mantém relações declaradas e não inventa relações', () => {
    const def = auto({ filterable: ['seller.name'] });
    expect(def.filterable['seller.name']).toBeDefined();
    expect(Object.keys(def.filterable).some((k) => k.startsWith('contacts.'))).toBe(false);
  });

  it('strictWhitelist desliga a liberação para a entidade', () => {
    const def = auto({ strictWhitelist: true });
    expect(Object.keys(def.filterable).sort()).toEqual(['cnpj', 'createdAt', 'name']);
    expect(def.sortable).toEqual(['name', 'createdAt']);
  });

  it('desligado (padrão), vale só a allowlist declarada', () => {
    expect(Object.keys(define({}).filterable).sort()).toEqual(['cnpj', 'createdAt', 'name']);
  });
});

describe('defineEntity — mass-assignment', () => {
  it('campos gerados e a coluna de escopo não são graváveis', () => {
    const def = define({ softDelete: { field: 'inactiveAt' }, expose: ['list'], permissions: { list: 'l' } });
    expect(def.writableFields.has('name')).toBe(true);
    expect(def.writableFields.has('id')).toBe(false);
    expect(def.writableFields.has('createdAt')).toBe(false);
    expect(def.writableFields.has('updatedAt')).toBe(false);
    expect(def.writableFields.has('companyId')).toBe(false);
    expect(def.writableFields.has('inactiveAt')).toBe(false);
  });

  // PUT /user/self não pode aceitar profileId nem companyId.
  it('a coluna de escopo é campo restrito, não campo ignorado', () => {
    const def = define({});
    expect(def.restrictedCreateFields.has('companyId')).toBe(true);
    expect(def.restrictedUpdateFields.has('companyId')).toBe(true);
  });

  it('pk é restrita no update e ausente do updatable', () => {
    const def = define({});
    expect(def.updatableFields.has('id')).toBe(false);
    expect(def.restrictedUpdateFields.has('id')).toBe(true);
  });

  it('status é restrito no update por padrão', () => {
    const def = define({});
    expect(def.updatableFields.has('status')).toBe(false);
    expect(def.restrictedUpdateFields.has('status')).toBe(true);
  });

  it('statusUpdatable libera status explicitamente', () => {
    const def = define({ statusUpdatable: true });
    expect(def.updatableFields.has('status')).toBe(true);
    expect(def.restrictedUpdateFields.has('status')).toBe(false);
  });

  it('neverWritable acrescenta restrições', () => {
    const def = define({ neverWritable: ['secret'] });
    expect(def.writableFields.has('secret')).toBe(false);
    expect(def.restrictedCreateFields.has('secret')).toBe(true);
  });

  it('sem escopo, a coluna de escopo volta a ser gravável', () => {
    expect(define({}, { scopeField: undefined }).writableFields.has('companyId')).toBe(true);
  });
});
