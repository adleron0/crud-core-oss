import { CrudError } from '../../core/crud-error';

interface PrismaKnownError {
  code?: string;
  meta?: { target?: string[] | string; field_name?: string; cause?: string };
  message?: string;
}

function firstTarget(meta: PrismaKnownError['meta']): string | undefined {
  const target = meta?.target;
  if (Array.isArray(target)) return target[0];
  if (typeof target === 'string') return target;
  return meta?.field_name;
}

/**
 * Traduz erro do Prisma para `CrudError`. Sem isto, violação de unique vira
 * 500, ou pior: devolver a mensagem crua do Prisma vaza nome de constraint
 * para o cliente.
 */
export function mapPrismaError(error: unknown): unknown {
  const known = error as PrismaKnownError & { name?: string };
  // Tipo/forma inválida do argumento (ex.: string num Int): é erro do pedido,
  // não do servidor. A mensagem crua do Prisma não vai ao cliente.
  if (known?.name === 'PrismaClientValidationError') {
    const field = /Argument `(\w+)`/.exec(String(known.message ?? ''))?.[1];
    return new CrudError('VALIDATION_FAILED', field ? `Valor inválido em '${field}'` : 'Dados inválidos', field);
  }
  if (!known || typeof known.code !== 'string') return error;

  switch (known.code) {
    case 'P2002':
      return new CrudError('CONFLICT', 'Registro já existe', firstTarget(known.meta));
    case 'P2025':
      return new CrudError('NOT_FOUND', 'Registro não encontrado');
    case 'P2003':
      return new CrudError('VALIDATION_FAILED', 'Referência inválida', firstTarget(known.meta));
    case 'P2000':
      return new CrudError('VALIDATION_FAILED', 'Valor excede o tamanho da coluna', firstTarget(known.meta));
    case 'P2023':
      return new CrudError('VALIDATION_FAILED', 'Valor malformado para a coluna');
    default:
      return error;
  }
}
