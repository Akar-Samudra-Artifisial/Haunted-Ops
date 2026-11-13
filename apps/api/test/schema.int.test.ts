import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { SERVICE_NAMES } from '@haunted-ops/shared';
import type { PrismaClient } from '../src/prisma/client.js';
import { SERVICE_ROOMS, seedServices } from '../src/prisma/seed.js';
import { describeDb, testDatabaseUrl, testPrisma, truncateAll } from './db.js';

const migrationsDir = fileURLToPath(new URL('../prisma/migrations/', import.meta.url));
const migrationSql = (name: string): string => readFileSync(`${migrationsDir}${name}/migration.sql`, 'utf8');

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

  it('has the ingest columns, the signal_at index and the reason CHECK, and keeps the partial unique index', async () => {
    const idx = await prisma.$queryRaw<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'`;
    const byName = new Map(idx.map((r) => [r.indexname, r.indexdef]));
    expect(byName.get('signal_at')).toMatch(/\(at\)/);
    expect(byName.get('incident_one_open_per_service')).toMatch(/WHERE \("closedAt" IS NULL\)/);
    await seedServices(prisma);
    const gate = await prisma.service.findUniqueOrThrow({ where: { name: 'gate' } });
    expect(gate.reasonKind).toBeNull();
    expect(gate.reasonValue).toBeNull();
    await prisma.service.update({ where: { name: 'gate' }, data: { reasonKind: 'p95', reasonValue: 1500 } });
    await expect(prisma.service.update({ where: { name: 'gate' }, data: { reasonKind: null } })).rejects.toThrow();
    await expect(prisma.service.update({ where: { name: 'gate' }, data: { reasonKind: 'down', reasonValue: null } })).rejects.toThrow();
  });

  it('applies on top of a foundation-migrated database that already has rows', async () => {
    const names = readdirSync(migrationsDir).filter((n) => /^\d{14}_/.test(n)).sort();
    const first = names[0] as string;
    const rest = names.slice(1);
    expect(rest).toContain('20261113090000_add_service_reason');
    const client = new pg.Client({ connectionString: testDatabaseUrl });
    await client.connect();
    try {
      await client.query('DROP SCHEMA IF EXISTS mig_check CASCADE');
      await client.query('CREATE SCHEMA mig_check');
      await client.query('SET search_path TO mig_check');
      await client.query(migrationSql(first));
      await client.query(
        `INSERT INTO "Service" ("id", "name", "roomX", "roomY", "hauntLevel", "updatedAt") VALUES ('s1', 'gate', 0, 0, 2, now())`,
      );
      for (const name of rest) await client.query(migrationSql(name));
      const row = await client.query(`SELECT "hauntLevel", "reasonKind", "reasonValue" FROM "Service" WHERE "id" = 's1'`);
      expect(row.rows).toEqual([{ hauntLevel: 2, reasonKind: null, reasonValue: null }]);
    } finally {
      await client.query('SET search_path TO public');
      await client.query('DROP SCHEMA IF EXISTS mig_check CASCADE');
      await client.end();
    }
  });
});
