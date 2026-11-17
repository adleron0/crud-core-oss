import { ScalarValue } from './filter-ir';

export type AggregateOperation = 'sum' | 'avg' | 'min' | 'max';

/** Especificação NEUTRA de agregação — sem sintaxe de ORM, como o filtro. */
export interface AggregateSpec {
  groupBy: string;
  count: boolean;
  sum?: string[];
  avg?: string[];
  min?: string[];
  max?: string[];
}

export interface AggregateBucket {
  key: ScalarValue;
  count?: number;
  sum?: Record<string, number | null>;
  avg?: Record<string, number | null>;
  min?: Record<string, ScalarValue>;
  max?: Record<string, ScalarValue>;
}

export const AGGREGATE_OPERATIONS: AggregateOperation[] = ['sum', 'avg', 'min', 'max'];

/**
 * Formato: `campo:count:sum:valor,desconto:avg:nota`.
 * O primeiro segmento é o campo de agrupamento; o resto são operações, e cada
 * operação que não seja `count` é seguida dos campos em CSV.
 */
export function parseAggregateSpec(raw: string): AggregateSpec {
  const parts = raw.split(':').map((part) => part.trim()).filter(Boolean);
  const groupBy = parts.shift();
  if (!groupBy) {
    throw new Error('agregação sem campo de agrupamento');
  }

  const spec: AggregateSpec = { groupBy, count: false };
  while (parts.length) {
    const token = parts.shift()!;
    if (token === 'count') {
      spec.count = true;
      continue;
    }
    if (!AGGREGATE_OPERATIONS.includes(token as AggregateOperation)) {
      throw new Error(`operação de agregação desconhecida: '${token}'`);
    }
    const fields = parts.shift();
    if (!fields) {
      throw new Error(`operação '${token}' sem campos`);
    }
    spec[token as AggregateOperation] = fields.split(',').map((field) => field.trim()).filter(Boolean);
  }

  // Sem operação declarada, o legado assume contagem.
  if (!spec.count && !spec.sum && !spec.avg && !spec.min && !spec.max) spec.count = true;
  return spec;
}

/** Campos citados pela spec — o que precisa passar pela allowlist. */
export function aggregateFields(spec: AggregateSpec): string[] {
  return [
    spec.groupBy,
    ...(spec.sum ?? []),
    ...(spec.avg ?? []),
    ...(spec.min ?? []),
    ...(spec.max ?? []),
  ];
}

/** Formato de resposta herdado: `{ [valorDoGrupo]: { _count, _sum, ... } }`. */
export function toLegacyShape(buckets: AggregateBucket[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const bucket of buckets) {
    result[String(bucket.key)] = {
      ...(bucket.count !== undefined ? { _count: bucket.count } : {}),
      ...(bucket.sum ? { _sum: bucket.sum } : {}),
      ...(bucket.avg ? { _avg: bucket.avg } : {}),
      ...(bucket.min ? { _min: bucket.min } : {}),
      ...(bucket.max ? { _max: bucket.max } : {}),
    };
  }
  return result;
}
