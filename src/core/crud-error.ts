export type CrudErrorCode =
  | 'VALIDATION_FAILED'
  | 'FILTER_NOT_ALLOWED'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT';

const STATUS: Record<CrudErrorCode, number> = {
  VALIDATION_FAILED: 400,
  FILTER_NOT_ALLOWED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
};

/**
 * Erro de request, com código de lista fechada. O núcleo não conhece HTTP; o
 * `status` existe para a camada de framework traduzir sem inventar mapeamento.
 */
export class CrudError extends Error {
  readonly code: CrudErrorCode;
  readonly status: number;
  readonly field?: string;

  constructor(code: CrudErrorCode, message: string, field?: string) {
    super(message);
    this.name = 'CrudError';
    this.code = code;
    this.status = STATUS[code];
    if (field !== undefined) this.field = field;
  }
}
