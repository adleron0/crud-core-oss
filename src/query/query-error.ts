export type QueryErrorReason =
  | 'not_allowed'
  | 'unknown_operator'
  | 'operator_not_applicable'
  | 'malformed'
  | 'pagination_out_of_range'
  | 'too_many_conditions';

/**
 * Violação de filtro NUNCA é ignorada em silêncio — é sempre este erro, com o
 * campo apontado. Descartar filtro inválido com `console.error` devolveria
 * resultado errado sem ninguém perceber.
 */
export class QueryParseError extends Error {
  readonly field: string;
  readonly reason: QueryErrorReason;

  constructor(field: string, reason: QueryErrorReason, message?: string) {
    super(message ?? `Filtro inválido em "${field}": ${reason}`);
    this.name = 'QueryParseError';
    this.field = field;
    this.reason = reason;
  }
}
