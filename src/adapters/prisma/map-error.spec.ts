import { describe, expect, it } from 'vitest';

import { CrudError } from '../../core/crud-error';
import { mapPrismaError } from './map-error';

const prismaError = (code: string, meta?: unknown) => ({ code, meta, message: 'prisma' });

describe('mapPrismaError', () => {
  it('P2002 (unique) vira 409 com o campo', () => {
    const error = mapPrismaError(prismaError('P2002', { target: ['cnpj', 'companyId'] })) as CrudError;
    expect(error).toBeInstanceOf(CrudError);
    expect(error).toMatchObject({ code: 'CONFLICT', status: 409, field: 'cnpj' });
  });

  it('P2002 com target string', () => {
    expect(mapPrismaError(prismaError('P2002', { target: 'email' }))).toMatchObject({ field: 'email' });
  });

  it('P2025 vira 404', () => {
    expect(mapPrismaError(prismaError('P2025'))).toMatchObject({ code: 'NOT_FOUND', status: 404 });
  });

  it('P2003 (FK) vira 400 com o campo', () => {
    expect(mapPrismaError(prismaError('P2003', { field_name: 'rankId' }))).toMatchObject({
      code: 'VALIDATION_FAILED',
      field: 'rankId',
    });
  });

  it('P2000 e P2023 viram 400', () => {
    expect(mapPrismaError(prismaError('P2000'))).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(mapPrismaError(prismaError('P2023'))).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('PrismaClientValidationError vira 400 com o campo, sem a mensagem crua', () => {
    const error = { name: 'PrismaClientValidationError', message: 'Invalid ... Argument `rankId`: Invalid value provided. Expected Int' };
    expect(mapPrismaError(error)).toMatchObject({ code: 'VALIDATION_FAILED', field: 'rankId', message: "Valor inválido em 'rankId'" });
  });

  // Erro desconhecido atravessa intacto: mascarar tudo como 400 esconderia
  // falha de infraestrutura como se fosse culpa do cliente.
  it('código desconhecido e erro comum atravessam sem tradução', () => {
    const unknown = prismaError('P9999');
    expect(mapPrismaError(unknown)).toBe(unknown);
    const plain = new Error('boom');
    expect(mapPrismaError(plain)).toBe(plain);
  });
});
