import { describe, expect, it } from 'vitest';

import { ComparisonNode, FilterNode } from './filter-ir';
import { QuerySchema, parseQuery } from './parser';
import { QueryParseError } from './query-error';

const schema: QuerySchema = {
  filterable: {
    name: { type: 'string', nullable: true },
    email: { type: 'string', nullable: true },
    price: { type: 'number', nullable: false },
    active: { type: 'boolean', nullable: false },
    isSeller: { type: 'boolean', nullable: false },
    createdAt: { type: 'date', nullable: false },
    inactiveAt: { type: 'date', nullable: true },
    'trainee.name': {
      type: 'string',
      nullable: true,
      relation: { path: ['trainee'], toMany: false },
    },
    'subscriptions.status': {
      type: 'string',
      nullable: true,
      relation: { path: ['subscriptions'], toMany: true },
    },
  },
  sortable: ['name', 'createdAt', 'id'],
};

function expectError(fn: () => unknown, field: string, reason: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(QueryParseError);
    expect((error as QueryParseError).field).toBe(field);
    expect((error as QueryParseError).reason).toBe(reason);
    return;
  }
  throw new Error('esperava QueryParseError, nada foi lançado');
}

const cmp = (node: FilterNode | undefined): ComparisonNode => node as ComparisonNode;

describe('parseQuery — operador na chave', () => {
  // O defeito nº 1 do desenho antigo: operador no valor não tem escape.
  it('valor que começa com prefixo conhecido é literal', () => {
    const parsed = parseQuery({ name: 'in-natura' }, schema);
    expect(cmp(parsed.filter)).toEqual({
      kind: 'cmp',
      path: ['name'],
      operator: 'eq',
      value: 'in-natura',
    });
  });

  it('in- na chave aciona o operador de lista', () => {
    const parsed = parseQuery({ 'in-name': 'a,b' }, schema);
    expect(cmp(parsed.filter).operator).toBe('in');
    expect(cmp(parsed.filter).value).toEqual(['a', 'b']);
  });

  // fails-without: com `includes('in-')` (o parser atual), 'notin-name' cairia
  // no ramo do `in` e viraria o caminho inexistente 'in-name'.
  it('notin- não é confundido com in-', () => {
    const parsed = parseQuery({ 'notin-name': 'a,b' }, schema);
    expect(cmp(parsed.filter).operator).toBe('notIn');
    expect(cmp(parsed.filter).path).toEqual(['name']);
  });

  // fails-without: com `includes('like-')`, 'notlike-name' viraria 'ke-name'.
  it('notlike- não é confundido com like-', () => {
    const parsed = parseQuery({ 'notlike-name': 'joao' }, schema);
    expect(cmp(parsed.filter).operator).toBe('notContains');
    expect(cmp(parsed.filter).path).toEqual(['name']);
  });

  it('prefixo desconhecido é nome de campo, e cai na allowlist', () => {
    expectError(() => parseQuery({ 'foo-name': 'x' }, schema), 'foo-name', 'not_allowed');
  });
});

describe('parseQuery — matriz de operadores', () => {
  const cases: Array<[key: string, value: string, operator: string]> = [
    ['name', 'x', 'eq'],
    ['not-name', 'x', 'ne'],
    ['like-name', 'x', 'contains'],
    ['notlike-name', 'x', 'notContains'],
    ['in-name', 'a,b', 'in'],
    ['notin-name', 'a,b', 'notIn'],
    ['gt-price', '10', 'gt'],
    ['gte-price', '10', 'gte'],
    ['lt-price', '10', 'lt'],
    ['lte-price', '10', 'lte'],
  ];

  it.each(cases)('%s produz o operador %s', (key, value, operator) => {
    const parsed = parseQuery({ [key]: value }, schema);
    expect(cmp(parsed.filter).operator).toBe(operator);
  });

  it('null-campo=true vira isNull', () => {
    const parsed = parseQuery({ 'null-inactiveAt': 'true' }, schema);
    expect(cmp(parsed.filter)).toEqual({
      kind: 'cmp',
      path: ['inactiveAt'],
      operator: 'isNull',
      value: null,
    });
  });

  it('null-campo=false vira "diferente de nulo"', () => {
    const parsed = parseQuery({ 'null-inactiveAt': 'false' }, schema);
    expect(cmp(parsed.filter).operator).toBe('ne');
    expect(cmp(parsed.filter).value).toBeNull();
  });

  it('contains é case-insensitive', () => {
    const parsed = parseQuery({ 'like-name': 'joao' }, schema);
    expect(cmp(parsed.filter).caseInsensitive).toBe(true);
  });
});

describe('parseQuery — intervalo', () => {
  // Se `where[campo]` guardasse UMA condição só, ">= X E <= Y" seria
  // inexprimível. Aqui viram dois nós num AND.
  it('duas condições no mesmo campo convivem', () => {
    const parsed = parseQuery(
      { 'gte-createdAt': '2026-01-01', 'lte-createdAt': '2026-03-31' },
      schema,
    );
    expect(parsed.filter?.kind).toBe('and');
    const nodes = (parsed.filter as { nodes: ComparisonNode[] }).nodes;
    expect(nodes.map((node) => node.operator)).toEqual(['gte', 'lte']);
  });

  it('data sem horário: gte no início do dia, lte no fim', () => {
    const parsed = parseQuery(
      { 'gte-createdAt': '2026-01-01', 'lte-createdAt': '2026-01-01' },
      schema,
    );
    const nodes = (parsed.filter as { nodes: ComparisonNode[] }).nodes;
    const start = new Date('2026-01-01');
    start.setHours(0, 0, 0, 0);
    const end = new Date('2026-01-01');
    end.setHours(23, 59, 59, 999);
    expect(nodes[0]!.value).toEqual(start);
    expect(nodes[1]!.value).toEqual(end);
  });

  it('data com horário é preservada', () => {
    const parsed = parseQuery({ 'gte-createdAt': '2026-01-01T10:30:00.000Z' }, schema);
    expect(cmp(parsed.filter).value).toEqual(new Date('2026-01-01T10:30:00.000Z'));
  });
});

describe('parseQuery — allowlist e coerção', () => {
  it('campo fora da allowlist é 400, nunca filtro silencioso', () => {
    expectError(() => parseQuery({ password: 'x' }, schema), 'password', 'not_allowed');
  });

  it('like- em campo numérico é operador inaplicável', () => {
    expectError(() => parseQuery({ 'like-price': 'x' }, schema), 'price', 'operator_not_applicable');
  });

  it('gte- em campo booleano é operador inaplicável', () => {
    expectError(() => parseQuery({ 'gte-isSeller': '1' }, schema), 'isSeller', 'operator_not_applicable');
  });

  it('null- em campo não-nulável é operador inaplicável', () => {
    expectError(() => parseQuery({ 'null-price': 'true' }, schema), 'price', 'operator_not_applicable');
  });

  it('número inválido é malformed', () => {
    expectError(() => parseQuery({ price: 'abc' }, schema), 'price', 'malformed');
  });

  it('booleano inválido é malformed', () => {
    expectError(() => parseQuery({ isSeller: 'sim' }, schema), 'isSeller', 'malformed');
  });

  it('data inválida é malformed', () => {
    expectError(() => parseQuery({ 'gte-createdAt': 'ontem' }, schema), 'createdAt', 'malformed');
  });

  it('lista vazia é malformed', () => {
    expectError(() => parseQuery({ 'in-name': ',' }, schema), 'name', 'malformed');
  });

  it('coage cada item da lista pelo tipo do campo', () => {
    const parsed = parseQuery({ 'in-price': '10,20' }, schema);
    expect(cmp(parsed.filter).value).toEqual([10, 20]);
  });

  it('chave repetida na query string é ambiguidade, não "o último vence"', () => {
    expectError(
      () => parseQuery({ 'gte-price': ['1', '2'] as unknown as string }, schema),
      'gte-price',
      'malformed',
    );
  });
});

describe('parseQuery — relações declaradas', () => {
  it('relação to-one filtra pelo caminho', () => {
    const parsed = parseQuery({ 'like-trainee.name': 'ana' }, schema);
    expect(cmp(parsed.filter).path).toEqual(['trainee', 'name']);
    expect(parsed.filter?.kind).toBe('cmp');
  });

  it('relação to-many é embrulhada em quantificador', () => {
    const parsed = parseQuery({ 'subscriptions.status': 'active' }, schema);
    expect(parsed.filter).toEqual({
      kind: 'relation',
      path: ['subscriptions'],
      quantifier: 'some',
      node: { kind: 'cmp', path: ['subscriptions', 'status'], operator: 'eq', value: 'active' },
    });
  });

  it('relação não declarada é 400', () => {
    expectError(() => parseQuery({ 'like-company.cnpj': 'x' }, schema), 'company.cnpj', 'not_allowed');
  });
});

describe('parseQuery — grupos OR', () => {
  it('dois grupos viram um OR de ANDs', () => {
    const parsed = parseQuery(
      { 'or.0.like-name': 'x', 'or.0.isSeller': 'true', 'or.1.like-email': 'x' },
      schema,
    );
    expect(parsed.filter?.kind).toBe('or');
    const nodes = (parsed.filter as { nodes: FilterNode[] }).nodes;
    expect(nodes[0]!.kind).toBe('and');
    expect(nodes[1]!.kind).toBe('cmp');
  });

  it('grupo único é legal', () => {
    const parsed = parseQuery({ 'or.0.like-name': 'x' }, schema);
    expect(cmp(parsed.filter).operator).toBe('contains');
  });

  it('índices não precisam ser contíguos e a ordem é crescente', () => {
    const parsed = parseQuery({ 'or.5.name': 'b', 'or.2.name': 'a' }, schema);
    const nodes = (parsed.filter as { nodes: ComparisonNode[] }).nodes;
    expect(nodes.map((node) => node.value)).toEqual(['a', 'b']);
  });

  it('allowlist vale dentro do grupo', () => {
    expectError(() => parseQuery({ 'or.0.password': 'x' }, schema), 'password', 'not_allowed');
  });

  it('raiz e grupos combinam em AND', () => {
    const parsed = parseQuery({ price: '10', 'or.0.name': 'a', 'or.1.name': 'b' }, schema);
    expect(parsed.filter?.kind).toBe('and');
    const nodes = (parsed.filter as { nodes: FilterNode[] }).nodes;
    expect(nodes.map((node) => node.kind)).toEqual(['cmp', 'or']);
  });
});

describe('parseQuery — paginação e ordenação', () => {
  it('defaults', () => {
    const parsed = parseQuery({}, schema);
    expect(parsed).toMatchObject({ page: 1, limit: 10, orderBy: [] });
    expect(parsed.filter).toBeUndefined();
  });

  it('page é 0-based no contrato herdado', () => {
    expect(parseQuery({ page: '2' }, schema).page).toBe(3);
  });

  it('limit=all é preservado', () => {
    expect(parseQuery({ limit: 'all' }, schema).limit).toBe('all');
  });

  it('limit acima do teto é rejeitado', () => {
    expectError(() => parseQuery({ limit: '5000' }, schema), 'limit', 'pagination_out_of_range');
  });

  it('order-<campo> respeita a allowlist de ordenação', () => {
    const parsed = parseQuery({ 'order-name': 'asc', 'order-createdAt': 'DESC' }, schema);
    expect(parsed.orderBy).toEqual([
      { path: ['name'], direction: 'asc' },
      { path: ['createdAt'], direction: 'desc' },
    ]);
  });

  it('ordenação por campo não permitido é 400', () => {
    expectError(() => parseQuery({ 'order-price': 'asc' }, schema), 'price', 'not_allowed');
  });

  it('direção inválida é malformed', () => {
    expectError(() => parseQuery({ 'order-name': 'cima' }, schema), 'name', 'malformed');
  });

  it('chaves reservadas não viram filtro', () => {
    const parsed = parseQuery({ show: 'trainee', active: 'true', '-aggregate': 'x:count' }, {
      ...schema,
      reserved: ['show', '-aggregate', 'active'],
    });
    expect(parsed.filter).toBeUndefined();
  });
});

describe('parseQuery — limites de proteção', () => {
  it('grupos demais é rejeitado', () => {
    const query: Record<string, string> = {};
    for (let index = 0; index <= 10; index += 1) query[`or.${index}.name`] = 'x';
    expectError(() => parseQuery(query, schema), 'or', 'too_many_conditions');
  });

  it('condições demais é rejeitado', () => {
    const query: Record<string, string> = {};
    for (let index = 0; index < 5; index += 1) query[`or.${index}.name`] = 'x';
    expectError(() => parseQuery(query, { ...schema, maxConditions: 3 }), 'filter', 'too_many_conditions');
  });
});
