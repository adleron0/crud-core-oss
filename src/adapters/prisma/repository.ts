import { FindManyArgs, Repository, Row, WriteArgs } from '../../ports/repository';
import { AggregateBucket, AggregateSpec } from '../../query/aggregate';
import { FilterNode } from '../../query/filter-ir';
import { compileFilter, compileOrderBy, compileUniqueWhere } from './compile-filter';
import { mapPrismaError } from './map-error';

interface PrismaDelegate {
  findMany(args: Record<string, unknown>): Promise<Row[]>;
  findFirst(args: Record<string, unknown>): Promise<Row | null>;
  count(args: Record<string, unknown>): Promise<number>;
  create(args: Record<string, unknown>): Promise<Row>;
  update(args: Record<string, unknown>): Promise<Row>;
  upsert(args: Record<string, unknown>): Promise<Row>;
  groupBy(args: Record<string, unknown>): Promise<Row[]>;
}

export interface PrismaClientLike {
  $transaction<T>(fn: (tx: PrismaClientLike) => Promise<T>): Promise<T>;
}

function delegateOf(client: PrismaClientLike, model: string): PrismaDelegate {
  const delegate = (client as unknown as Record<string, PrismaDelegate | undefined>)[model];
  if (!delegate || typeof delegate.findMany !== 'function') {
    // Erro de programação, não de request: modelo derivado do schema sempre
    // existe no client. Se não existe, a declaração e o client divergiram.
    throw new Error(`PrismaRepository: delegate '${model}' não existe no client`);
  }
  return delegate;
}

/**
 * Adapter Prisma. Recebe IR e traduz — junto com `compile-filter.ts`, é a
 * única parte do pacote que conhece Prisma.
 *
 * `update`/`upsert` exigem que o filtro contenha a PK: o Prisma aceita
 * condições extras no `where` (escopo de tenant, por exemplo) desde que haja
 * um campo único. O serviço garante isso ao resolver o registro antes.
 */
async function translated<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw mapPrismaError(error);
  }
}

export function prismaRepository(client: PrismaClientLike): Repository {
  const repo: Repository = {
    async findMany(model, args: FindManyArgs) {
      return translated(() => delegateOf(client, model).findMany({
        where: compileFilter(args.filter),
        orderBy: compileOrderBy(args.orderBy),
        ...(args.skip !== null ? { skip: args.skip } : {}),
        ...(args.take !== null ? { take: args.take } : {}),
        ...(args.include ? { include: args.include } : {}),
      }));
    },

    async count(model, filter?: FilterNode) {
      return translated(() => delegateOf(client, model).count({ where: compileFilter(filter) }));
    },

    async findOne(model, filter, include) {
      return translated(() => delegateOf(client, model).findFirst({
        where: compileFilter(filter),
        ...(include ? { include } : {}),
      }));
    },

    async create(model, data) {
      return translated(() => delegateOf(client, model).create({ data }));
    },

    async update(model, args: WriteArgs) {
      return translated(() => delegateOf(client, model).update({
        where: compileUniqueWhere(args.filter),
        data: args.data,
      }));
    },

    async upsert(model, args: WriteArgs) {
      const where = compileUniqueWhere(args.filter);
      return translated(() =>
        delegateOf(client, model).upsert({
          where,
          create: { ...where, ...args.data },
          update: args.data,
        }),
      );
    },

    async aggregate(model, spec: AggregateSpec, filter?: FilterNode) {
      const select = (fields: string[] | undefined) =>
        fields?.length ? Object.fromEntries(fields.map((field) => [field, true])) : undefined;

      const rows = await delegateOf(client, model).groupBy({
        by: [spec.groupBy],
        where: compileFilter(filter),
        ...(spec.count ? { _count: true } : {}),
        ...(select(spec.sum) ? { _sum: select(spec.sum) } : {}),
        ...(select(spec.avg) ? { _avg: select(spec.avg) } : {}),
        ...(select(spec.min) ? { _min: select(spec.min) } : {}),
        ...(select(spec.max) ? { _max: select(spec.max) } : {}),
      });

      return rows.map((row) => {
        const bucket: AggregateBucket = { key: row[spec.groupBy] as AggregateBucket['key'] };
        if (row._count !== undefined) bucket.count = row._count as number;
        if (row._sum) bucket.sum = row._sum as Record<string, number | null>;
        if (row._avg) bucket.avg = row._avg as Record<string, number | null>;
        if (row._min) bucket.min = row._min as Record<string, never>;
        if (row._max) bucket.max = row._max as Record<string, never>;
        return bucket;
      });
    },

    async transaction(fn) {
      return client.$transaction((tx) => fn(prismaRepository(tx)));
    },
  };
  return repo;
}
