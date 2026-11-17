import { describe, expect, it } from 'vitest';

import { Dmmf } from './dmmf.types';
import { prismaSchemaProvider } from './schema-provider';

const dmmf: Dmmf = {
  datamodel: {
    models: [
      {
        name: 'Customer',
        fields: [
          { name: 'id', kind: 'scalar', type: 'Int', isRequired: true, isList: false, isId: true, isUnique: false, hasDefaultValue: true },
          { name: 'name', kind: 'scalar', type: 'String', isRequired: true, isList: false, isId: false, isUnique: false },
          { name: 'email', kind: 'scalar', type: 'String', isRequired: false, isList: false, isId: false, isUnique: true },
          { name: 'price', kind: 'scalar', type: 'Decimal', isRequired: true, isList: false, isId: false, isUnique: false },
          { name: 'active', kind: 'scalar', type: 'Boolean', isRequired: true, isList: false, isId: false, isUnique: false, hasDefaultValue: true },
          { name: 'kind', kind: 'enum', type: 'CustomerKind', isRequired: true, isList: false, isId: false, isUnique: false },
          { name: 'meta', kind: 'scalar', type: 'Json', isRequired: false, isList: false, isId: false, isUnique: false },
          { name: 'methods', kind: 'enum', type: 'PayMethod', isRequired: true, isList: true, isId: false, isUnique: false },
          { name: 'createdAt', kind: 'scalar', type: 'DateTime', isRequired: true, isList: false, isId: false, isUnique: false, hasDefaultValue: true },
          { name: 'updatedAt', kind: 'scalar', type: 'DateTime', isRequired: true, isList: false, isId: false, isUnique: false, isUpdatedAt: true },
          { name: 'seller', kind: 'object', type: 'User', isRequired: false, isList: false, isId: false, isUnique: false, relationName: 'CustomerToUser' },
          { name: 'contacts', kind: 'object', type: 'Contact', isRequired: false, isList: true, isId: false, isUnique: false, relationName: 'ContactToCustomer' },
        ],
        uniqueFields: [['name', 'price']],
      },
      {
        name: 'User',
        fields: [
          { name: 'uuid', kind: 'scalar', type: 'String', isRequired: true, isList: false, isId: true, isUnique: false },
        ],
      },
    ],
    enums: [{ name: 'PayMethod', values: [{ name: 'pix' }, { name: 'boleto' }] }],
  },
};

const provider = prismaSchemaProvider(dmmf);

describe('prismaSchemaProvider', () => {
  it('mapeia tipos do Prisma para os escalares do núcleo', () => {
    const model = provider.model('Customer')!;
    const type = (name: string) => model.fields.find((field) => field.name === name)?.type;
    expect(type('name')).toBe('string');
    expect(type('price')).toBe('number');
    expect(type('active')).toBe('boolean');
    expect(type('createdAt')).toBe('date');
    expect(type('meta')).toBe('json');
    expect(type('kind')).toBe('string');
  });

  it('nullable vem de isRequired', () => {
    const model = provider.model('Customer')!;
    expect(model.fields.find((f) => f.name === 'email')?.nullable).toBe(true);
    expect(model.fields.find((f) => f.name === 'name')?.nullable).toBe(false);
  });

  // A regra tem que separar "tem default" de "é gerado": `active @default(true)`
  // precisa continuar gravável no create.
  it('gerados: @updatedAt, createdAt com default e pk com default', () => {
    const model = provider.model('Customer')!;
    const generated = (name: string) => model.fields.find((f) => f.name === name)?.isGenerated;
    expect(generated('id')).toBe(true);
    expect(generated('createdAt')).toBe(true);
    expect(generated('updatedAt')).toBe(true);
    expect(generated('active')).toBe(false);
    expect(generated('name')).toBe(false);
  });

  it('separa relações de escalares e marca cardinalidade', () => {
    const model = provider.model('Customer')!;
    expect(model.fields.some((f) => f.name === 'seller')).toBe(false);
    expect(model.relations).toEqual([
      { name: 'seller', target: 'User', toMany: false },
      { name: 'contacts', target: 'Contact', toMany: true },
    ]);
  });

  it('reúne uniques de campo único e compostos', () => {
    expect(provider.model('Customer')!.uniques).toEqual([['id'], ['email'], ['name', 'price']]);
  });

  it('lista de enum entra com isList e os valores do enum', () => {
    const field = provider.model('Customer')!.fields.find((f) => f.name === 'methods');
    expect(field).toMatchObject({ isList: true, enumValues: ['pix', 'boleto'], nullable: true });
  });

  it('pk não precisa se chamar id', () => {
    expect(provider.model('User')!.idField).toBe('uuid');
  });

  it('model inexistente devolve null', () => {
    expect(provider.model('Inexistente')).toBeNull();
  });
});
