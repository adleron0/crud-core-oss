import { ComparisonNode, FilterNode, ScalarValue } from '../../query/filter-ir';
import { SortDirection } from '../../query/parsed-query';

export type PrismaWhere = Record<string, unknown>;

/** Aninha `{a: {b: value}}` a partir de `['a','b']`. */
function nest(path: string[], leaf: unknown): PrismaWhere {
  return path.reduceRight<unknown>((acc, key) => ({ [key]: acc }), leaf) as PrismaWhere;
}

function condition(node: ComparisonNode): unknown {
  const value = node.value as ScalarValue | ScalarValue[];
  const mode = node.caseInsensitive ? { mode: 'insensitive' as const } : {};

  switch (node.operator) {
    case 'eq':
      return value;
    case 'ne':
      return { not: value };
    case 'contains':
      return { contains: value, ...mode };
    case 'notContains':
      // Tratado em compileNode: o filtro aninhado do `not` não aceita `mode`,
      // então a negação vai como `NOT` no nível do registro.
      return { contains: value, ...mode };
    case 'in':
      return { in: value };
    case 'notIn':
      return { notIn: value };
    case 'gt':
      return { gt: value };
    case 'gte':
      return { gte: value };
    case 'lt':
      return { lt: value };
    case 'lte':
      return { lte: value };
    case 'isNull':
      return null;
    default: {
      const exhaustive: never = node.operator;
      throw new Error(`operador não compilado: ${String(exhaustive)}`);
    }
  }
}

function compileNode(node: FilterNode, offset: number): PrismaWhere {
  if (node.kind === 'cmp') {
    const where = nest(node.path.slice(offset), condition(node));
    return node.operator === 'notContains' ? { NOT: where } : where;
  }
  if (node.kind === 'relation') {
    // O caminho do nó interno é absoluto; dentro do `some` ele passa a ser
    // relativo ao model da relação — daí o offset.
    const inner = compileNode(node.node, offset + node.path.length);
    return nest(node.path.slice(offset), { [node.quantifier]: inner });
  }
  const key = node.kind === 'and' ? 'AND' : 'OR';
  return { [key]: node.nodes.map((child) => compileNode(child, offset)) };
}

/**
 * Compila a IR neutra para o `where` do Prisma. Este é o ÚNICO ponto do
 * pacote que conhece a sintaxe do Prisma — um adapter Sequelize substitui
 * este arquivo e nada mais do núcleo.
 */
export function compileFilter(filter: FilterNode | undefined): PrismaWhere | undefined {
  if (!filter) return undefined;
  return compileNode(filter, 0);
}

export function compileOrderBy(
  orderBy: Array<{ path: string[]; direction: SortDirection }>,
): PrismaWhere[] {
  return orderBy.map((entry) => nest(entry.path, entry.direction));
}

/** Combina condições em AND, ignorando as vazias. */
export function mergeWhere(...parts: Array<PrismaWhere | undefined>): PrismaWhere | undefined {
  const kept = parts.filter((part): part is PrismaWhere => Boolean(part) && Object.keys(part!).length > 0);
  if (kept.length === 0) return undefined;
  if (kept.length === 1) return kept[0];
  return { AND: kept };
}

/**
 * `where` para update/upsert. O Prisma exige o campo único NO NÍVEL DE CIMA
 * (`{ id: 1, companyId: 7 }`); a mesma condição embrulhada em `AND` é recusada
 * como WhereUniqueInput inválido. Achata um AND de igualdades simples num
 * objeto só; qualquer outra forma não serve para escrita por chave.
 */
export function compileUniqueWhere(filter: FilterNode): PrismaWhere {
  const nodes = filter.kind === 'and' ? filter.nodes : [filter];
  const where: PrismaWhere = {};
  for (const node of nodes) {
    if (node.kind !== 'cmp' || node.operator !== 'eq' || node.path.length !== 1) {
      throw new Error('compileUniqueWhere: escrita por chave aceita só igualdades simples');
    }
    const field = node.path[0]!;
    if (field in where) throw new Error(`compileUniqueWhere: campo '${field}' repetido`);
    where[field] = node.value;
  }
  return where;
}
