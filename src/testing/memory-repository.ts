import { FindManyArgs, Repository, Row, WriteArgs } from '../ports/repository';
import { AggregateBucket, AggregateSpec } from '../query/aggregate';
import { ComparisonNode, FilterNode, ScalarValue } from '../query/filter-ir';

function valueAt(row: Row, path: string[]): unknown {
  return path.reduce<unknown>(
    (acc, key) => (acc && typeof acc === 'object' ? (acc as Row)[key] : undefined),
    row,
  );
}

function compare(left: unknown, right: unknown): number {
  if (left instanceof Date && right instanceof Date) return left.getTime() - right.getTime();
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  return String(left).localeCompare(String(right));
}

function text(value: unknown, caseInsensitive?: boolean): string {
  const raw = String(value ?? '');
  return caseInsensitive ? raw.toLowerCase() : raw;
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime();
  return left === right;
}

function matchesComparison(row: Row, node: ComparisonNode, offset: number): boolean {
  const actual = valueAt(row, node.path.slice(offset));
  const expected = node.value as ScalarValue | ScalarValue[];

  switch (node.operator) {
    case 'eq':
      return sameValue(actual, expected);
    case 'ne':
      return !sameValue(actual, expected);
    case 'contains':
      return text(actual, node.caseInsensitive).includes(text(expected, node.caseInsensitive));
    case 'notContains':
      return !text(actual, node.caseInsensitive).includes(text(expected, node.caseInsensitive));
    case 'in':
      return (expected as ScalarValue[]).some((item) => sameValue(actual, item));
    case 'notIn':
      return !(expected as ScalarValue[]).some((item) => sameValue(actual, item));
    case 'gt':
      return compare(actual, expected) > 0;
    case 'gte':
      return compare(actual, expected) >= 0;
    case 'lt':
      return compare(actual, expected) < 0;
    case 'lte':
      return compare(actual, expected) <= 0;
    case 'isNull':
      return actual === null || actual === undefined;
    default: {
      const exhaustive: never = node.operator;
      throw new Error(`operador não suportado: ${String(exhaustive)}`);
    }
  }
}

function matches(row: Row, node: FilterNode, offset = 0): boolean {
  if (node.kind === 'cmp') return matchesComparison(row, node, offset);
  // Um único teste para os dois: `LogicalNode.kind` é 'and' | 'or', então dois
  // ifs separados não estreitam o tipo para RelationNode.
  if (node.kind === 'and' || node.kind === 'or') {
    const children = node.nodes.map((child) => matches(row, child, offset));
    return node.kind === 'and' ? children.every(Boolean) : children.some(Boolean);
  }

  const related = valueAt(row, node.path.slice(offset));
  const items = Array.isArray(related) ? (related as Row[]) : related ? [related as Row] : [];
  const inner = (item: Row) => matches(item, node.node, offset + node.path.length);
  if (node.quantifier === 'every') return items.every(inner);
  if (node.quantifier === 'none') return !items.some(inner);
  return items.some(inner);
}

/**
 * Repositório em memória — a SEMÂNTICA DE REFERÊNCIA da IR.
 *
 * Serve a dois propósitos: valida a própria suíte de conformidade e dá ao
 * consumidor um dublê para testar regras de entidade sem subir banco. Um
 * adapter real deve produzir exatamente os mesmos resultados.
 *
 * Não simula transação: `transaction` executa a função, sem rollback.
 */
export function memoryRepository(tables: Record<string, Row[]> = {}): Repository & {
  rows(model: string): Row[];
} {
  const store: Record<string, Row[]> = {};
  for (const [model, rows] of Object.entries(tables)) store[model] = rows.map((row) => ({ ...row }));

  const table = (model: string): Row[] => (store[model] ??= []);

  const repo: Repository & { rows(model: string): Row[] } = {
    rows: (model) => table(model),

    async findMany(model, args: FindManyArgs) {
      let rows = table(model).filter((row) => (args.filter ? matches(row, args.filter) : true));
      for (const entry of [...args.orderBy].reverse()) {
        rows = [...rows].sort((left, right) => {
          const result = compare(valueAt(left, entry.path), valueAt(right, entry.path));
          return entry.direction === 'asc' ? result : -result;
        });
      }
      const from = args.skip ?? 0;
      const to = args.take === null || args.take === undefined ? undefined : from + args.take;
      return rows.slice(from, to).map((row) => ({ ...row }));
    },

    async count(model, filter?: FilterNode) {
      return table(model).filter((row) => (filter ? matches(row, filter) : true)).length;
    },

    async findOne(model, filter) {
      const found = table(model).find((row) => matches(row, filter));
      return found ? { ...found } : null;
    },

    async create(model, data) {
      const row = { ...data };
      table(model).push(row);
      return { ...row };
    },

    async update(model, args: WriteArgs) {
      const rows = table(model);
      const index = rows.findIndex((row) => matches(row, args.filter));
      if (index < 0) throw new Error('memoryRepository: registro não encontrado para update');
      rows[index] = { ...rows[index], ...args.data };
      return { ...rows[index] } as Row;
    },

    async upsert(model, args: WriteArgs) {
      const rows = table(model);
      const index = rows.findIndex((row) => matches(row, args.filter));
      if (index < 0) {
        // Igual ao adapter real: a chave do filtro entra no registro criado.
        const seeded = args.filter.kind === 'cmp' && args.filter.operator === 'eq' && args.filter.path.length === 1
          ? { [args.filter.path[0]!]: args.filter.value }
          : {};
        return repo.create(model, { ...seeded, ...args.data });
      }
      rows[index] = { ...rows[index], ...args.data };
      return { ...rows[index] } as Row;
    },

    async aggregate(model, spec: AggregateSpec, filter?: FilterNode) {
      const rows = table(model).filter((row) => (filter ? matches(row, filter) : true));
      const groups = new Map<string, { key: ScalarValue; rows: Row[] }>();
      for (const row of rows) {
        const key = row[spec.groupBy] as ScalarValue;
        const bucket = groups.get(String(key)) ?? { key, rows: [] };
        bucket.rows.push(row);
        groups.set(String(key), bucket);
      }

      const numbers = (bucketRows: Row[], field: string): number[] =>
        bucketRows
          .map((row) => row[field])
          .filter((value): value is number => typeof value === 'number');

      const reduce = (
        bucketRows: Row[],
        fields: string[] | undefined,
        fn: (values: number[]) => number | null,
      ): Record<string, number | null> | undefined =>
        fields?.length
          ? Object.fromEntries(fields.map((field) => [field, fn(numbers(bucketRows, field))]))
          : undefined;

      return [...groups.values()].map(({ key, rows: bucketRows }) => {
        const bucket: AggregateBucket = { key };
        if (spec.count) bucket.count = bucketRows.length;
        const sum = reduce(bucketRows, spec.sum, (values) => values.reduce((a, b) => a + b, 0));
        const avg = reduce(bucketRows, spec.avg, (values) =>
          values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
        );
        const min = reduce(bucketRows, spec.min, (values) => (values.length ? Math.min(...values) : null));
        const max = reduce(bucketRows, spec.max, (values) => (values.length ? Math.max(...values) : null));
        if (sum) bucket.sum = sum;
        if (avg) bucket.avg = avg;
        if (min) bucket.min = min;
        if (max) bucket.max = max;
        return bucket;
      });
    },

    async transaction(fn) {
      return fn(repo);
    },
  };
  return repo;
}
