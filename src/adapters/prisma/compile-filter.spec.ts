import { describe, expect, it } from 'vitest';

import { ComparisonNode, FilterNode } from '../../query/filter-ir';
import { compileFilter, compileOrderBy, compileUniqueWhere, mergeWhere } from './compile-filter';

const cmp = (
  path: string[],
  operator: ComparisonNode['operator'],
  value: unknown,
  caseInsensitive?: boolean,
): FilterNode =>
  ({ kind: 'cmp', path, operator, value, ...(caseInsensitive ? { caseInsensitive } : {}) }) as FilterNode;

describe('compileFilter — operadores', () => {
  it('eq vira valor direto', () => {
    expect(compileFilter(cmp(['name'], 'eq', 'ana'))).toEqual({ name: 'ana' });
  });

  it('ne vira not', () => {
    expect(compileFilter(cmp(['name'], 'ne', 'ana'))).toEqual({ name: { not: 'ana' } });
  });

  it('contains carrega mode insensitive', () => {
    expect(compileFilter(cmp(['name'], 'contains', 'ana', true))).toEqual({
      name: { contains: 'ana', mode: 'insensitive' },
    });
  });

  // fails-without: `{ name: { not: { contains, mode } } }` é recusado pelo
  // Prisma (o filtro aninhado do `not` não tem `mode`). Pego só contra Postgres real.
  it('notContains vira NOT no nível do registro', () => {
    expect(compileFilter(cmp(['name'], 'notContains', 'ana', true))).toEqual({
      NOT: { name: { contains: 'ana', mode: 'insensitive' } },
    });
  });

  it('in e notIn', () => {
    expect(compileFilter(cmp(['id'], 'in', [1, 2]))).toEqual({ id: { in: [1, 2] } });
    expect(compileFilter(cmp(['id'], 'notIn', [1, 2]))).toEqual({ id: { notIn: [1, 2] } });
  });

  it('comparações', () => {
    expect(compileFilter(cmp(['price'], 'gte', 10))).toEqual({ price: { gte: 10 } });
    expect(compileFilter(cmp(['price'], 'lt', 10))).toEqual({ price: { lt: 10 } });
  });

  it('isNull vira null literal', () => {
    expect(compileFilter(cmp(['inactiveAt'], 'isNull', null))).toEqual({ inactiveAt: null });
  });

  it('ne null vira not null', () => {
    expect(compileFilter(cmp(['inactiveAt'], 'ne', null))).toEqual({ inactiveAt: { not: null } });
  });
});

describe('compileFilter — composição', () => {
  it('and vira AND', () => {
    const filter: FilterNode = {
      kind: 'and',
      nodes: [cmp(['a'], 'eq', 1), cmp(['b'], 'eq', 2)],
    };
    expect(compileFilter(filter)).toEqual({ AND: [{ a: 1 }, { b: 2 }] });
  });

  it('or vira OR', () => {
    const filter: FilterNode = {
      kind: 'or',
      nodes: [cmp(['a'], 'eq', 1), cmp(['b'], 'eq', 2)],
    };
    expect(compileFilter(filter)).toEqual({ OR: [{ a: 1 }, { b: 2 }] });
  });

  it('relação to-one aninha o caminho', () => {
    expect(compileFilter(cmp(['seller', 'name'], 'contains', 'ana', true))).toEqual({
      seller: { name: { contains: 'ana', mode: 'insensitive' } },
    });
  });

  // O caminho do nó interno é absoluto na IR; dentro do `some` ele precisa
  // virar relativo, senão sairia { subs: { some: { subs: { status } } } }.
  it('relação to-many usa quantificador e torna o caminho relativo', () => {
    const filter: FilterNode = {
      kind: 'relation',
      path: ['subscriptions'],
      quantifier: 'some',
      node: cmp(['subscriptions', 'status'], 'eq', 'active'),
    };
    expect(compileFilter(filter)).toEqual({ subscriptions: { some: { status: 'active' } } });
  });

  it('and dentro de relação to-many mantém tudo relativo', () => {
    const filter: FilterNode = {
      kind: 'relation',
      path: ['subscriptions'],
      quantifier: 'some',
      node: {
        kind: 'and',
        nodes: [cmp(['subscriptions', 'status'], 'eq', 'active'), cmp(['subscriptions', 'paid'], 'eq', true)],
      },
    };
    expect(compileFilter(filter)).toEqual({
      subscriptions: { some: { AND: [{ status: 'active' }, { paid: true }] } },
    });
  });

  it('filtro ausente compila para undefined', () => {
    expect(compileFilter(undefined)).toBeUndefined();
  });
});

describe('compileOrderBy e mergeWhere', () => {
  it('ordenação simples e aninhada', () => {
    expect(
      compileOrderBy([
        { path: ['name'], direction: 'asc' },
        { path: ['seller', 'name'], direction: 'desc' },
      ]),
    ).toEqual([{ name: 'asc' }, { seller: { name: 'desc' } }]);
  });

  it('mergeWhere ignora partes vazias', () => {
    expect(mergeWhere({ a: 1 }, undefined, {})).toEqual({ a: 1 });
  });

  it('mergeWhere combina em AND', () => {
    expect(mergeWhere({ a: 1 }, { b: 2 })).toEqual({ AND: [{ a: 1 }, { b: 2 }] });
  });

  it('mergeWhere sem partes é undefined', () => {
    expect(mergeWhere(undefined, {})).toBeUndefined();
  });
});

describe('compileUniqueWhere — escrita por chave', () => {
  it('achata AND de igualdades no nível de cima', () => {
    expect(compileUniqueWhere({ kind: 'and', nodes: [cmp(['id'], 'eq', 1), cmp(['companyId'], 'eq', 7)] }))
      .toEqual({ id: 1, companyId: 7 });
  });
  it('igualdade única', () => expect(compileUniqueWhere(cmp(['cnpj'], 'eq', '1'))).toEqual({ cnpj: '1' }));
  it('recusa operador que não seja igualdade', () => {
    expect(() => compileUniqueWhere(cmp(['id'], 'gt', 1))).toThrow();
  });
  it('recusa caminho de relação', () => {
    expect(() => compileUniqueWhere(cmp(['a', 'b'], 'eq', 1))).toThrow();
  });
});
