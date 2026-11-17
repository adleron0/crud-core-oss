import 'reflect-metadata';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { EntityRules, defineEntity } from '../core/entity-rules';
import { fakeSchema } from '../testing/fake-schema';
import { createCrudController } from './crud-controller.factory';

const schema = fakeSchema({
  Customer: {
    fields: {
      id: { type: 'number', isId: true, isGenerated: true },
      companyId: { type: 'number' },
      name: {},
      cnpj: { isUnique: true },
      inactiveAt: { type: 'date', nullable: true },
    },
  },
});

const full: EntityRules = {
  entity: 'customer',
  model: 'Customer',
  expose: ['list', 'getById', 'create', 'update', 'archive', 'restore', 'upsert'],
  permissions: {
    list: 'l', getById: 'l', create: 'c', update: 'u', archive: 'a', upsert: 'up',
  },
  upsertKey: 'cnpj',
  filterable: ['name'],
  sortable: ['name'],
  softDelete: { field: 'inactiveAt' },
};

const define = (rules: Partial<EntityRules> = {}) =>
  defineEntity({ ...full, ...rules }, { schema, scopeField: 'companyId' });

const routeOf = (controller: object, method: string) => ({
  path: Reflect.getMetadata(PATH_METADATA, (controller as never)[method]),
  method: Reflect.getMetadata(METHOD_METADATA, (controller as never)[method]),
});

describe('createCrudController', () => {
  it('registra as rotas no contrato padrão', () => {
    const proto = createCrudController(define()).prototype;
    expect(routeOf(proto, 'list')).toEqual({ path: '/', method: RequestMethod.GET });
    expect(routeOf(proto, 'getById')).toEqual({ path: ':id', method: RequestMethod.GET });
    expect(routeOf(proto, 'create')).toEqual({ path: '/', method: RequestMethod.POST });
    expect(routeOf(proto, 'update')).toEqual({ path: ':id', method: RequestMethod.PUT });
    expect(routeOf(proto, 'archive')).toEqual({ path: 'inactive/:id', method: RequestMethod.PATCH });
    expect(routeOf(proto, 'restore')).toEqual({ path: 'active/:id', method: RequestMethod.PATCH });
    expect(routeOf(proto, 'upsert')).toEqual({ path: 'upsert', method: RequestMethod.POST });
  });

  // A diferença estrutural para a classe base herdada: a rota não existe.
  it('op fora do expose não vira método no controller', () => {
    const proto = createCrudController(
      define({ expose: ['list'], permissions: { list: 'l' }, upsertKey: undefined }),
    ).prototype as Record<string, unknown>;
    expect(typeof proto.list).toBe('function');
    expect(proto.upsert).toBeUndefined();
    expect(proto.create).toBeUndefined();
    expect(proto.update).toBeUndefined();
    expect(proto.archive).toBeUndefined();
  });

  it('listPublic vira GET /public antes de :id, marcado como público', () => {
    const marks: string[] = [];
    const proto = createCrudController(
      define({ expose: ['list', 'getById', 'listPublic'], permissions: { list: 'l', getById: 'l' }, upsertKey: undefined }),
      { publicDecorator: (_t, key) => { marks.push(String(key)); } },
    ).prototype;
    expect(routeOf(proto, 'listPublic')).toEqual({ path: 'public', method: RequestMethod.GET });
    expect(marks).toEqual(['listPublic']);
    const names = Object.getOwnPropertyNames(proto);
    expect(names.indexOf('listPublic')).toBeLessThan(names.indexOf('getById'));
  });

  it('self é registrado antes de :id e sem permissão', () => {
    const proto = createCrudController(
      define({ expose: ['getById', 'getSelf', 'updateSelf'], permissions: { getById: 'l' }, upsertKey: undefined, selfRestricted: [] }),
    ).prototype;
    expect(routeOf(proto, 'getSelf')).toEqual({ path: 'self', method: RequestMethod.GET });
    expect(routeOf(proto, 'updateSelf')).toEqual({ path: 'self', method: RequestMethod.PUT });
    const names = Object.getOwnPropertyNames(proto).filter((n) => n !== 'constructor');
    expect(names.indexOf('getSelf')).toBeLessThan(names.indexOf('getById'));
  });

  it('aplica decorators por op e o marcador de público', () => {
    const marks: string[] = [];
    const mark = (tag: string): MethodDecorator => (_t, key) => { marks.push(`${tag}:${String(key)}`); };
    createCrudController(define({ publicOps: ['list'], permissions: { getById: 'l', create: 'c', update: 'u', archive: 'a', upsert: 'up' } }), {
      decorators: { create: [mark('upload')], list: [mark('cache')] },
      publicDecorator: mark('public'),
    });
    expect(marks.sort()).toEqual(['cache:list', 'public:list', 'upload:create']);
  });

  // fails-without: um decorator de cache que troca descriptor.value; sem
  // regravar o descritor, PUT /classes/:id não existia (404 do Express).
  it('decorator que troca o método mantém a rota e o wrapper é o que roda', async () => {
    const calls: string[] = [];
    const wrap: MethodDecorator = (_t, _k, d: PropertyDescriptor) => {
      const original = d.value;
      d.value = async function (this: unknown, ...args: unknown[]) { calls.push('wrapper'); return original.apply(this, args); };
      return d;
    };
    const Controller = createCrudController(define(), { decorators: { update: [wrap] } });
    expect(routeOf(Controller.prototype, 'update')).toEqual({ path: ':id', method: RequestMethod.PUT });
    const service = { update: vi.fn(async () => ({ ok: true })) };
    const instance = new (Controller as new (s: unknown) => { update: (...a: unknown[]) => Promise<unknown> })(service);
    await instance.update('1', {}, {});
    expect(calls).toEqual(['wrapper']);
    expect(service.update).toHaveBeenCalled();
  });

  it('properties injeta providers como propriedades do controller', () => {
    const Controller = createCrudController(define(), { properties: { cacheService: 'CACHE' } });
    const props = Reflect.getMetadata('self:properties_metadata', Controller) as Array<{ key: string; type: unknown }>;
    expect(props).toEqual([{ key: 'cacheService', type: 'CACHE' }]);
  });

  it('o path do controller usa o segmento da entidade', () => {
    const controller = createCrudController(define());
    expect(Reflect.getMetadata(PATH_METADATA, controller)).toBe('customer');
  });

  it('aceita prefixo', () => {
    const controller = createCrudController(define(), { prefix: 'api/v1' });
    expect(Reflect.getMetadata(PATH_METADATA, controller)).toBe('api/v1/customer');
  });

  it('nomeia a classe pela entidade (rastreável no log do Nest)', () => {
    expect(createCrudController(define()).name).toBe('CustomerCrudController');
    expect(createCrudController(define({ entity: 'customer-contacts' })).name)
      .toBe('CustomerContactsCrudController');
  });

  it('cada handler delega ao serviço com a definição da entidade', async () => {
    const def = define();
    const service = {
      list: vi.fn(), getById: vi.fn(), create: vi.fn(),
      update: vi.fn(), archive: vi.fn(), restore: vi.fn(), upsert: vi.fn(),
    };
    interface Handlers {
      list(query: unknown, request: unknown): Promise<unknown>;
      getById(id: string, request: unknown): Promise<unknown>;
      create(body: unknown, request: unknown): Promise<unknown>;
      update(id: string, body: unknown, request: unknown): Promise<unknown>;
      archive(id: string, request: unknown): Promise<unknown>;
      restore(id: string, request: unknown): Promise<unknown>;
      upsert(body: unknown, request: unknown): Promise<unknown>;
    }
    const Controller = createCrudController(def);
    const instance = new (Controller as new (s: unknown) => Handlers)(service);
    const request = { user: 1 };

    await instance.list({ page: '0' }, request);
    await instance.getById('7', request);
    await instance.create({ name: 'x' }, request);
    await instance.update('7', { name: 'y' }, request);
    await instance.archive('7', request);
    await instance.restore('7', request);
    await instance.upsert({ cnpj: '1' }, request);

    expect(service.list).toHaveBeenCalledWith(def, { page: '0' }, request);
    expect(service.getById).toHaveBeenCalledWith(def, '7', request);
    expect(service.create).toHaveBeenCalledWith(def, { name: 'x' }, request);
    expect(service.update).toHaveBeenCalledWith(def, '7', { name: 'y' }, request);
    expect(service.archive).toHaveBeenCalledWith(def, '7', request);
    expect(service.restore).toHaveBeenCalledWith(def, '7', request);
    expect(service.upsert).toHaveBeenCalledWith(def, { cnpj: '1' }, request);
  });
});
