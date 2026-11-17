import { ArgumentsHost } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { CrudError } from '../core/crud-error';
import { CrudErrorFilter } from './crud-error.filter';

function hostWith(response: unknown): ArgumentsHost {
  return { switchToHttp: () => ({ getResponse: () => response }) } as unknown as ArgumentsHost;
}

describe('CrudErrorFilter', () => {
  it('traduz o código para status e inclui o campo', () => {
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    new CrudErrorFilter().catch(
      new CrudError('VALIDATION_FAILED', "Campo 'companyId' não é gravável", 'companyId'),
      hostWith({ status }),
    );
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({
      statusCode: 400,
      code: 'VALIDATION_FAILED',
      message: "Campo 'companyId' não é gravável",
      field: 'companyId',
    });
  });

  it('omite o campo quando não há', () => {
    const json = vi.fn();
    new CrudErrorFilter().catch(
      new CrudError('NOT_FOUND', 'customer não encontrado'),
      hostWith({ status: () => ({ json }) }),
    );
    expect(json).toHaveBeenCalledWith({
      statusCode: 404,
      code: 'NOT_FOUND',
      message: 'customer não encontrado',
    });
  });

  it('funciona com a API do Fastify', () => {
    const send = vi.fn();
    const code = vi.fn(() => ({ send }));
    new CrudErrorFilter().catch(new CrudError('FORBIDDEN', 'negado'), hostWith({ code }));
    expect(code).toHaveBeenCalledWith(403);
    expect(send).toHaveBeenCalledWith({ statusCode: 403, code: 'FORBIDDEN', message: 'negado' });
  });
});
