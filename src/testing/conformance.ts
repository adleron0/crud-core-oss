import { describe, expect, it } from 'vitest';

import { FilterNode } from '../query/filter-ir';
import { Repository, Row } from '../ports/repository';

export interface ConformanceHarness {
  /** Nome do adapter, usado no título da suíte. */
  name: string;
  /** Cria o repositório com as linhas de `rows` já carregadas em `model`. */
  seed(model: string, rows: Row[]): Promise<Repository>;
  /** Libera recursos entre casos. */
  teardown?(): Promise<void>;
}

const MODEL = 'conformanceRow';

const ROWS: Row[] = [
  { id: 1, name: 'Ana Paula', price: 10, archivedAt: null },
  { id: 2, name: 'Bruno', price: 20, archivedAt: new Date('2026-01-01') },
  { id: 3, name: 'ana maria', price: 30, archivedAt: null },
];

const CASES: Array<[name: string, filter: FilterNode, expectedIds: number[]]> = [
  ['eq', { kind: 'cmp', path: ['name'], operator: 'eq', value: 'Bruno' }, [2]],
  ['ne', { kind: 'cmp', path: ['name'], operator: 'ne', value: 'Bruno' }, [1, 3]],
  [
    'contains case-insensitive',
    { kind: 'cmp', path: ['name'], operator: 'contains', value: 'ana', caseInsensitive: true },
    [1, 3],
  ],
  [
    'notContains case-insensitive',
    { kind: 'cmp', path: ['name'], operator: 'notContains', value: 'ana', caseInsensitive: true },
    [2],
  ],
  ['in', { kind: 'cmp', path: ['price'], operator: 'in', value: [10, 30] }, [1, 3]],
  ['notIn', { kind: 'cmp', path: ['price'], operator: 'notIn', value: [10, 30] }, [2]],
  ['gt', { kind: 'cmp', path: ['price'], operator: 'gt', value: 20 }, [3]],
  ['gte', { kind: 'cmp', path: ['price'], operator: 'gte', value: 20 }, [2, 3]],
  ['lt', { kind: 'cmp', path: ['price'], operator: 'lt', value: 20 }, [1]],
  ['lte', { kind: 'cmp', path: ['price'], operator: 'lte', value: 20 }, [1, 2]],
  ['isNull', { kind: 'cmp', path: ['archivedAt'], operator: 'isNull', value: null }, [1, 3]],
  ['ne null', { kind: 'cmp', path: ['archivedAt'], operator: 'ne', value: null }, [2]],
  [
    'and',
    {
      kind: 'and',
      nodes: [
        { kind: 'cmp', path: ['archivedAt'], operator: 'isNull', value: null },
        { kind: 'cmp', path: ['price'], operator: 'gt', value: 20 },
      ],
    },
    [3],
  ],
  [
    'or',
    {
      kind: 'or',
      nodes: [
        { kind: 'cmp', path: ['price'], operator: 'eq', value: 10 },
        { kind: 'cmp', path: ['price'], operator: 'eq', value: 30 },
      ],
    },
    [1, 3],
  ],
];

/**
 * Suíte de conformidade de adapter.
 *
 * É o mecanismo que torna "arquitetura de adapters" verificável em vez de
 * decorativa: quem escrever o adapter Sequelize (ou SQL) roda esta suíte e
 * sabe se traduziu a IR corretamente. Um adapter que não passa aqui não é um
 * adapter.
 */
export function runRepositoryConformance(harness: ConformanceHarness): void {
  describe(`conformidade de adapter — ${harness.name}`, () => {
    for (const [name, filter, expectedIds] of CASES) {
      it(`compila ${name}`, async () => {
        const repo = await harness.seed(MODEL, ROWS);
        const rows = await repo.findMany(MODEL, {
          filter,
          orderBy: [{ path: ['id'], direction: 'asc' }],
          skip: null,
          take: null,
        });
        expect(rows.map((row) => row.id)).toEqual(expectedIds);
        await harness.teardown?.();
      });
    }

    it('aggregate agrupa, conta e soma', async () => {
      const repo = await harness.seed(MODEL, [
        { id: 1, name: 'a', price: 10, archivedAt: null },
        { id: 2, name: 'a', price: 20, archivedAt: null },
        { id: 3, name: 'b', price: 30, archivedAt: null },
      ]);
      const buckets = await repo.aggregate(MODEL, {
        groupBy: 'name',
        count: true,
        sum: ['price'],
      });
      const byKey = Object.fromEntries(buckets.map((bucket) => [String(bucket.key), bucket]));
      expect(byKey.a).toMatchObject({ count: 2, sum: { price: 30 } });
      expect(byKey.b).toMatchObject({ count: 1, sum: { price: 30 } });
      await harness.teardown?.();
    });

    it('aggregate respeita o filtro', async () => {
      const repo = await harness.seed(MODEL, ROWS);
      const buckets = await repo.aggregate(
        MODEL,
        { groupBy: 'name', count: true },
        { kind: 'cmp', path: ['archivedAt'], operator: 'isNull', value: null },
      );
      expect(buckets.reduce((total, bucket) => total + (bucket.count ?? 0), 0)).toBe(2);
      await harness.teardown?.();
    });

    // Escrita por chave: é como o CrudService atualiza (pk + escopo do tenant).
    // Foi a forma AND{id, escopo} que o adapter Prisma recusava em update.
    it('update por pk + escopo', async () => {
      const repo = await harness.seed(MODEL, ROWS.map((r) => ({ ...r, scope: 1 })));
      const filter: FilterNode = {
        kind: 'and',
        nodes: [
          { kind: 'cmp', path: ['id'], operator: 'eq', value: 2 },
          { kind: 'cmp', path: ['scope'], operator: 'eq', value: 1 },
        ],
      };
      const updated = await repo.update(MODEL, { filter, data: { name: 'Bruno 2' } });
      expect(updated).toMatchObject({ id: 2, name: 'Bruno 2' });
      await harness.teardown?.();
    });

    it('upsert por chave única cria e depois atualiza', async () => {
      const repo = await harness.seed(MODEL, []);
      const filter: FilterNode = { kind: 'cmp', path: ['code'], operator: 'eq', value: 'X1' };
      await repo.upsert(MODEL, { filter, data: { id: 10, name: 'Novo', price: 1 } });
      const again = await repo.upsert(MODEL, { filter, data: { name: 'Novo 2', price: 2 } });
      expect(again).toMatchObject({ id: 10, name: 'Novo 2', code: 'X1' });
      expect(await repo.count(MODEL)).toBe(1);
      await harness.teardown?.();
    });

    it('create e transação', async () => {
      const repo = await harness.seed(MODEL, []);
      await repo.transaction(async (tx) => tx.create(MODEL, { id: 20, name: 'Tx', price: 5 }));
      expect(await repo.count(MODEL)).toBe(1);
      await harness.teardown?.();
    });

    it('count respeita o mesmo filtro', async () => {
      const repo = await harness.seed(MODEL, ROWS);
      const filter = CASES[0]![1];
      expect(await repo.count(MODEL, filter)).toBe(CASES[0]![2].length);
      await harness.teardown?.();
    });
  });
}
