import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, expect, it } from 'vitest';
import { validateHuntDetail, validateServiceStates, type HuntDetail } from '@haunted-ops/shared';
import { startFakeLab, type FakeLab, type FakeLabOptions } from '../../../tools/fake-kiro-cli/fake-lab.mjs';
import { FAKE_KIRO_CLI } from '../../../tools/fake-kiro-cli/wrapper.mjs';
import { EventBus, type BusEvent } from '../src/events/event-bus.js';
import { parseHuntConfig, type HuntConfig } from '../src/hunts/hunt-config.js';
import { HuntRunner } from '../src/hunts/hunt-runner.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { seedServices } from '../src/prisma/seed.js';
import { describeDb, truncateAll } from './db.js';
import { startServer, testConfig, type TestServer } from './support/http.js';
import { huntSequenceErrors } from './support/hunts.js';
import { SseReader } from './support/sse-reader.js';

const LAB_TOKEN = 'lab-read-token-0123456789-abcdef';
const ADMIN_TOKEN = 'admin-token-0123456789-abcdefgh';
const OPENED = new Date('2026-11-13T10:45:00.000Z');

const SHAS = {
  'error-spike': '65c0fca31d0df62c4bab40d2d854c81b1044c650',
  fog: '739d1217dc01c07adc69d38d53231d0dfab23b1f',
  'dark-room': '0b8dff146e2ddb3f9a7e5761ea63cfab9eb5e7aa',
} as const;

interface RigOptions {
  lab?: Partial<FakeLabOptions>;
  env?: Record<string, string>;
  cfg?: Partial<HuntConfig>;
}

interface Rig {
  server: TestServer;
  lab: FakeLab;
  events: BusEvent[];
  root: string;
  /** Chooses the fixture the next Hunt runs. */
  fixture(name: string): void;
  post(path: string, body: unknown, token?: string | null): Promise<Response>;
  get(path: string): Promise<Response>;
  /** Opens an Incident for a Service (a row, as ingest would). */
  open(service: string, openedAt?: Date): Promise<string>;
  /** Starts a Hunt by the operator route and waits until it ended. */
  hunt(service: string): Promise<{ id: string; detail: HuntDetail }>;
  until(check: () => boolean | Promise<boolean>, ms?: number, what?: string): Promise<void>;
  close(): Promise<void>;
}

const rigs: Rig[] = [];

async function startRig(o: RigOptions = {}): Promise<Rig> {
  const lab = await startFakeLab({ token: LAB_TOKEN, ...o.lab });
  const root = mkdtempSync(join(tmpdir(), 'hunt-int-'));
  // A kiro-cli that reads the fixture from a file, so one server can run different fixtures.
  const cli = join(root, 'kiro-cli');
  const fixtureFile = join(root, 'fixture');
  writeFileSync(fixtureFile, 'error-spike');
  writeFileSync(cli, `#!/bin/sh\nFAKE_KIRO_FIXTURE="$(cat '${fixtureFile}')"\nexport FAKE_KIRO_FIXTURE\nexec '${process.execPath}' '${FAKE_KIRO_CLI}' "$@"\n`, { mode: 0o755 });
  chmodSync(cli, 0o755);
  mkdirSync(join(root, 'hunts'));

  const parsed = parseHuntConfig({
    HUNTS_ENABLED: 'true',
    LAB_URL: lab.url,
    LAB_READ_TOKEN: LAB_TOKEN,
    HUNT_ADMIN_TOKEN: ADMIN_TOKEN,
    KIRO_CLI_PATH: cli,
    HUNT_WORKDIR: join(root, 'hunts'),
    HUNT_COOLDOWN_MS: '0',
    ...o.env,
  });
  const huntConfig: HuntConfig = { ...parsed, ...o.cfg };
  const server = await startServer({ config: testConfig({ PROMETHEUS_URL: lab.url }), huntConfig });
  const prisma = server.app.get(PrismaService).client;
  await truncateAll(prisma);
  await seedServices(prisma);
  const events: BusEvent[] = [];
  server.app.get(EventBus).subscribe((e) => events.push(e));
  await server.app.get(HuntRunner).start();

  const until = async (check: () => boolean | Promise<boolean>, ms = 25_000, what = 'condition'): Promise<void> => {
    const deadline = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  const post = (path: string, body: unknown, token: string | null = ADMIN_TOKEN): Promise<Response> =>
    fetch(`${server.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token === null ? {} : { authorization: `Bearer ${token}` }) },
      body: JSON.stringify(body),
    });
  const get = (path: string): Promise<Response> => fetch(`${server.url}${path}`);
  const open = async (service: string, openedAt: Date = OPENED): Promise<string> => {
    const row = await prisma.service.findFirstOrThrow({ where: { name: service } });
    await prisma.service.update({ where: { id: row.id }, data: { hauntLevel: 3, reasonKind: 'error_rate', reasonValue: 0.3 } });
    const incident = await prisma.incident.create({ data: { serviceId: row.id, peakLevel: 3, openedAt } });
    return incident.id;
  };
  const rig: Rig = {
    server,
    lab,
    events,
    root,
    fixture: (name) => writeFileSync(fixtureFile, name),
    post,
    get,
    open,
    until,
    hunt: async (service) => {
      const res = await post('/api/hunts', { service });
      expect(res.status).toBe(202);
      const { huntId } = (await res.json()) as { huntId: string };
      await until(async () => {
        const d = (await (await get(`/api/hunts/${huntId}`)).json()) as HuntDetail;
        return d.status !== 'queued' && d.status !== 'running';
      }, 30_000, `hunt ${huntId} to end`);
      const detail = (await (await get(`/api/hunts/${huntId}`)).json()) as HuntDetail;
      return { id: huntId, detail };
    },
    close: async () => {
      await server.close();
      await lab.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
  rigs.push(rig);
  return rig;
}

/** What may never leave the API: tokens, the prompt, a host path, stream and agent text. */
function expectNoLeaks(rig: Rig, ...texts: string[]): void {
  const all = [...texts, ...rig.server.logs, JSON.stringify(rig.events.map((e) => e.payload))].join('\n');
  for (const secret of [LAB_TOKEN, ADMIN_TOKEN, 'Investigate it', rig.root, '/Users/', '/home/', 'runStarted', 'sessionUpdate', 'rawInput', 'agent_message_chunk']) {
    expect(all, secret).not.toContain(secret);
  }
}

beforeAll(() => {
  // The HuntWorkdir refuses to live below a repository; the system temp folder is not.
  expect(tmpdir()).not.toContain('haunted-ops');
});

afterEach(async () => {
  for (const r of rigs.splice(0)) await r.close();
});

describeDb('Hunts end to end (Test database, fake kiro-cli, fake lab)', () => {
  const GOOD = [
    ['error-spike', 'payments', 'd-7'],
    ['fog', 'orders', 'd-8'],
    ['dark-room', 'ledger', 'd-9'],
  ] as const;

  for (const [scenario, service, deploy] of GOOD) {
    it(`${scenario}: finds the planted commit and stores a valid diagnosis`, async () => {
      const rig = await startRig({ lab: { scenario } });
      const incidentId = await rig.open(service);
      rig.fixture(scenario);
      const { id, detail } = await rig.hunt(service);
      expect(validateHuntDetail(detail).ok).toBe(true);
      expect(detail).toMatchObject({
        status: 'succeeded',
        reason: 'diagnosed',
        trigger: 'operator',
        incidentId,
        service,
        diagnosis: { culpritDeploy: deploy, culpritSha: SHAS[scenario] },
        model: 'claude-sonnet-5.5',
      });
      expect(detail.credits).toBeGreaterThan(0);
      expect(detail.toolCalls).toBe(12);
      expect(detail.allSteps.map((s) => s.tool)).toEqual(['query_metrics', 'search_errors', 'tail_logs', 'recent_deploys', 'diff_commit', 'submit_diagnosis']);
      expect(detail.evidence.some((e) => e.cited && e.ref === `deploy:${deploy}`)).toBe(true);
      expect(detail.evidence.some((e) => e.cited && e.ref === `commit:${SHAS[scenario]}`)).toBe(true);
      expect(detail.fixHint).not.toBeNull();
      expect(huntSequenceErrors(rig.events, () => detail.status)).toEqual([]);

      // The same Hunt is the latest of its Service in GET /api/services.
      const services = validateServiceStates(await (await rig.get('/api/services')).json());
      expect(services.ok && services.value.find((s) => s.name === service)?.hunt).toMatchObject({ id, status: 'succeeded' });
      // The lab saw only authorized calls, and nothing was left running.
      expect(rig.lab.requests.filter((q) => q.path.startsWith('/lab/')).every((q) => q.authorized)).toBe(true);
      expectNoLeaks(rig, JSON.stringify(detail));
    });
  }

  it('plays the recorded real run back to the same diagnosis', async () => {
    // The real run named the lab's own deploy id (d-149); the fake lab is told about it.
    const rig = await startRig({
      lab: { extraDeploys: [{ id: 'd-149', service: 'payments', ref: 'scenario/error-spike', sha: SHAS['error-spike'], time: '2026-11-13T10:40:00.000Z', actor: 'chaos' }] },
    });
    await rig.open('payments');
    rig.fixture('live-error-spike');
    const { detail } = await rig.hunt('payments');
    expect(detail).toMatchObject({ status: 'succeeded', credits: 0.922, diagnosis: { culpritSha: SHAS['error-spike'] } });
  });

  const FAILS: Array<[string, string, string, string | null, Partial<RigOptions>?]> = [
    ['no-diagnosis', 'failed', 'no_diagnosis', null],
    ['bad-sha', 'failed', 'invalid_diagnosis', 'sha_mismatch'],
    ['unseen-handle', 'failed', 'invalid_diagnosis', 'evidence_unseen'],
    ['wrong-service', 'failed', 'invalid_diagnosis', 'service'],
    ['foreign-tool', 'failed', 'foreign_tool', null],
    ['over-cap', 'failed', 'credit_cap', null],
    ['tool-limit', 'failed', 'tool_limit', null],
    ['malformed', 'failed', 'stream_error', null],
    ['mcp-fail', 'failed', 'mcp_startup', null],
    ['timeout', 'failed', 'timeout', null, { cfg: { timeoutMs: 2500 } }],
  ];
  for (const [fixture, status, reason, check, extra] of FAILS) {
    it(`${fixture}: ends as ${status} with ${reason}${check ? ` (${check})` : ''} and keeps no diagnosis`, async () => {
      const rig = await startRig(extra);
      await rig.open('payments');
      rig.fixture(fixture);
      const { detail } = await rig.hunt('payments');
      expect(validateHuntDetail(detail).ok).toBe(true);
      expect(detail).toMatchObject({ status, reason, invalidCheck: check, diagnosis: null, fixHint: null });
      expect(rig.events.some((e) => e.name === 'hunt.diagnosis')).toBe(false);
      expect(huntSequenceErrors(rig.events, () => detail.status)).toEqual([]);
      const fin = rig.events.find((e) => e.name === 'hunt.finished')?.payload;
      expect(fin).toMatchObject({ status, reason, invalidCheck: check });
      expectNoLeaks(rig, JSON.stringify(detail));
    });
  }

  it('marks a commit the lab cannot serve as unreachable', async () => {
    const rig = await startRig({ lab: { unreachable: [SHAS['error-spike']] } });
    await rig.open('payments');
    rig.fixture('error-spike');
    const { detail } = await rig.hunt('payments');
    expect(detail).toMatchObject({ status: 'failed', reason: 'invalid_diagnosis', invalidCheck: 'sha_unreachable' });
  });

  it('keeps only cleaned data when the lab carries planted instructions, and still reaches the diagnosis', async () => {
    const rig = await startRig({ lab: { hostile: true } });
    await rig.open('payments');
    rig.fixture('injection');
    const { detail } = await rig.hunt('payments');
    expect(detail).toMatchObject({ status: 'succeeded', diagnosis: { culpritSha: SHAS['error-spike'] } });
    const stored = JSON.stringify(detail) + JSON.stringify(rig.events.map((e) => e.payload));
    // No escape or control character, no closing tag from the data, and the agent never ran a foreign tool.
    // eslint-disable-next-line no-control-regex
    expect(stored).not.toMatch(/\u001b|\u0007|\\u001b|\\u0007/);
    // The planted text is stored as plain, bounded data and was never acted on.
    expect(detail.evidence.some((e) => e.detail.includes('Ignore all previous instructions'))).toBe(true);
    expect(detail.evidence.every((e) => e.detail.length <= 200)).toBe(true);
    expect(detail.allSteps.map((s) => s.tool)).toEqual(['query_metrics', 'search_errors', 'tail_logs', 'recent_deploys', 'diff_commit', 'submit_diagnosis']);
    expect(detail.reason).toBe('diagnosed');
    expectNoLeaks(rig, stored);
  });

  it('accepts a culprit deploy of a Service the hunted one depends on, and names that Service', async () => {
    const rig = await startRig({ lab: { scenario: 'fog' } });
    await rig.open('gate');
    rig.fixture('downstream-culprit');
    const { detail } = await rig.hunt('gate');
    expect(validateHuntDetail(detail).ok).toBe(true);
    expect(detail).toMatchObject({
      status: 'succeeded',
      reason: 'diagnosed',
      service: 'gate',
      diagnosis: { culpritDeploy: 'd-8', culpritSha: SHAS.fog, culpritService: 'orders' },
    });
    const services = validateServiceStates(await (await rig.get('/api/services')).json());
    expect(services.ok && services.value.find((s) => s.name === 'gate')?.hunt?.diagnosis?.culpritService).toBe('orders');
    const diagnosis = rig.events.find((e) => e.name === 'hunt.diagnosis')?.payload;
    expect(diagnosis).toMatchObject({ service: 'gate', culpritService: 'orders' });
    expectNoLeaks(rig, JSON.stringify(detail));
  });

  it('refuses a culprit deploy of a Service upstream of the hunted one', async () => {
    // The fog deploy belongs to orders, which calls payments: a hunt on payments cannot blame it.
    const rig = await startRig({ lab: { scenario: 'fog' } });
    await rig.open('payments');
    rig.fixture('downstream-culprit');
    const { detail } = await rig.hunt('payments');
    expect(detail).toMatchObject({ status: 'failed', reason: 'invalid_diagnosis' });
    expect(['service', 'deploy_service']).toContain(detail.invalidCheck);
  });

  it('accepts every Tool Load shape of the six tools and ignores repeated calls and updates with another title', async () => {
    const rig = await startRig();
    await rig.open('payments');
    rig.fixture('load-shapes');
    const { detail } = await rig.hunt('payments');
    expect(detail).toMatchObject({ status: 'succeeded', reason: 'diagnosed', stopDetail: null, diagnosis: { culpritSha: SHAS['error-spike'], culpritService: 'payments' } });
  });

  it('stops a Hunt whose update reuses an accepted call id for another tool', async () => {
    const rig = await startRig();
    await rig.open('payments');
    rig.fixture('tool-call-reuse-id');
    const { detail } = await rig.hunt('payments');
    expect(detail).toMatchObject({ status: 'failed', reason: 'foreign_tool', stopDetail: 'fs_read', diagnosis: null });
  });

  it('accepts the Tool Call wrapper of kiro-cli 3.3.0 and counts each wrapped call once', async () => {
    const rig = await startRig();
    await rig.open('payments');
    rig.fixture('tool-call-wrapper');
    const { detail } = await rig.hunt('payments');
    expect(validateHuntDetail(detail).ok).toBe(true);
    expect(detail).toMatchObject({ status: 'succeeded', reason: 'diagnosed', stopDetail: null, toolCalls: 12, diagnosis: { culpritSha: SHAS['error-spike'], culpritService: 'payments' } });
    expect(detail.allSteps.map((s) => s.tool)).toEqual(['query_metrics', 'search_errors', 'tail_logs', 'recent_deploys', 'diff_commit', 'submit_diagnosis']);
    expectNoLeaks(rig, JSON.stringify(detail));
  });

  it('stops for a Tool Call wrapper of a built-in tool and names the tool_id', async () => {
    const rig = await startRig();
    await rig.open('payments');
    rig.fixture('tool-call-foreign');
    const { detail } = await rig.hunt('payments');
    expect(detail).toMatchObject({ status: 'failed', reason: 'foreign_tool', stopDetail: 'Tool Call tool_id=tool::builtin::execute_bash', diagnosis: null });
    expect(validateHuntDetail(detail).ok).toBe(true);
    expect(rig.server.logs.some((l) => l.includes('"msg":"hunt stopped"') && l.includes('tool::builtin::execute_bash'))).toBe(true);
  });

  it('gives no Hunt of its own to the Service an upstream Hunt named as the cause', async () => {
    const rig = await startRig({ lab: { scenario: 'dark-room' }, env: { HUNT_SETTLE_MS: '300' } });
    rig.fixture('downstream-culprit-payments');
    const bus = rig.server.app.get(EventBus);
    const prisma = rig.server.app.get(PrismaService).client;
    const payments = await rig.open('payments');
    bus.publish('incident.opened', { incidentId: payments, service: 'payments', openedAt: OPENED.toISOString(), level: 3, reason: null });
    // ledger opens later than the settle window of payments (about 25 s after the break in the lab): wait for the Hunt to start.
    await rig.until(() => rig.events.some((e) => e.name === 'hunt.started'), 15_000, 'the hunt on payments');
    const ledger = await rig.open('ledger', new Date(OPENED.getTime() + 20_000));
    bus.publish('incident.opened', { incidentId: ledger, service: 'ledger', openedAt: OPENED.toISOString(), level: 4, reason: null });
    await rig.until(async () => (await prisma.hunt.count({ where: { status: { in: ['queued', 'running'] } } })) === 0 && (await prisma.hunt.count()) >= 2, 30_000, 'both hunts to end');
    await new Promise((r) => setTimeout(r, 600));
    const hunts = await prisma.hunt.findMany({ include: { service: true }, orderBy: { createdAt: 'asc' } });
    expect(hunts.map((h) => [h.service.name, h.status, h.endReason])).toEqual([
      ['payments', 'succeeded', 'diagnosed'],
      ['ledger', 'cancelled', 'diagnosed_upstream'],
    ]);
    expect(hunts[0]).toMatchObject({ culpritDeploy: 'd-9', culpritService: 'ledger', culpritSha: SHAS['dark-room'] });
    expect(hunts[1]).toMatchObject({ diagnosedBy: 'payments', linkedHuntId: hunts[0]!.id, startedAt: null });
    // The withdrawn Hunt is read back with its link, and no process ran for it.
    const detail = (await (await rig.get(`/api/hunts/${hunts[1]!.id}`)).json()) as HuntDetail;
    expect(validateHuntDetail(detail).ok).toBe(true);
    expect(detail).toMatchObject({ status: 'cancelled', reason: 'diagnosed_upstream', diagnosedBy: 'payments', linkedHuntId: hunts[0]!.id });
    expect(rig.events.filter((e) => e.name === 'hunt.started')).toHaveLength(1);
    expect(huntSequenceErrors(rig.events, (id) => hunts.find((h) => h.id === id)?.status)).toEqual([]);
    const services = validateServiceStates(await (await rig.get('/api/services')).json());
    expect(services.ok && services.value.find((s) => s.name === 'ledger')?.hunt).toMatchObject({ status: 'cancelled', reason: 'diagnosed_upstream', diagnosedBy: 'payments' });
  });

  it('records the refused tool and keeps the reduced stream of the Hunt in the working folder', async () => {
    const rig = await startRig();
    await rig.open('payments');
    rig.fixture('foreign-tool');
    const { id, detail } = await rig.hunt('payments');
    expect(detail).toMatchObject({ status: 'failed', reason: 'foreign_tool', stopDetail: 'fs_read' });
    expect(validateHuntDetail(detail).ok).toBe(true);
    expect(rig.server.logs.some((l) => l.includes('"msg":"hunt stopped"') && l.includes('fs_read'))).toBe(true);
    const file = join(rig.root, 'hunts', `${id}.stream.jsonl`);
    const text = readFileSync(file, 'utf8');
    const lines = text.trim().split('\n').map((l) => JSON.parse(l) as { type: string; data?: { update?: { sessionUpdate?: string; title?: string } } });
    expect(lines.some((l) => l.data?.update?.title === 'fs_read')).toBe(true);
    expect(lines.some((l) => l.data?.update?.title === '@exorcist/query_metrics')).toBe(true);
    // Reduced: no tool output, no model text, no token, no host path.
    for (const bad of ['rawOutput', 'agent_message_chunk', 'untrusted_data', LAB_TOKEN, ADMIN_TOKEN, rig.root]) expect(text).not.toContain(bad);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('keeps only the newest 20 stream files', async () => {
    const rig = await startRig();
    await rig.open('payments');
    rig.fixture('no-diagnosis');
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await rig.hunt('payments')).id);
    const folder = join(rig.root, 'hunts');
    for (let i = 0; i < 20; i++) writeFileSync(join(folder, `cmoldstream${String(i).padStart(14, '0')}.stream.jsonl`), '{}\n');
    rig.fixture('no-diagnosis');
    const last = await rig.hunt('payments');
    const files = readdirSync(folder).filter((n) => n.endsWith('.stream.jsonl'));
    expect(files).toHaveLength(20);
    expect(files).toContain(`${last.id}.stream.jsonl`);
  });

  it('hunts only the most downstream Service when three Incidents open within 5 s', async () => {
    const rig = await startRig({ lab: { scenario: 'dark-room' }, env: { HUNT_SETTLE_MS: '400' } });
    rig.fixture('dark-room');
    const bus = rig.server.app.get(EventBus);
    const prisma = rig.server.app.get(PrismaService).client;
    const opened = [] as Array<{ service: 'gate' | 'orders' | 'ledger'; id: string }>;
    for (const service of ['gate', 'orders', 'ledger'] as const) {
      const id = await rig.open(service);
      opened.push({ service, id });
      bus.publish('incident.opened', { incidentId: id, service, openedAt: OPENED.toISOString(), level: 3, reason: null });
      await new Promise((r) => setTimeout(r, 50));
    }
    await rig.until(async () => (await prisma.hunt.count()) > 0, 10_000, 'a hunt');
    await rig.until(async () => (await prisma.hunt.findMany()).every((h) => h.status !== 'queued' && h.status !== 'running'), 30_000, 'the hunt to end');
    // Wait past the settle window of the last Incident to be sure no other Hunt follows.
    await new Promise((r) => setTimeout(r, 800));
    const hunts = await prisma.hunt.findMany({ include: { service: true } });
    expect(hunts).toHaveLength(1);
    expect(hunts[0]).toMatchObject({ trigger: 'auto', status: 'succeeded', culpritDeploy: 'd-9', culpritService: 'ledger', incidentId: opened[2]!.id });
    expect(hunts[0]?.service.name).toBe('ledger');
    expect(rig.events.filter((e) => e.name === 'hunt.queued')).toHaveLength(1);
    expect(rig.server.logs.filter((l) => l.includes('"msg":"hunt linked"')).length).toBeGreaterThanOrEqual(1);
  });

  it('treats a lab that is down as an unavailable lab, not a wrong diagnosis', async () => {
    const rig = await startRig({ lab: { down: true } });
    await rig.open('payments');
    rig.fixture('error-spike');
    const { detail } = await rig.hunt('payments');
    // Every tool answers lab_unavailable, so the fixture's diagnosis cites handles it never saw.
    expect(detail.status).toBe('failed');
    expect(['invalid_diagnosis', 'no_diagnosis', 'cli_error']).toContain(detail.reason);
  });

  it('streams the six hunt events on /api/events, in order', async () => {
    const rig = await startRig();
    await rig.open('payments');
    rig.fixture('error-spike');
    const sse = new SseReader(await fetch(`${rig.server.url}/api/events`));
    const seen: string[] = [];
    const reading = (async () => {
      for (let i = 0; i < 60 && !seen.includes('hunt.finished'); i++) {
        const [frame] = await sse.take(1, 30_000);
        if (frame?.event.startsWith('hunt.')) seen.push(frame.event);
      }
    })();
    await rig.hunt('payments');
    await reading;
    await sse.cancel();
    expect(seen[0]).toBe('hunt.queued');
    expect(seen[1]).toBe('hunt.started');
    expect(seen.at(-2)).toBe('hunt.diagnosis');
    expect(seen.at(-1)).toBe('hunt.finished');
    expect(seen.filter((n) => n === 'hunt.step')).toHaveLength(6);
    expect(new Set(seen)).toEqual(new Set(['hunt.queued', 'hunt.started', 'hunt.step', 'hunt.evidence', 'hunt.diagnosis', 'hunt.finished']));
  });

  it('stops a running Hunt with the Kill switch and leaves no process behind', async () => {
    const rig = await startRig();
    await rig.open('payments');
    rig.fixture('timeout');
    const res = await rig.post('/api/hunts', { service: 'payments' });
    const { huntId } = (await res.json()) as { huntId: string };
    await rig.until(() => rig.events.some((e) => e.name === 'hunt.step'), 15_000, 'a step');
    const off = await rig.post('/api/hunts/kill-switch', { enabled: false });
    expect(await off.json()).toEqual({ enabled: false });
    await rig.until(() => rig.events.some((e) => e.name === 'hunt.finished'), 15_000, 'the end');
    const detail = (await (await rig.get(`/api/hunts/${huntId}`)).json()) as HuntDetail;
    expect(detail).toMatchObject({ status: 'cancelled', reason: 'disabled' });
    // A new request is recorded and cancelled, not run.
    const next = await rig.post('/api/hunts', { service: 'payments' });
    expect(next.status).toBe(202);
    expect(await next.json()).toMatchObject({ status: 'cancelled', reason: 'disabled' });
    await new Promise((r) => setTimeout(r, 300));
    expect(leftoverProcesses()).toBe(0);
  });

  it('stops a running Hunt when the app shuts down', async () => {
    const rig = await startRig();
    await rig.open('payments');
    rig.fixture('timeout');
    const res = await rig.post('/api/hunts', { service: 'payments' });
    const { huntId } = (await res.json()) as { huntId: string };
    await rig.until(() => rig.events.some((e) => e.name === 'hunt.step'), 15_000, 'a step');
    await rig.server.app.get(HuntRunner).stop();
    const prisma = rig.server.app.get(PrismaService).client;
    const row = await prisma.hunt.findUniqueOrThrow({ where: { id: huntId } });
    expect(row).toMatchObject({ status: 'cancelled', endReason: 'shutdown' });
    await new Promise((r) => setTimeout(r, 300));
    expect(leftoverProcesses()).toBe(0);
  });

  it('records a request while a Hunt runs as queued, and the one after as busy', async () => {
    const rig = await startRig();
    await rig.open('payments');
    rig.fixture('timeout');
    const a = (await (await rig.post('/api/hunts', { service: 'payments' })).json()) as { huntId: string; status: string };
    await rig.until(() => rig.events.some((e) => e.name === 'hunt.started'), 15_000, 'start');
    const b = (await (await rig.post('/api/hunts', { service: 'payments' })).json()) as { status: string };
    const c = (await (await rig.post('/api/hunts', { service: 'payments' })).json()) as { status: string; reason: string };
    expect([a.status, b.status, c.status, c.reason]).toEqual(['queued', 'queued', 'cancelled', 'busy']);
    await rig.post('/api/hunts/kill-switch', { enabled: false });
    await rig.until(() => rig.events.filter((e) => e.name === 'hunt.finished').length === 3, 15_000, 'three ends');
    expect(huntSequenceErrors(rig.events, (id) => rig.events.map((e) => e.payload as { huntId?: string; status?: string }).find((p) => p.huntId === id && p.status !== undefined)?.status)).toEqual([]);
  });
});

describeDb('Hunt routes (Test database)', () => {
  it('answers 401 with the same body for a missing, a wrong and an empty token', async () => {
    const rig = await startRig();
    const bodies: unknown[] = [];
    for (const token of [null, 'wrong-token-0123456789-abcdefghi', '']) {
      const res = await rig.post('/api/hunts', { service: 'payments' }, token);
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe('Bearer');
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ error: 'unauthorized' });
      delete body.requestId;
      bodies.push(body);
    }
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    expect((await rig.post('/api/hunts/kill-switch', { enabled: false }, null)).status).toBe(401);
    expect(rig.server.logs.join('')).not.toContain(ADMIN_TOKEN);
  });

  it('answers 400 for bad input, 404 for no Open Incident and for an unknown id', async () => {
    const rig = await startRig();
    expect((await rig.post('/api/hunts', { service: 'payments', extra: 1 })).status).toBe(400);
    expect((await rig.post('/api/hunts', {})).status).toBe(400);
    expect((await rig.post('/api/hunts', { incidentId: 'short' })).status).toBe(400);
    const none = await rig.post('/api/hunts', { service: 'payments' });
    expect(none.status).toBe(404);
    expect(await none.json()).toMatchObject({ error: 'no_open_incident' });
    expect((await rig.post('/api/hunts/kill-switch', { enabled: 'no' })).status).toBe(400);
    expect((await rig.get('/api/hunts/not-an-id')).status).toBe(400);
    expect((await rig.get('/api/hunts/cmunknownaaaaaaaaaaaaaaaa')).status).toBe(404);
    expect(rig.server.logs.join('')).not.toContain(ADMIN_TOKEN);
  });

  it('offers no other way to start a Hunt', async () => {
    const rig = await startRig();
    await rig.open('payments');
    for (const [method, path] of [['GET', '/api/hunts'], ['PUT', '/api/hunts'], ['DELETE', '/api/hunts/cmunknownaaaaaaaaaaaaaaaa'], ['POST', '/api/hunts/start'], ['POST', '/api/hunts/cmunknownaaaaaaaaaaaaaaaa'], ['GET', '/api/hunts/kill-switch']] as const) {
      const res = await fetch(`${rig.server.url}${path}`, { method, headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' }, body: method === 'GET' ? undefined : '{}' });
      expect([400, 404, 405], `${method} ${path}`).toContain(res.status);
    }
    expect(rig.events.filter((e) => e.name === 'hunt.queued')).toHaveLength(0);
  });

  it('limits the start route to 5 requests per minute per client', async () => {
    const rig = await startRig();
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await rig.post('/api/hunts', { service: 'payments' }, null)).status);
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429, 429]);
  });

  it('refuses to start any Hunt when the environment has them off, and says so as a cancelled request', async () => {
    const rig = await startRig({ env: { HUNTS_ENABLED: 'false' }, cfg: {} });
    await rig.open('payments');
    const res = await rig.post('/api/hunts', { service: 'payments' });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ status: 'cancelled', reason: 'disabled' });
    expect((await rig.post('/api/hunts/kill-switch', { enabled: true })).status).toBe(200);
    const again = await rig.post('/api/hunts', { service: 'payments' });
    expect(await again.json()).toMatchObject({ status: 'cancelled', reason: 'disabled' });
  });
});

/** Fake kiro-cli or MCP server processes of these tests that still run. */
function leftoverProcesses(): number {
  try {
    const out = execFileSync('pgrep', ['-f', 'fake-kiro-cli.mjs|haunted-exorcist-mcp|exorcist-mcp/dist/main'], { encoding: 'utf8' });
    return out.split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}
