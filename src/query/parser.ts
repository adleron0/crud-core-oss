import { ScalarType } from '../ports/schema-provider';
import {
  ComparisonOperator,
  FilterNode,
  ScalarValue,
  and,
  or,
} from './filter-ir';
import { ParsedQuery, SortDirection } from './parsed-query';
import { QueryParseError } from './query-error';

export interface FilterableField {
  type: ScalarType;
  nullable?: boolean;
  /** Presente quando o caminho atravessa uma relação declarada. */
  relation?: { path: string[]; toMany: boolean };
}

export interface QuerySchema {
  /** Allowlist. Chave = caminho declarado ('name', 'trainee.name'). */
  filterable: Record<string, FilterableField>;
  sortable: string[];
  /** Chaves tratadas por outra camada (paginação, includes, agregação). */
  reserved?: string[];
  defaultLimit?: number;
  maxLimit?: number;
  allowLimitAll?: boolean;
  maxConditions?: number;
  maxGroups?: number;
}

export const DEFAULT_RESERVED_KEYS = [
  'page',
  'limit',
  'all',
  'show',
  'active',
  'self',
  'startedAt',
  'endedAt',
  '-aggregate',
];

const DEFAULTS = {
  defaultLimit: 10,
  maxLimit: 100,
  allowLimitAll: true,
  maxConditions: 40,
  maxGroups: 10,
};

/**
 * Prefixos ordenados do MAIS LONGO para o mais curto e comparados sempre com
 * `startsWith`. Com `includes('in-')`, `notin-status` cairia no ramo do
 * `in` e viraria a chave `in-status` — descartada em silêncio.
 * Aqui a ordem e o `startsWith` tornam isso impossível.
 */
const OPERATOR_PREFIXES: Array<[prefix: string, operator: ComparisonOperator]> = [
  ['notlike-', 'notContains'],
  ['notin-', 'notIn'],
  ['null-', 'isNull'],
  ['like-', 'contains'],
  ['gte-', 'gte'],
  ['lte-', 'lte'],
  ['not-', 'ne'],
  ['gt-', 'gt'],
  ['lt-', 'lt'],
  ['in-', 'in'],
];

const TEXT_OPERATORS: ComparisonOperator[] = ['contains', 'notContains'];
const RANGE_OPERATORS: ComparisonOperator[] = ['gt', 'gte', 'lt', 'lte'];
const LIST_OPERATORS: ComparisonOperator[] = ['in', 'notIn'];

const OR_KEY = /^or\.(\d+)\.(.+)$/;
const ORDER_PREFIX = 'order-';

interface Condition {
  key: string;
  path: string;
  operator: ComparisonOperator;
  raw: string;
}

function splitOperator(key: string): { operator: ComparisonOperator; path: string } {
  for (const [prefix, operator] of OPERATOR_PREFIXES) {
    if (key.startsWith(prefix)) {
      return { operator, path: key.slice(prefix.length) };
    }
  }
  return { operator: 'eq', path: key };
}

function parseNumber(field: string, raw: string): number {
  if (!/^-?\d+(\.\d+)?$/.test(raw.trim())) {
    throw new QueryParseError(field, 'malformed', `"${raw}" não é um número`);
  }
  return Number(raw);
}

function parseBoolean(field: string, raw: string): boolean {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new QueryParseError(field, 'malformed', `"${raw}" não é true|false`);
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Semântica preservada de propósito por compatibilidade: data sem
 * horário vira início do dia em `gt`/`gte` e fim do dia em `lt`/`lte`, no fuso
 * local do servidor. Mudar isso alteraria o resultado de todo filtro de
 * período em produção.
 */
function parseDate(field: string, raw: string, operator: ComparisonOperator): Date {
  const value = new Date(raw);
  if (Number.isNaN(value.getTime())) {
    throw new QueryParseError(field, 'malformed', `"${raw}" não é uma data`);
  }
  if (DATE_ONLY.test(raw)) {
    const bounded = new Date(raw);
    if (operator === 'lt' || operator === 'lte') bounded.setHours(23, 59, 59, 999);
    else bounded.setHours(0, 0, 0, 0);
    return bounded;
  }
  return value;
}

function coerce(
  field: string,
  raw: string,
  type: ScalarType,
  operator: ComparisonOperator,
): ScalarValue {
  switch (type) {
    case 'number':
      return parseNumber(field, raw);
    case 'boolean':
      return parseBoolean(field, raw);
    case 'date':
      return parseDate(field, raw, operator);
    default:
      return raw;
  }
}

function assertApplicable(
  field: string,
  operator: ComparisonOperator,
  meta: FilterableField,
): void {
  if (TEXT_OPERATORS.includes(operator) && meta.type !== 'string') {
    throw new QueryParseError(field, 'operator_not_applicable', `"${operator}" exige campo texto`);
  }
  if (RANGE_OPERATORS.includes(operator) && meta.type !== 'number' && meta.type !== 'date') {
    throw new QueryParseError(
      field,
      'operator_not_applicable',
      `"${operator}" exige campo numérico ou data`,
    );
  }
  if (operator === 'isNull' && meta.nullable === false) {
    throw new QueryParseError(
      field,
      'operator_not_applicable',
      'campo não aceita nulo',
    );
  }
}

function buildCondition(condition: Condition, schema: QuerySchema): FilterNode {
  const meta = schema.filterable[condition.path];
  if (!meta) {
    throw new QueryParseError(condition.path, 'not_allowed');
  }
  assertApplicable(condition.path, condition.operator, meta);

  const path = condition.path.split('.');
  let node: FilterNode;

  if (condition.operator === 'isNull') {
    const wanted = parseBoolean(condition.path, condition.raw);
    node = {
      kind: 'cmp',
      path,
      operator: wanted ? 'isNull' : 'ne',
      value: null,
    };
  } else if (LIST_OPERATORS.includes(condition.operator)) {
    const items = condition.raw.split(',').filter((item) => item !== '');
    if (items.length === 0) {
      throw new QueryParseError(condition.path, 'malformed', 'lista vazia');
    }
    node = {
      kind: 'cmp',
      path,
      operator: condition.operator,
      value: items.map((item) => coerce(condition.path, item, meta.type, condition.operator)),
    };
  } else {
    node = {
      kind: 'cmp',
      path,
      operator: condition.operator,
      value: coerce(condition.path, condition.raw, meta.type, condition.operator),
      ...(TEXT_OPERATORS.includes(condition.operator) ? { caseInsensitive: true } : {}),
    };
  }

  if (meta.relation?.toMany) {
    return { kind: 'relation', path: meta.relation.path, quantifier: 'some', node };
  }
  return node;
}

function collect(entries: Array<[string, string]>, schema: QuerySchema): FilterNode | undefined {
  const seen = new Set<string>();
  const conditions: Condition[] = [];
  for (const [key, raw] of entries) {
    const { operator, path } = splitOperator(key);
    const signature = `${operator}:${path}`;
    if (seen.has(signature)) {
      // Ambiguidade explícita em vez de "o último vence".
      throw new QueryParseError(path, 'malformed', `operador repetido em "${path}"`);
    }
    seen.add(signature);
    conditions.push({ key, path, operator, raw });
  }
  return and(conditions.map((condition) => buildCondition(condition, schema)));
}

function parseOrderBy(
  entries: Array<[string, string]>,
  schema: QuerySchema,
): ParsedQuery['orderBy'] {
  return entries.map(([key, raw]) => {
    const field = key.slice(ORDER_PREFIX.length);
    if (!schema.sortable.includes(field)) {
      throw new QueryParseError(field, 'not_allowed', `Ordenação não permitida em "${field}"`);
    }
    const direction = raw.toLowerCase();
    if (direction !== 'asc' && direction !== 'desc') {
      throw new QueryParseError(field, 'malformed', `direção "${raw}" inválida`);
    }
    return { path: field.split('.'), direction: direction as SortDirection };
  });
}

function parsePage(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 1;
  if (!/^\d+$/.test(raw)) throw new QueryParseError('page', 'pagination_out_of_range');
  // Contrato herdado: o cliente manda page 0-based.
  return Number(raw) + 1;
}

function parseLimit(raw: string | undefined, schema: Required<Pick<QuerySchema, 'defaultLimit' | 'maxLimit' | 'allowLimitAll'>>): number | 'all' {
  if (raw === undefined || raw === '') return schema.defaultLimit;
  if (raw === 'all') {
    if (!schema.allowLimitAll) throw new QueryParseError('limit', 'pagination_out_of_range');
    return 'all';
  }
  if (!/^\d+$/.test(raw)) throw new QueryParseError('limit', 'pagination_out_of_range');
  const value = Number(raw);
  if (value < 1 || value > schema.maxLimit) {
    throw new QueryParseError('limit', 'pagination_out_of_range');
  }
  return value;
}

/**
 * Traduz a query string em IR neutra. Toda violação lança `QueryParseError`;
 * nenhum caminho devolve filtro parcial.
 */
export function parseQuery(
  query: Record<string, string | string[] | undefined>,
  schema: QuerySchema,
): ParsedQuery {
  const limits = {
    defaultLimit: schema.defaultLimit ?? DEFAULTS.defaultLimit,
    maxLimit: schema.maxLimit ?? DEFAULTS.maxLimit,
    allowLimitAll: schema.allowLimitAll ?? DEFAULTS.allowLimitAll,
  };
  const maxConditions = schema.maxConditions ?? DEFAULTS.maxConditions;
  const maxGroups = schema.maxGroups ?? DEFAULTS.maxGroups;
  const reserved = new Set(schema.reserved ?? DEFAULT_RESERVED_KEYS);

  const rootEntries: Array<[string, string]> = [];
  const orderEntries: Array<[string, string]> = [];
  const groups = new Map<number, Array<[string, string]>>();

  for (const [key, rawValue] of Object.entries(query)) {
    if (rawValue === undefined) continue;
    if (Array.isArray(rawValue)) {
      throw new QueryParseError(key, 'malformed', 'valor repetido na query string');
    }
    if (reserved.has(key)) continue;

    if (key.startsWith(ORDER_PREFIX)) {
      orderEntries.push([key, rawValue]);
      continue;
    }

    const group = OR_KEY.exec(key);
    if (group) {
      const index = Number(group[1]);
      const inner = group[2] as string;
      const bucket = groups.get(index) ?? [];
      bucket.push([inner, rawValue]);
      groups.set(index, bucket);
      continue;
    }

    rootEntries.push([key, rawValue]);
  }

  if (groups.size > maxGroups) {
    throw new QueryParseError('or', 'too_many_conditions', `máximo de ${maxGroups} grupos`);
  }
  const totalConditions =
    rootEntries.length + [...groups.values()].reduce((sum, bucket) => sum + bucket.length, 0);
  if (totalConditions > maxConditions) {
    throw new QueryParseError('filter', 'too_many_conditions', `máximo de ${maxConditions} condições`);
  }

  const rootFilter = collect(rootEntries, schema);

  const orNodes: FilterNode[] = [];
  for (const index of [...groups.keys()].sort((a, b) => a - b)) {
    const bucket = groups.get(index)!;
    const node = collect(bucket, schema);
    if (!node) {
      throw new QueryParseError(`or.${index}`, 'malformed', 'grupo vazio');
    }
    orNodes.push(node);
  }
  const orFilter = or(orNodes);

  return {
    filter: and([rootFilter, orFilter].filter(Boolean) as FilterNode[]),
    orderBy: parseOrderBy(orderEntries, schema),
    page: parsePage(query.page as string | undefined),
    limit: parseLimit(query.limit as string | undefined, limits),
  };
}
