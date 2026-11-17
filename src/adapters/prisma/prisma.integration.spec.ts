/**
 * A suíte de conformidade contra Postgres REAL via adapter Prisma.
 *
 * O repositório em memória aceitava `update` com where `{ AND: [...] }`; o
 * Prisma não — e isso só apareceu num teste ponta a ponta real. Este
 * spec existe para que a conformidade nunca mais seja só contra o dublê.
 *
 * Roda quando CRUD_CORE_PG_URL estiver definido (banco descartável):
 *   createdb crud_core_test
 *   CRUD_CORE_PG_URL=postgresql://localhost/crud_core_test pnpm test:integration
 */
import { describe, it } from 'vitest';

import { runRepositoryConformance } from '../../testing/conformance';
import { PrismaClientLike, prismaRepository } from './repository';

const url = process.env.CRUD_CORE_PG_URL;

if (url) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PrismaClient } = require('../../../test/prisma/client');
  const client = new PrismaClient({ datasources: { db: { url } } });

  runRepositoryConformance({
    name: 'prisma + postgres',
    async seed(_model, rows) {
      await client.conformanceRow.deleteMany();
      if (rows.length) await client.conformanceRow.createMany({ data: rows });
      return prismaRepository(client as unknown as PrismaClientLike);
    },
  });
} else {
  describe.skip('conformidade de adapter — prisma + postgres (defina CRUD_CORE_PG_URL)', () => {
    it('pulada', () => undefined);
  });
}
