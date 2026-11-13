import fc from 'fast-check';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import type { PrismaClient } from '../src/prisma/client.js';
import { seedServices } from '../src/prisma/seed.js';
import { retentionCutoff, runRetention } from '../src/ingest/retention.js';
import { describeDb, testPrisma, truncateAll } from './db.js';

const NOW = new Date('2026-11-13T12:00:00.000Z');

describeDb('retention (Test database)', () => {
  let prisma: PrismaClient;
  let serviceId: string;

  beforeAll(() => {
    prisma = testPrisma();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await truncateAll(prisma);
    await seedServices(prisma);
    serviceId = (await prisma.service.findUniqueOrThrow({ where: { name: 'gate' } })).id;
  });

  const insert = (offsetsMs: number[]): Promise<unknown> =>
    prisma.signal.createMany({
      data: offsetsMs.map((o) => ({ serviceId, kind: 'up' as const, value: 1, at: new Date(NOW.getTime() - o) })),
    });

  it('deletes in several batches and keeps recent rows, the Services and the Incidents', async () => {
    const hour = 3_600_000;
    await insert([25 * hour, 30 * hour, 48 * hour, 24 * hour + 1, 23 * hour, 1000, 0]);
    await prisma.incident.create({ data: { serviceId, peakLevel: 2 } });
    const deleted = await runRetention(prisma, NOW, 24, 2);
    expect(deleted).toBe(4);
    expect(await prisma.signal.count()).toBe(3);
    expect(await prisma.service.count()).toBe(4);
    expect(await prisma.incident.count()).toBe(1);
  });

  it('keeps a Signal exactly at the cut-off', async () => {
    const cutoff = retentionCutoff(NOW, 24);
    await prisma.signal.createMany({
      data: [
        { serviceId, kind: 'up', value: 1, at: cutoff },
        { serviceId, kind: 'up', value: 1, at: new Date(cutoff.getTime() - 1) },
      ],
    });
    expect(await runRetention(prisma, NOW, 24)).toBe(1);
    const left = await prisma.signal.findMany();
    expect(left.map((s) => s.at.getTime())).toEqual([cutoff.getTime()]);
  });

  it('does nothing on an empty table', async () => {
    expect(await runRetention(prisma, NOW, 24)).toBe(0);
  });

  // Feature: ingest-haunt-score, Property 10: retention deletes only older Signals
  it('Property 10: deletes exactly the rows strictly before the cut-off, whatever the batch size', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: -5 * 3_600_000, max: 80 * 3_600_000 }), { maxLength: 25 }),
        fc.integer({ min: 1, max: 48 }),
        fc.integer({ min: 1, max: 7 }),
        async (offsets, retentionH, batch) => {
          await truncateAll(prisma);
          await seedServices(prisma);
          serviceId = (await prisma.service.findUniqueOrThrow({ where: { name: 'gate' } })).id;
          await insert(offsets);
          const cutoff = retentionCutoff(NOW, retentionH).getTime();
          const times = offsets.map((o) => NOW.getTime() - o);
          const expectedKept = times.filter((t) => t >= cutoff).sort((a, b) => a - b);
          const deleted = await runRetention(prisma, NOW, retentionH, batch, 0);
          expect(deleted).toBe(times.length - expectedKept.length);
          const left = (await prisma.signal.findMany()).map((s) => s.at.getTime()).sort((a, b) => a - b);
          expect(left).toEqual(expectedKept);
          expect(await prisma.service.count()).toBe(4);
        },
      ),
      { numRuns: 25 },
    );
  });
});
