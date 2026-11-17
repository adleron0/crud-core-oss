import { AggregateBucket, AggregateSpec } from '../query/aggregate';
import { FilterNode } from '../query/filter-ir';
import { SortDirection } from '../query/parsed-query';

export type Row = Record<string, unknown>;

export interface FindManyArgs {
  filter?: FilterNode;
  orderBy: Array<{ path: string[]; direction: SortDirection }>;
  /** `null` = sem paginação (contrato `limit=all`). */
  skip: number | null;
  take: number | null;
  include?: Record<string, unknown>;
}

export interface WriteArgs {
  filter: FilterNode;
  data: Row;
}

/**
 * Porta de DADOS. Recebe IR neutra e é responsabilidade do adapter traduzir
 * para a linguagem do ORM. Nenhuma sintaxe de ORM atravessa esta interface —
 * é o que torna um segundo adapter viável sem reescrever o núcleo.
 */
export interface Repository {
  findMany(model: string, args: FindManyArgs): Promise<Row[]>;
  count(model: string, filter?: FilterNode): Promise<number>;
  findOne(model: string, filter: FilterNode, include?: Record<string, unknown>): Promise<Row | null>;
  create(model: string, data: Row): Promise<Row>;
  update(model: string, args: WriteArgs): Promise<Row>;
  upsert(model: string, args: WriteArgs): Promise<Row>;
  /** Agrupa e agrega. Nem todo adapter precisa suportar — mas o núcleo pede em IR. */
  aggregate(model: string, spec: AggregateSpec, filter?: FilterNode): Promise<AggregateBucket[]>;
  /** Executa `fn` numa transação; o repositório passado a `fn` participa dela. */
  transaction<T>(fn: (repo: Repository) => Promise<T>): Promise<T>;
}
