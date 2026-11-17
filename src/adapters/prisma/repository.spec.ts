import { describe, expect, it, vi } from 'vitest';

import { FilterNode } from '../../query/filter-ir';
import { PrismaClientLike, prismaRepository } from './repository';

function fakeClient() {
  const calls: Record<string, unknown[]> = {};
  const record = (name: string) =>
    vi.fn(async (args: unknown) => {
      (calls[name] ??= []).push(args);
      return name === 'findMany' ? [] : name === 'count' ? 0 : { id: 1 };
    });

  const delegate = {
    findMany: record('findMany'),
    findFirst: record('findFirst'),
    count: record('count'),
    create: record('create'),
    update: record('update'),
    upsert: record('upsert'),
    groupBy: vi.fn(async () => [
      { status: 'pending', _count: 2, _sum: { value: 30 } },
    ]),
  };

  const client = {
    customer: delegate,
    $transaction: async <T>(fn: (tx: PrismaClientLike) => Promise<T>) => fn(client),
  } as unknown as PrismaClientLike;

  return { client, delegate, calls };
}

const filter: FilterNode = { kind: 'cmp', path: ['name'], operator: 'eq', value: 'ana' };

describe('prismaRepository', () => {
  it('findMany traduz filtro, ordenação e paginação', async () => {
    const { client, delegate } = fakeClient();
    await prismaRepository(client).findMany('customer', {
      filter,
      orderBy: [{ path: ['name'], direction: 'asc' }],
      skip: 10,
      take: 20,
    });
    expect(delegate.findMany).toHaveBeenCalledWith({
      where: { name: 'ana' },
      orderBy: [{ name: 'asc' }],
      skip: 10,
      take: 20,
    });
  });

  // Contrato `limit=all`: skip/take nulos significam "sem paginação", e não
  // `take: 0` — que devolveria zero linhas.
  it('skip/take nulos não viram argumentos', async () => {
    const { client, delegate } = fakeClient();
    await prismaRepository(client).findMany('customer', {
      filter: undefined,
      orderBy: [],
      skip: null,
      take: null,
    });
    expect(delegate.findMany).toHaveBeenCalledWith({ where: undefined, orderBy: [] });
  });

  it('count usa o mesmo filtro', async () => {
    const { client, delegate } = fakeClient();
    await prismaRepository(client).count('customer', filter);
    expect(delegate.count).toHaveBeenCalledWith({ where: { name: 'ana' } });
  });

  it('findOne usa findFirst e repassa include', async () => {
    const { client, delegate } = fakeClient();
    await prismaRepository(client).findOne('customer', filter, { seller: true });
    expect(delegate.findFirst).toHaveBeenCalledWith({
      where: { name: 'ana' },
      include: { seller: true },
    });
  });

  it('update aceita where com escopo além da pk', async () => {
    const { client, delegate } = fakeClient();
    const byIdAndScope: FilterNode = {
      kind: 'and',
      nodes: [
        { kind: 'cmp', path: ['id'], operator: 'eq', value: 1 },
        { kind: 'cmp', path: ['companyId'], operator: 'eq', value: 7 },
      ],
    };
    await prismaRepository(client).update('customer', { filter: byIdAndScope, data: { name: 'x' } });
    // fails-without: com compileFilter o where saía como { AND: [...] }, que o
    // Prisma recusa em update (WhereUniqueInput exige a pk no nível de cima).
    expect(delegate.update).toHaveBeenCalledWith({
      where: { id: 1, companyId: 7 },
      data: { name: 'x' },
    });
  });

  it('upsert semeia o create com a chave do filtro', async () => {
    const { client, delegate } = fakeClient();
    const byKey: FilterNode = { kind: 'cmp', path: ['cnpj'], operator: 'eq', value: '123' };
    await prismaRepository(client).upsert('customer', { filter: byKey, data: { name: 'x' } });
    expect(delegate.upsert).toHaveBeenCalledWith({
      where: { cnpj: '123' },
      create: { cnpj: '123', name: 'x' },
      update: { name: 'x' },
    });
  });

  it('aggregate monta o groupBy do Prisma e volta em IR', async () => {
    const { client, delegate } = fakeClient();
    const buckets = await prismaRepository(client).aggregate(
      'customer',
      { groupBy: 'status', count: true, sum: ['value'] },
      filter,
    );
    expect(delegate.groupBy).toHaveBeenCalledWith({
      by: ['status'],
      where: { name: 'ana' },
      _count: true,
      _sum: { value: true },
    });
    expect(buckets).toEqual([{ key: 'pending', count: 2, sum: { value: 30 } }]);
  });

  it('aggregate omite blocos de operação não pedidos', async () => {
    const { client, delegate } = fakeClient();
    await prismaRepository(client).aggregate('customer', { groupBy: 'status', count: true });
    expect(delegate.groupBy).toHaveBeenCalledWith({
      by: ['status'],
      where: undefined,
      _count: true,
    });
  });

  it('transaction devolve repositório ligado à transação', async () => {
    const { client, delegate } = fakeClient();
    await prismaRepository(client).transaction(async (tx) => tx.create('customer', { name: 'x' }));
    expect(delegate.create).toHaveBeenCalledWith({ data: { name: 'x' } });
  });

  it('delegate inexistente é erro de programação, não de request', async () => {
    const { client } = fakeClient();
    await expect(prismaRepository(client).count('inexistente')).rejects.toThrow(/delegate/);
  });
});
