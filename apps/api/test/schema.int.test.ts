import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { SERVICE_NAMES } from '@haunted-ops/shared';
import type { PrismaClient } from '../src/prisma/client.js';
import { SERVICE_ROOMS, seedServices } from '../src/prisma/seed.js';
import { describeDb, testPrisma, truncateAll } from './db.js';

describeDb('schema and migrations (Test database)', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = testPrisma();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await truncateAll(prisma);
  });

  it('migrate deploy on an empty database creates all six tables', async () => {
    const rows = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name <> '_prisma_migrations' ORDER BY table_name`;
    expect(rows.map((r) => r.table_name)).toEqual(['Evidence', 'Hunt', 'Incident', 'Proposal', 'Service', 'Signal']);
  });

  it('creates the latest-signals index and the one-open-incident partial unique index', async () => {
    const rows = await prisma.$queryRaw<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'`;
    const byName = new Map(rows.map((r) => [r.indexname, r.indexdef]));
    expect(byName.get('signal_latest_per_service')).toMatch(/\("serviceId", kind, at DESC\)/);
    const partial = byName.get('incident_one_open_per_service');
    expect(partial).toMatch(/UNIQUE INDEX/);
    expect(partial).toMatch(/WHERE \("closedAt" IS NULL\)/);
    expect(byName.get('Evidence_huntId_order_key')).toMatch(/UNIQUE INDEX/);
  });

  it('seeds the four services with fixed room positions', async () => {
    await seedServices(prisma);
    const services = await prisma.service.findMany({ orderBy: { name: 'asc' } });
    expect(services.map((s) => s.name).sort()).toEqual([...SERVICE_NAMES].sort());
    for (const s of services) {
      const room = SERVICE_ROOMS[s.name as keyof typeof SERVICE_ROOMS];
      expect({ x: s.roomX, y: s.roomY }).toEqual(room);
      expect(s.hauntLevel).toBe(0);
    }
  });

  it('enforces foreign keys', async () => {
    await expect(
      prisma.signal.create({ data: { serviceId: 'missing', kind: 'up', value: 1, at: new Date() } }),
    ).rejects.toThrow();
  });
});
