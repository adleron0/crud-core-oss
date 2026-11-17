import {
  Body,
  InjectionToken,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Type,
} from '@nestjs/common';

import { CrudService } from '../core/crud-service';
import { EntityDefinition, ExposedOp, INHERENTLY_PUBLIC_OPS } from '../core/entity-rules';

type Query1 = Record<string, string | string[] | undefined>;

export interface CrudControllerOptions {
  /** Token de injeção do CrudService. Default: a própria classe. */
  serviceToken?: InjectionToken;
  /** Prefixo antes do segmento da entidade (ex.: 'api/v1'). */
  prefix?: string;
  /**
   * Decorators extras por op — interceptors de upload, cache, throttle. É o
   * ponto onde os "concerns fora do núcleo" entram, sem o núcleo saber deles.
   */
  decorators?: Partial<Record<ExposedOp, MethodDecorator[]>>;
  /** Aplicado às ops de `publicOps` (ex.: o @Public() que o AuthGuard do projeto lê). */
  publicDecorator?: MethodDecorator;
  /**
   * Providers injetados como PROPRIEDADES do controller gerado — para
   * decorators do projeto que dependem de `this.algo` (ex.: um CacheEvict que
   * lê `this.cacheService`). `{ cacheService: CacheService }`.
   */
  properties?: Record<string, InjectionToken>;
}

/**
 * Fábrica de controller por entidade.
 *
 * NÃO existe classe base com rotas decoradas. O controller é montado
 * programaticamente e só ganha método para as ops do `expose` — operação não
 * exposta não vira rota, então o 404 vem de ela não existir, não de uma
 * checagem que alguém pode esquecer de escrever.
 *
 * Essa é a diferença estrutural para o `GenericController` herdado: lá, o
 * `POST /:entidade/upsert` decorado na base aparecia em todos os controllers
 * filhos, sem permissão, porque ninguém o redeclarava.
 *
 * Contrato de rotas: `PUT /:id` para update e
 * `PATCH active|inactive/:id` para restore/archive.
 */
export function createCrudController(
  def: EntityDefinition,
  options: CrudControllerOptions = {},
): Type<unknown> {
  class CrudController {
    constructor(readonly service: CrudService<unknown>) {}
  }
  Inject(options.serviceToken ?? CrudService)(CrudController, undefined, 0);

  for (const [property, token] of Object.entries(options.properties ?? {})) {
    Inject(token)(CrudController.prototype, property);
  }

  const pascal = def.rules.entity.replace(/(^|[-_])(\w)/g, (_, __, char: string) => char.toUpperCase());
  Object.defineProperty(CrudController, 'name', { value: `${pascal}CrudController` });

  const proto = CrudController.prototype as unknown as Record<string, unknown>;

  const register = (
    op: ExposedOp,
    route: (path?: string) => MethodDecorator,
    path: string | undefined,
    handler: (...args: never[]) => unknown,
    params: Array<(target: object, key: string, index: number) => void>,
    statusCode?: number,
  ): void => {
    if (!def.rules.expose.includes(op)) return;

    Object.defineProperty(proto, op, { value: handler, writable: true, configurable: true });
    let descriptor = Object.getOwnPropertyDescriptor(proto, op)!;
    params.forEach((decorate, index) => decorate(proto, op, index));
    // Decorators que TROCAM o método (wrappers como CacheEvict) devolvem ou
    // mutam o descritor: o resultado precisa voltar ao protótipo antes de a
    // rota ser registrada, senão a metadata de rota fica numa função órfã e a
    // rota simplesmente não existe.
    for (const decorate of options.decorators?.[op] ?? []) {
      descriptor = (decorate(proto, op, descriptor) as PropertyDescriptor | void) || descriptor;
    }
    Object.defineProperty(proto, op, descriptor);
    if (
      options.publicDecorator &&
      (INHERENTLY_PUBLIC_OPS.has(op) || (def.rules.publicOps as ExposedOp[] | undefined)?.includes(op))
    ) {
      options.publicDecorator(proto, op, descriptor);
    }
    if (statusCode !== undefined) HttpCode(statusCode)(proto, op, descriptor);
    (path === undefined ? route() : route(path))(proto, op, descriptor);
  };

  const id = () => Param('id');
  const body = () => Body();
  const query = () => Query();
  const req = () => Req();

  register('list', Get, undefined, function (this: CrudController, q: Query1, request: unknown) {
    return this.service.list(def, q, request);
  }, [query(), req()]);

  // Rota estática antes da paramétrica: `POST /upsert` não pode ser engolida
  // por um eventual `POST /:id`.
  register('upsert', Post, 'upsert', function (this: CrudController, payload: unknown, request: unknown) {
    return this.service.upsert(def, payload, request);
  }, [body(), req()], 200);

  register('create', Post, undefined, function (this: CrudController, payload: unknown, request: unknown) {
    return this.service.create(def, payload, request);
  }, [body(), req()]);

  // Estáticas antes de `:id`: "public" e "self" seriam lidos como id.
  register('listPublic', Get, 'public', function (this: CrudController, q: Query1, request: unknown) {
    return this.service.listPublic(def, q, request);
  }, [query(), req()]);

  // `self` antes de `:id`: senão "self" seria lido como id.
  register('getSelf', Get, 'self', function (this: CrudController, request: unknown) {
    return this.service.getSelf(def, request);
  }, [req()]);

  register('updateSelf', Put, 'self', function (this: CrudController, payload: unknown, request: unknown) {
    return this.service.updateSelf(def, payload, request);
  }, [body(), req()]);

  register('restore', Patch, 'active/:id', function (this: CrudController, param: string, request: unknown) {
    return this.service.restore(def, param, request);
  }, [id(), req()], 200);

  register('archive', Patch, 'inactive/:id', function (this: CrudController, param: string, request: unknown) {
    return this.service.archive(def, param, request);
  }, [id(), req()], 200);

  register('update', Put, ':id', function (this: CrudController, param: string, payload: unknown, request: unknown) {
    return this.service.update(def, param, payload, request);
  }, [id(), body(), req()]);

  register('getById', Get, ':id', function (this: CrudController, param: string, request: unknown) {
    return this.service.getById(def, param, request);
  }, [id(), req()]);

  Controller(options.prefix ? `${options.prefix}/${def.rules.entity}` : def.rules.entity)(CrudController);
  return CrudController;
}
