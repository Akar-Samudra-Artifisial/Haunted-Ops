import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HuntDetail } from '@haunted-ops/shared';
import { parseHuntConfig } from '../src/hunts/hunt-config.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { seedServices } from '../src/prisma/seed.js';
import { startServer, testConfig, type TestServer } from '../test/support/http.js';

/**
 * One real Hunt with the real `kiro-cli` against a running Lab. It spends about 1 Credit, so it runs
 * only with HUNT_LIVE=1 and never as part of `pnpm test`. Needs, in the environment (names only):
 *   HUNTS_ENABLED=true, LAB_URL, LAB_READ_TOKEN, HUNT_ADMIN_TOKEN, KIRO_CLI_PATH (the real kiro-cli),
 *   PROMETHEUS_URL, CHAOS_URL, CHAOS_TOKEN, TEST_DATABASE_URL.
 * The Lab must be running with the three scenarios planted; the test applies `error-spike`, opens the
 * Incident row itself (ingest is not needed) and resets the Lab at the end.
 */
const LIVE = process.env.HUNT_LIVE === '1';
const PLANTED = '65c0fca31d0df62c4bab40d2d854c81b1044c650';

describe.skipIf(!LIVE)('live hunt (real kiro-cli, real Lab)', () => {
  let server: TestServer;
  const chaosUrl = (process.env.CHAOS_URL ?? 'http://127.0.0.1:4100').replace(/\/+$/, '');
  const chaos = (path: string): Promise<Response> => fetch(`${chaosUrl}${path}`, { method: 'POST', headers: { authorization: `Bearer ${process.env.CHAOS_TOKEN ?? ''}` } });

  beforeAll(async () => {
    const huntConfig = parseHuntConfig({ ...process.env, HUNTS_ENABLED: 'true' });
    server = await startServer({ config: testConfig({ PROMETHEUS_URL: process.env.PROMETHEUS_URL ?? 'http://127.0.0.1:9090' }), huntConfig });
    const prisma = server.app.get(PrismaService).client;
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "Proposal", "Evidence", "HuntStep", "Hunt", "Incident", "Signal", "Service" RESTART IDENTITY CASCADE');
    await seedServices(prisma);
  });

  afterAll(async () => {
    await chaos('/chaos/reset').catch(() => undefined);
    await server?.close();
  });

  it('ends with a valid diagnosis that names the planted commit', async () => {
    expect((await chaos('/chaos/scenarios/error-spike/apply')).status).toBe(200);
    const prisma = server.app.get(PrismaService).client;
    const service = await prisma.service.findFirstOrThrow({ where: { name: 'payments' } });
    await prisma.service.update({ where: { id: service.id }, data: { hauntLevel: 3, reasonKind: 'error_rate', reasonValue: 0.3 } });
    await prisma.incident.create({ data: { serviceId: service.id, peakLevel: 3, openedAt: new Date() } });
    const started = await fetch(`${server.url}/api/hunts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.HUNT_ADMIN_TOKEN ?? ''}` },
      body: JSON.stringify({ service: 'payments' }),
    });
    expect(started.status).toBe(202);
    const { huntId } = (await started.json()) as { huntId: string };
    const deadline = Date.now() + 180_000;
    let detail: HuntDetail | null = null;
    while (Date.now() < deadline) {
      detail = (await (await fetch(`${server.url}/api/hunts/${huntId}`)).json()) as HuntDetail;
      if (detail.status !== 'queued' && detail.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    expect(detail).toMatchObject({ status: 'succeeded', reason: 'diagnosed', diagnosis: { culpritSha: PLANTED } });
  });
});
