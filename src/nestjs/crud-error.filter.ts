import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';

import { CrudError } from '../core/crud-error';

/**
 * Traduz `CrudError` para HTTP. O núcleo não conhece HTTP; o mapeamento vive
 * aqui, num lugar só, em vez de espalhado por controller.
 */
@Catch(CrudError)
export class CrudErrorFilter implements ExceptionFilter {
  catch(error: CrudError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse();
    const body = {
      statusCode: error.status,
      code: error.code,
      message: error.message,
      ...(error.field ? { field: error.field } : {}),
    };
    // Suporta Express (`status().json()`) e Fastify (`code().send()`).
    if (typeof response.status === 'function') response.status(error.status).json(body);
    else response.code(error.status).send(body);
  }
}
