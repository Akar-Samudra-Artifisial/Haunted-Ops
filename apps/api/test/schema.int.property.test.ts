// Feature: foundation, Property 14: Seed is idempotent
// Feature: foundation, Property 15: At most one open Incident per Service
// Feature: foundation, Property 16: Evidence order is unique per Hunt
import fc from 'fast-check';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { HAUNT_LEVELS, SERVICE_NAMES, type ServiceName } from '@haunted-ops/shared';
import type { PrismaClient } from '../src/prisma/client.js';
import { SERVICE_ROOMS, seedServices } from '../src/prisma/seed.js';
import { describeDb, testPrisma, truncateAll } from './db.js';

const RUNS = { numRuns: 25 };

describeDb('database properties (Test database)', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = testPrisma();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function freshSeeded(): Promise<Map<ServiceName, string>> {
    await truncateAll(prisma);
    await seedServices(prisma);
    const rows = await prisma.service.findMany();
    return new Map(rows.map((r) => [r.name as ServiceName, r.id]));
  }

  it('Property 14: any number of seed runs leaves four services with fixed positions and unchanged haunt levels', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 4 }),
        fc.record(Object.fromEntries(SERVICE_NAMES.map((n) => [n, fc.constantFrom(...HAUNT_LEVELS)])) as Record<ServiceName, fc.Arbitrary<number>>),
        async (runs, levels) => {
          await freshSeeded();
          for (const name of SERVICE_NAMES) {
            await prisma.service.update({ where: { name }, data: { hauntLevel: levels[name] } });
          }
          for (let i = 0; i < runs; i++) await seedServices(prisma);
          const rows = await prisma.service.findMany();
          expect(rows).toHaveLength(4);
          for (const row of rows) {
            const name = row.name as ServiceName;
            expect({ x: row.roomX, y: row.roomY }).toEqual(SERVICE_ROOMS[name]);
            expect(row.hauntLevel).toBe(levels[name]);
          }
        },
      ),
      RUNS,
    );
  });

  it('Property 15: a second open Incident for a Service is rejected; open after close succeeds', async () => {
    const opArb = fc.record({ op: fc.constantFrom('open', 'close'), service: fc.constantFrom(...SERVICE_NAMES) });
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 12 }), async (ops) => {
        const ids = await freshSeeded();
        const open = new Set<ServiceName>();
        for (const { op, service } of ops) {
          const serviceId = ids.get(service) as string;
          if (op === 'open') {
            const attempt = prisma.incident.create({ data: { serviceId } });
            if (open.has(service)) {
              await expect(attempt).rejects.toMatchObject({ code: 'P2002' });
            } else {
              await attempt;
              open.add(service);
            }
          } else {
            const { count } = await prisma.incident.updateMany({
              where: { serviceId, closedAt: null },
              data: { closedAt: new Date() },
            });
            expect(count).toBe(open.has(service) ? 1 : 0);
            open.delete(service);
          }
        }
        expect(await prisma.incident.count({ where: { closedAt: null } })).toBe(open.size);
      }),
      RUNS,
    );
  });

  it('Property 16: a repeated Evidence order number within one Hunt is rejected', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.integer({ min: 0, max: 6 }), { minLength: 1, maxLength: 10 }), async (orders) => {
        const ids = await freshSeeded();
        const incident = await prisma.incident.create({ data: { serviceId: ids.get('payments') as string } });
        const hunt = await prisma.hunt.create({ data: { incidentId: incident.id } });
        const other = await prisma.hunt.create({ data: { incidentId: incident.id } });
        const seen = new Set<number>();
        for (const order of orders) {
          const attempt = prisma.evidence.create({
            data: { huntId: hunt.id, order, kind: 'metric', ref: `m${order}`, detail: 'd' },
          });
          if (seen.has(order)) {
            await expect(attempt).rejects.toMatchObject({ code: 'P2002' });
          } else {
            await attempt;
            seen.add(order);
          }
        }
        // The same order number is fine in a different Hunt.
        const [first] = orders;
        await prisma.evidence.create({ data: { huntId: other.id, order: first as number, kind: 'log', ref: 'l', detail: 'd' } });
        expect(await prisma.evidence.count({ where: { huntId: hunt.id } })).toBe(seen.size);
      }),
      RUNS,
    );
  });
});
