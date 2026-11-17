/**
 * IR de filtro — representação NEUTRA, sem sintaxe de ORM.
 *
 * Esta é a costura que torna multi-ORM viável: o parser produz IR, o adapter
 * compila IR para `where` do Prisma, `Op.*` do Sequelize ou SQL. Se o parser
 * devolvesse `where` de Prisma, o
 * formato vazaria para o serviço, para os hooks e para as regras — e trocar de
 * ORM viraria reescrita.
 */

export type ComparisonOperator =
  | 'eq'
  | 'ne'
  | 'contains'
  | 'notContains'
  | 'in'
  | 'notIn'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'isNull';

export type ScalarValue = string | number | boolean | Date | null;

/** Quantificador de relação to-many. `some` é o default do contrato atual. */
export type Quantifier = 'some' | 'every' | 'none';

export interface ComparisonNode {
  kind: 'cmp';
  /** Caminho até a coluna. `['name']` ou `['trainee', 'name']`. */
  path: string[];
  operator: ComparisonOperator;
  value: ScalarValue | ScalarValue[];
  /** `contains`/`notContains` em texto: comparação sem distinção de caixa. */
  caseInsensitive?: boolean;
}

/**
 * `and` e `or` são tipos SEPARADOS de propósito: um único nó com
 * `kind: 'and' | 'or'` não é união discriminada — o TypeScript não consegue
 * estreitar o resto da união a partir dele, e todo consumidor da IR paga esse
 * preço com cast.
 */
export interface AndNode {
  kind: 'and';
  nodes: FilterNode[];
}

export interface OrNode {
  kind: 'or';
  nodes: FilterNode[];
}

export type LogicalNode = AndNode | OrNode;

/** Filtro aplicado dentro de uma relação to-many (`some`/`every`/`none`). */
export interface RelationNode {
  kind: 'relation';
  path: string[];
  quantifier: Quantifier;
  node: FilterNode;
}

export type FilterNode = ComparisonNode | LogicalNode | RelationNode;

export function and(nodes: FilterNode[]): FilterNode | undefined {
  const kept = nodes.filter(Boolean);
  if (kept.length === 0) return undefined;
  if (kept.length === 1) return kept[0];
  return { kind: 'and', nodes: kept };
}

export function or(nodes: FilterNode[]): FilterNode | undefined {
  const kept = nodes.filter(Boolean);
  if (kept.length === 0) return undefined;
  if (kept.length === 1) return kept[0];
  return { kind: 'or', nodes: kept };
}
