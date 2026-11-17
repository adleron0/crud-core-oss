import { FilterNode } from './filter-ir';

export type SortDirection = 'asc' | 'desc';

export interface ParsedQuery {
  filter?: FilterNode;
  orderBy: Array<{ path: string[]; direction: SortDirection }>;
  /** 1-based. */
  page: number;
  /** `'all'` preserva o contrato `limit=all`. */
  limit: number | 'all';
}
