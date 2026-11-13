import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { SERVICE_NAMES, downstreamOf, mostDownstream, type ServiceName } from '@haunted-ops/shared';
import type { HuntRunnerDeps } from './hunt-runner.js';
import {
  creditsLine,
  goodRun,
  harness,
  huntSequenceErrors,
  labFor,
  loadLine,
  settle,
  testHuntConfig,
  toolCallLine,
  toolUpdateWith,
  type Harness,
  type Script,
} from '../../test/support/hunts.js';

const OPENED = new Date('2026-11-13T10:41:00.000Z');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const SHA = '65c0fca31d0df62c4bab40d2d854c81b1044c650';

function setup(pick?: (id: string, i: number) => Script, config = testHuntConfig()) {
  const h = harness({ config, pick });
  const incident = h.store.addIncident('payments', OPENED);
  h.lab.deployList = labFor({ openedAt: OPENED }).deployList;
  return { h, incident };
}

const good = (): Script => {
  const g = goodRun();
  return { ledger: g.ledger, chunks: g.chunks, code: 0 };
};
const hang = (): Script => ({ hang: true });

const names = (h: Harness, id: string): string[] => h.events.filter((e) => (e.payload as { huntId?: string }).huntId === id).map((e) => e.name);
const statusOf = (h: Harness) => (id: string) => h.store.hunts.find((x) => x.id === id)?.status;

async function ask(h: Harness, service: 'payments' | 'orders' = 'payments') {
  const r = await h.runner.request({ trigger: 'operator', service });
  if (r.kind !== 'recorded') throw new Error(`not recorded: ${r.kind}`);
  return r;
}

const stepCall = (n: number): string => toolCallLine(`c${n}`, '@exorcist/query_metrics', { service: 'payments', signal: 'error_ratio', window: '15m' });

describe('HuntRunner: a Hunt from request to end', () => {
  it('runs a good hunt to a stored, published, valid diagnosis', async () => {
    const { h } = setup(good);
    const r = await ask(h);
    expect(r).toMatchObject({ status: 'queued', reason: null });
    await settle();
    const stored = h.store.byId(r.huntId);
    expect(stored).toMatchObject({ status: 'succeeded', endReason: 'diagnosed', toolCalls: 5, credits: 0.9 });
    expect(stored.diagnosis).toMatchObject({ culpritDeploy: 'd-7', culpritSha: SHA });
    expect(stored.steps.map((s) => s.tool)).toEqual(['query_metrics', 'recent_deploys', 'diff_commit', 'submit_diagnosis']);
    expect(stored.steps[0]?.summary).toBe('metrics payments error_ratio 15m');
    expect(stored.evidence.map((e) => e.ref)).toEqual(['metric:payments/error_ratio/15m', 'deploy:d-7', `commit:${SHA}`]);
    const n = names(h, r.huntId);
    expect(n.slice(0, 2)).toEqual(['hunt.queued', 'hunt.started']);
    expect(n.slice(-2)).toEqual(['hunt.diagnosis', 'hunt.finished']);
    expect(n.filter((x) => x === 'hunt.step')).toHaveLength(4);
    expect(n.filter((x) => x === 'hunt.evidence')).toHaveLength(3);
    expect(huntSequenceErrors(h.events, statusOf(h))).toEqual([]);
    expect(h.runner.latest('payments')).toMatchObject({ id: r.huntId, status: 'succeeded', stepCount: 4, evidenceCount: 3, diagnosis: { culpritDeploy: 'd-7' } });
    expect(h.workdir.ledgers.size).toBe(0);
  });

  it('keeps the prompt, the tokens and the model text out of the logs', async () => {
    const { h } = setup(good);
    await ask(h);
    await settle();
    const text = h.logs.join('');
    expect(text).not.toMatch(/lab-read-token|admin-token|Investigate it|retry guard|\/home\//);
    expect(h.logs.length).toBeGreaterThan(2);
    for (const l of h.logs) expect(Object.keys(JSON.parse(l) as object).sort()).toEqual(expect.arrayContaining(['ts', 'level', 'msg']));
  });

  it('answers no_open_incident for a Service or an id without an Open Incident', async () => {
    const { h, incident } = setup(good);
    expect(await h.runner.request({ trigger: 'operator', service: 'orders' })).toEqual({ kind: 'no_open_incident' });
    expect(await h.runner.request({ trigger: 'operator', incidentId: 'cmunknownaaaaaaaaaaaaaaaa' })).toEqual({ kind: 'no_open_incident' });
    h.store.closeIncident(incident.incidentId, h.now());
    expect(await h.runner.request({ trigger: 'operator', incidentId: incident.incidentId })).toEqual({ kind: 'no_open_incident' });
    expect(h.store.hunts).toHaveLength(0);
  });
});

describe('HuntRunner: one running, one queued', () => {
  it('queues one Hunt behind the running one and cancels the next as busy', async () => {
    const { h } = setup(hang);
    const a = await ask(h);
    await settle();
    const b = await ask(h);
    const c = await ask(h);
    expect(b).toMatchObject({ status: 'queued' });
    expect(c.status).toBe('cancelled');
    expect(c).toMatchObject({ status: 'cancelled', reason: 'busy' });
    expect(h.store.byId(a.huntId).status).toBe('running');
    expect(h.store.byId(b.huntId).status).toBe('queued');
    expect(h.store.byId(c.huntId)).toMatchObject({ status: 'cancelled', endReason: 'busy' });
    expect(h.spawner.maxLive).toBe(1);

    h.spawner.byHunt(a.huntId)?.release(0);
    await settle();
    expect(h.store.byId(a.huntId)).toMatchObject({ status: 'failed', endReason: 'no_diagnosis' });
    expect(h.store.byId(b.huntId).status).toBe('running');
    h.spawner.byHunt(b.huntId)?.release(0);
    await settle();
    expect(h.spawner.maxLive).toBe(1);
    await h.runner.stop();
    expect(huntSequenceErrors(h.events, statusOf(h))).toEqual([]);
  });

  it('cancels a queued Hunt whose Incident closed while it waited', async () => {
    const { h, incident } = setup(hang);
    const a = await ask(h);
    await settle();
    const b = await ask(h);
    h.store.closeIncident(incident.incidentId, h.now());
    h.spawner.byHunt(a.huntId)?.release(0);
    await settle();
    expect(h.store.byId(b.huntId)).toMatchObject({ status: 'cancelled', endReason: 'incident_closed' });
    expect(h.spawner.processes).toHaveLength(1);
    expect(names(h, b.huntId)).toEqual(['hunt.queued', 'hunt.finished']);
  });

  it('cancels a Hunt that would not fit the daily budget', async () => {
    const { h } = setup(good, testHuntConfig({ HUNT_DAILY_CREDIT_CAP: '2' }));
    const earlier = await h.store.create({ incidentId: 'x', serviceId: 'y', trigger: 'auto', model: 'm' });
    await h.store.markRunning(earlier.id, h.now());
    await h.store.finish(earlier.id, { status: 'failed', reason: 'timeout', invalidCheck: null, credits: 1, toolCalls: 1, durationMs: 1, finishedAt: h.now(), diagnosis: null });
    const r = await ask(h);
    await settle();
    expect(h.store.byId(r.huntId)).toMatchObject({ status: 'cancelled', endReason: 'daily_cap' });
    expect(h.spawner.processes).toHaveLength(0);
  });
});

describe('HuntRunner: cooldown and the Kill switch', () => {
  it('cancels an automatic request for a Service that finished a Hunt less than the cooldown ago', async () => {
    const { h, incident } = setup(good);
    await ask(h);
    await settle();
    const second = h.store.addIncident('payments', new Date(h.clock.t));
    const cooled = await h.runner.request({ trigger: 'auto', incidentId: second.incidentId });
    expect(cooled).toMatchObject({ kind: 'recorded', status: 'cancelled', reason: 'cooldown' });
    // An operator request is never held back by the cooldown.
    expect(await h.runner.request({ trigger: 'operator', service: 'payments' })).toMatchObject({ status: 'queued' });
    await settle();
    h.clock.t += 1001;
    const third = h.store.addIncident('payments', new Date(h.clock.t));
    expect(await h.runner.request({ trigger: 'auto', incidentId: third.incidentId })).toMatchObject({ status: 'queued' });
    expect(incident.incidentId).not.toBe(second.incidentId);
  });

  it('asks for an automatic Hunt once per Incident', async () => {
    const { h, incident } = setup(good);
    const first = await h.runner.request({ trigger: 'auto', incidentId: incident.incidentId });
    const again = await h.runner.request({ trigger: 'auto', incidentId: incident.incidentId });
    expect(first).toMatchObject({ kind: 'recorded' });
    expect(again).toEqual({ kind: 'skipped' });
    expect(h.store.hunts).toHaveLength(1);
  });

  it('starts an automatic Hunt on incident.opened at level 2 or higher only', async () => {
    const { h, incident } = setup(good);
    await h.runner.start();
    const low = h.store.addIncident('orders', OPENED, 2);
    h.bus.publish('incident.opened', { incidentId: low.incidentId, service: 'orders', openedAt: OPENED.toISOString(), level: 1, reason: null });
    h.bus.publish('incident.opened', { incidentId: incident.incidentId, service: 'payments', openedAt: OPENED.toISOString(), level: 3, reason: null });
    h.bus.publish('incident.opened', { incidentId: incident.incidentId, service: 'payments', openedAt: OPENED.toISOString(), level: 3, reason: null });
    await sleep(60);
    await settle();
    expect(h.store.hunts).toHaveLength(1);
    expect(h.store.hunts[0]).toMatchObject({ trigger: 'auto', incidentId: incident.incidentId, status: 'succeeded' });
    await h.runner.stop();
  });

  it('stops a running Hunt and cancels the queued one when Hunts are turned off, and records later requests as disabled', async () => {
    const { h } = setup(hang);
    const a = await ask(h);
    await settle();
    const b = await ask(h);
    expect(await h.runner.setEnabled(false)).toBe(false);
    await settle();
    expect(h.store.byId(a.huntId)).toMatchObject({ status: 'cancelled', endReason: 'disabled' });
    expect(h.store.byId(b.huntId)).toMatchObject({ status: 'cancelled', endReason: 'disabled' });
    const c = await ask(h);
    expect(c).toMatchObject({ status: 'cancelled', reason: 'disabled' });
    expect(h.spawner.processes).toHaveLength(1);
    expect(await h.runner.setEnabled(true)).toBe(true);
    expect(await ask(h)).toMatchObject({ status: 'queued' });
    await h.runner.stop();
    expect(huntSequenceErrors(h.events, statusOf(h))).toEqual([]);
  });

  it('cannot turn Hunts on when the environment has them off', async () => {
    const { h } = setup(good, testHuntConfig({ HUNTS_ENABLED: 'false', HUNT_ADMIN_TOKEN: 'admin-token-0123456789-abcdefgh' }));
    expect(await h.runner.setEnabled(true)).toBe(false);
    expect(await ask(h)).toMatchObject({ status: 'cancelled', reason: 'disabled' });
    expect(h.spawner.processes).toHaveLength(0);
  });
});

describe('HuntRunner: how a Hunt can end', () => {
  const endOf = async (script: Script, config = testHuntConfig()) => {
    const { h } = setup(() => script, config);
    const r = await ask(h);
    await settle();
    return { h, hunt: h.store.byId(r.huntId), id: r.huntId };
  };

  it('stops at a foreign tool call and keeps no diagnosis from it', async () => {
    const g = goodRun();
    const { h, hunt } = await endOf({ ledger: g.ledger, chunks: [stepCall(1), toolCallLine('x', 'execute_bash', { command: 'ls' }), ...g.chunks], hang: true });
    expect(hunt).toMatchObject({ status: 'failed', endReason: 'foreign_tool', diagnosis: null });
    expect(hunt.steps).toHaveLength(1);
    expect(h.events.some((e) => e.name === 'hunt.diagnosis')).toBe(false);
  });

  it('stops when the credits reach the per-hunt cap', async () => {
    const { hunt } = await endOf({ chunks: [stepCall(1), creditsLine(1.6)], hang: true });
    expect(hunt).toMatchObject({ status: 'failed', endReason: 'credit_cap', credits: 1.6 });
  });

  it('stops after more tool calls than allowed', async () => {
    const { hunt } = await endOf({ chunks: Array.from({ length: 25 }, (_, i) => loadLine(`l${i}`, 'query_metrics')), hang: true });
    expect(hunt).toMatchObject({ status: 'failed', endReason: 'tool_limit', toolCalls: 21 });
  });

  it('stops after more than 20 lines that are not JSON', async () => {
    const { hunt } = await endOf({ chunks: Array.from({ length: 25 }, () => 'not json at all\n'), hang: true });
    expect(hunt).toMatchObject({ status: 'failed', endReason: 'stream_error' });
  });

  it('maps the exit of the process: code 3, another code, a clean exit and no process', async () => {
    expect((await endOf({ code: 3 })).hunt).toMatchObject({ status: 'failed', endReason: 'mcp_startup' });
    expect((await endOf({ code: 1 })).hunt).toMatchObject({ status: 'failed', endReason: 'cli_error' });
    expect((await endOf({ code: 0, chunks: [stepCall(1)] })).hunt).toMatchObject({ status: 'failed', endReason: 'no_diagnosis' });
    expect((await endOf({ spawnFailed: true })).hunt).toMatchObject({ status: 'failed', endReason: 'cli_error' });
  });

  it('fails a diagnosis that names a commit the lab does not serve, and says which check failed', async () => {
    const g = goodRun();
    const { h } = setup(() => ({ ledger: g.ledger, chunks: g.chunks }));
    h.lab.unreachable.add(SHA);
    const r = await ask(h);
    await settle();
    expect(h.store.byId(r.huntId)).toMatchObject({ status: 'failed', endReason: 'invalid_diagnosis', invalidCheck: 'sha_unreachable', diagnosis: null });
    const fin = h.events.find((e) => e.name === 'hunt.finished')?.payload;
    expect(fin).toMatchObject({ status: 'failed', reason: 'invalid_diagnosis', invalidCheck: 'sha_unreachable' });
    expect(h.events.some((e) => e.name === 'hunt.diagnosis')).toBe(false);
    expect(h.runner.latest('payments')?.diagnosis).toBeNull();
  });

  it('fails the Hunt when the working folder is refused', async () => {
    const { h } = setup(good);
    h.workdir.failPrepare = true;
    const r = await ask(h);
    await settle();
    expect(h.store.byId(r.huntId)).toMatchObject({ status: 'failed', endReason: 'cli_error' });
    expect(h.spawner.processes).toHaveLength(0);
  });
});

describe('HuntRunner: shutdown and restart', () => {
  it('cancels the queued Hunt and stops the running one on shutdown', async () => {
    const { h } = setup(hang);
    const a = await ask(h);
    await settle();
    const b = await ask(h);
    await h.runner.stop();
    expect(h.store.byId(a.huntId)).toMatchObject({ status: 'cancelled', endReason: 'shutdown' });
    expect(h.store.byId(b.huntId)).toMatchObject({ status: 'cancelled', endReason: 'shutdown' });
    expect(await h.runner.request({ trigger: 'operator', service: 'payments' })).toEqual({ kind: 'skipped' });
    expect(huntSequenceErrors(h.events, statusOf(h))).toEqual([]);
  });

  it('marks Hunts left over by an earlier process as failed with api_restart when it starts', async () => {
    const { h, incident } = setup(good);
    const queued = await h.store.create({ incidentId: incident.incidentId, serviceId: incident.serviceId, trigger: 'auto', model: 'm' });
    const running = await h.store.create({ incidentId: incident.incidentId, serviceId: incident.serviceId, trigger: 'operator', model: 'm' });
    await h.store.markRunning(running.id, h.now());
    await h.runner.start();
    expect(h.store.byId(queued.id)).toMatchObject({ status: 'failed', endReason: 'api_restart' });
    expect(h.store.byId(running.id)).toMatchObject({ status: 'failed', endReason: 'api_restart' });
    expect(h.workdir.prepared).toBe(1);
    await h.runner.stop();
  });
});

describe('HuntRunner: a cascade opens several Incidents', () => {
  const open = (h: Harness, service: ServiceName, at: Date = OPENED) => {
    const facts = h.store.addIncident(service, at);
    h.bus.publish('incident.opened', { incidentId: facts.incidentId, service, openedAt: at.toISOString(), level: 3, reason: null });
    return facts;
  };

  it('hunts only the most downstream Service when three Incidents open within 5 s, and links the others', async () => {
    const h = harness({ pick: () => ({ hang: true }) });
    h.lab.deployList = labFor({ openedAt: OPENED }).deployList;
    await h.runner.start();
    const gate = open(h, 'gate', new Date(OPENED.getTime()));
    open(h, 'orders', new Date(OPENED.getTime() + 2000));
    const ledger = open(h, 'ledger', new Date(OPENED.getTime() + 5000));
    await sleep(80);
    await settle();
    expect(h.store.hunts).toHaveLength(1);
    expect(h.store.hunts[0]).toMatchObject({ trigger: 'auto', incidentId: ledger.incidentId, status: 'running' });
    expect(h.store.hunts.some((x) => x.incidentId === gate.incidentId)).toBe(false);
    const linked = h.logs.filter((l) => l.includes('"msg":"hunt linked"')).map((l) => JSON.parse(l) as { hunted: string });
    expect(linked.length).toBeGreaterThanOrEqual(1);
    expect(linked.every((l) => l.hunted === 'ledger')).toBe(true);
    await h.runner.stop();
  });

  it('hunts nothing for an Incident that closed during the settle window', async () => {
    const h = harness({ pick: () => ({ hang: true }) });
    await h.runner.start();
    const facts = open(h, 'payments');
    h.store.closeIncident(facts.incidentId, h.now());
    await sleep(60);
    await settle();
    expect(h.store.hunts).toHaveLength(0);
    await h.runner.stop();
  });

  it('queues a Hunt downstream of the running one instead of calling it busy, and withdraws a queued upstream Hunt', async () => {
    const h = harness({ pick: () => ({ hang: true }) });
    h.lab.deployList = labFor({ openedAt: OPENED }).deployList;
    await h.runner.start();
    const gate = open(h, 'gate');
    await sleep(60);
    await settle();
    expect(h.store.hunts[0]).toMatchObject({ incidentId: gate.incidentId, status: 'running' });
    // An operator asks for orders (queued behind gate); then ledger opens downstream of both.
    const orders = h.store.addIncident('orders', OPENED);
    const auto = await h.runner.request({ trigger: 'auto', incidentId: orders.incidentId });
    expect(auto).toMatchObject({ kind: 'recorded', status: 'queued' });
    const ledger = open(h, 'ledger');
    await sleep(60);
    await settle();
    const byIncident = (id: string) => h.store.hunts.find((x) => x.incidentId === id);
    expect(byIncident(orders.incidentId)).toMatchObject({ status: 'cancelled', endReason: 'downstream' });
    expect(byIncident(ledger.incidentId)).toMatchObject({ status: 'queued', trigger: 'auto' });
    expect(byIncident(gate.incidentId)?.status).toBe('running');
    // When the running one ends, the downstream Hunt starts.
    h.spawner.byHunt(byIncident(gate.incidentId)!.id)?.release(0);
    await settle();
    expect(byIncident(ledger.incidentId)?.status).toBe('running');
    await h.runner.stop();
    expect(huntSequenceErrors(h.events, statusOf(h))).toEqual([]);
  });

  it('does not withdraw a queued operator Hunt, and does not change an operator request', async () => {
    const h = harness({ pick: () => ({ hang: true }) });
    await h.runner.start();
    const gate = open(h, 'gate');
    await sleep(60);
    await settle();
    const ledger = open(h, 'ledger');
    // An operator Hunt for payments takes the queue slot before the settle window of ledger ends.
    h.store.addIncident('payments', OPENED);
    const op = await ask(h, 'payments');
    expect(op.status).toBe('queued');
    await sleep(60);
    await settle();
    expect(h.store.byId(op.huntId).status).toBe('queued');
    expect(h.store.hunts.find((x) => x.incidentId === ledger.incidentId)).toMatchObject({ status: 'cancelled', endReason: 'busy' });
    expect(h.store.hunts.find((x) => x.incidentId === gate.incidentId)?.status).toBe('running');
    await h.runner.stop();
  });

  it('keeps an operator request for an upstream Service as it is', async () => {
    const h = harness({ pick: () => ({ hang: true }) });
    await h.runner.start();
    h.store.addIncident('ledger', OPENED);
    const gate = h.store.addIncident('gate', OPENED);
    const r = await h.runner.request({ trigger: 'operator', incidentId: gate.incidentId });
    expect(r).toMatchObject({ kind: 'recorded', status: 'queued' });
    await settle();
    expect(h.store.byId((r as { huntId: string }).huntId)).toMatchObject({ trigger: 'operator', status: 'running' });
    await h.runner.stop();
  });
});

describe('HuntRunner: what stopped a Hunt', () => {
  it('records the refused tool title and the Tool Load ids, cleaned, and nothing else of the call', async () => {
    const g = goodRun();
    const hostile = 'fs_read\u001b[31m' + 'x'.repeat(200);
    const { h } = setup(() => ({ ledger: g.ledger, chunks: [toolCallLine('x1', hostile, { path: '/etc/hosts', secret: 'do-not-keep' }), ...g.chunks], hang: true }));
    const r = await ask(h);
    await settle();
    const stored = h.store.byId(r.huntId);
    expect(stored).toMatchObject({ status: 'failed', endReason: 'foreign_tool' });
    expect(stored.stopDetail).toHaveLength(80);
    expect(stored.stopDetail).toMatch(/^fs_read +\[31mx+$/);
    expect(h.logs.join('')).not.toContain('do-not-keep');
    expect(h.logs.join('')).not.toContain('/etc/hosts');
    expect(h.logs.some((l) => l.includes('"msg":"hunt stopped"') && l.includes('fs_read'))).toBe(true);
    const bad = setup(() => ({ chunks: [toolCallLine('x2', 'Tool Load', { ids: ['@exorcist/query_metrics', 'fs_write', '\u0007bell'] })], hang: true }));
    const r2 = await ask(bad.h);
    await settle();
    expect(bad.h.store.byId(r2.huntId).stopDetail).toBe('Tool Load ids=[@exorcist/query_metrics,fs_write,bell]');
    // A Hunt that did not stop for a foreign tool has no detail.
    const fine = setup(good);
    const r3 = await ask(fine.h);
    await settle();
    expect(fine.h.store.byId(r3.huntId).stopDetail).toBeNull();
  });

  it('does not judge a call again when its id comes back, and accepts every Tool Load shape of the six tools', async () => {
    const shapes = [
      { id: 'tool::exorcist::query_metrics' },
      { tool_id: 'tool::exorcist::query_metrics' },
      { tool_ids: ['tool::exorcist::query_metrics'] },
      { ids: ['@exorcist/query_metrics'] },
      { tools: ['query_metrics'] },
      { toolIds: ['tool::exorcist::query_metrics', '@exorcist/tail_logs'] },
    ];
    const g = goodRun();
    const chunks = [
      ...shapes.map((s, i) => toolCallLine(`l${i}`, 'Tool Load', s)),
      // The same call again, and the updates of the real 3.3.0 sequence, are not new calls.
      toolCallLine('l0', 'Tool Load', { id: 'tool::exorcist::query_metrics' }),
      toolUpdateWith('l0', 'completed', 'Tool Load'),
      toolCallLine('c1', '@exorcist/query_metrics', { service: 'payments', signal: 'error_ratio', window: '15m' }),
      toolUpdateWith('c1', 'in_progress', null),
      toolUpdateWith('c1', 'completed', '@exorcist/query_metrics'),
      ...g.chunks.filter((c) => !c.includes('Tool Load')),
    ];
    const { h } = setup(() => ({ ledger: g.ledger, chunks, code: 0 }), testHuntConfig({ HUNT_MAX_TOOL_CALLS: '30' }));
    const r = await ask(h);
    await settle();
    expect(h.store.byId(r.huntId)).toMatchObject({ status: 'succeeded', endReason: 'diagnosed' });
  });

  it('refuses an accepted call id that comes back naming another tool, as a call or as an update', async () => {
    const accepted = toolCallLine('c1', '@exorcist/query_metrics', { service: 'payments', signal: 'error_ratio', window: '15m' });
    const cases: Array<[string, string[]]> = [
      ['fs_read', [accepted, toolCallLine('c1', 'fs_read', { path: '/etc/hosts' })]],
      ['fs_read (update)', [accepted, toolUpdateWith('c1', 'in_progress', 'fs_read', { path: '/etc/hosts' })]],
      ['other exorcist tool', [accepted, toolUpdateWith('c1', 'completed', '@exorcist/tail_logs')]],
      ['load for the step id', [accepted, toolCallLine('c1', 'Tool Load', { id: 'tool::exorcist::query_metrics' })]],
      ['wrapper for another tool', [accepted, toolCallLine('c1', 'Tool Call', { tool_id: 'tool::exorcist::tail_logs', arguments: {} })]],
      ['update of a load naming a tool', [loadLine('l1', 'query_metrics'), toolUpdateWith('l1', 'completed', 'fs_read')]],
    ];
    for (const [label, chunks] of cases) {
      const { h } = setup(() => ({ chunks, hang: true }));
      const r = await ask(h);
      await settle();
      expect(h.store.byId(r.huntId), label).toMatchObject({ status: 'failed', endReason: 'foreign_tool' });
    }
  });

  it('ignores an update of an unknown id unless it names a tool the allow-list refuses', async () => {
    const g = goodRun();
    const fine = setup(() => ({ ledger: g.ledger, chunks: [toolUpdateWith('zz', 'completed', '@exorcist/query_metrics'), toolUpdateWith('zz', 'completed', null), ...g.chunks], code: 0 }));
    const r1 = await ask(fine.h);
    await settle();
    expect(fine.h.store.byId(r1.huntId)).toMatchObject({ status: 'succeeded', toolCalls: 5 });
    const bad = setup(() => ({ chunks: [toolUpdateWith('zz', 'in_progress', 'execute_bash', { command: 'ls' })], hang: true }));
    const r2 = await ask(bad.h);
    await settle();
    expect(bad.h.store.byId(r2.huntId)).toMatchObject({ status: 'failed', endReason: 'foreign_tool' });
  });

  it('reads the diagnosis from the fullest input of later updates of the same id', async () => {
    const g = goodRun();
    const head = g.chunks.slice(0, 7);
    const tail = g.chunks.slice(9);
    // The call starts with an empty input and a later update carries the whole of it (direct, then wrapped).
    const direct = setup(() => ({
      ledger: g.ledger,
      chunks: [...head, toolCallLine('d1', '@exorcist/submit_diagnosis', {}), toolUpdateWith('d1', 'in_progress', null), toolUpdateWith('d1', 'completed', '@exorcist/submit_diagnosis', g.input), ...tail],
      code: 0,
    }));
    const r = await ask(direct.h);
    await settle();
    expect(direct.h.store.byId(r.huntId)).toMatchObject({ status: 'succeeded', endReason: 'diagnosed' });
    const wrapped = setup(() => ({
      ledger: g.ledger,
      chunks: [
        ...head,
        toolCallLine('d2', 'Tool Call', { tool_id: 'tool::exorcist::submit_diagnosis', arguments: {} }),
        toolUpdateWith('d2', 'completed', 'Tool Call', { tool_id: 'tool::exorcist::submit_diagnosis', arguments: g.input }),
        ...tail,
      ],
      code: 0,
    }));
    const r2 = await ask(wrapped.h);
    await settle();
    expect(wrapped.h.store.byId(r2.huntId)).toMatchObject({ status: 'succeeded', endReason: 'diagnosed' });
  });
});

describe('HuntRunner: the Tool Call wrapper of kiro-cli 3.3.0', () => {
  const wrap = (id: string, tool: string, args: unknown): string => toolCallLine(id, 'Tool Call', { tool_id: `tool::exorcist::${tool}`, arguments: args });

  it('counts wrapped calls as steps, reads the diagnosis from the arguments, and does not count their updates again', async () => {
    const g = goodRun();
    const chunks = [
      loadLine('l1', 'query_metrics'),
      wrap('w1', 'query_metrics', { service: 'payments', signal: 'error_ratio', window: '15m' }),
      // The updates of an accepted call, with no title and then with the same one: not judged, not counted.
      toolUpdateWith('w1', 'in_progress', null),
      toolUpdateWith('w1', 'completed', 'Tool Call', { tool_id: 'tool::exorcist::query_metrics', arguments: { service: 'payments', signal: 'error_ratio', window: '15m' } }),
      wrap('w2', 'recent_deploys', { since: '2026-11-13T10:20:00Z' }),
      wrap('w3', 'diff_commit', { sha: SHA }),
      // The diagnosis is wrapped too: the stream input is the arguments.
      wrap('w4', 'submit_diagnosis', g.input),
      toolCallLine('w4', 'Tool Call', { tool_id: 'tool::exorcist::submit_diagnosis', arguments: g.input }),
      creditsLine(0.9),
    ];
    const { h } = setup(() => ({ ledger: g.ledger, chunks, code: 0 }));
    const r = await ask(h);
    await settle();
    const stored = h.store.byId(r.huntId);
    expect(stored).toMatchObject({ status: 'succeeded', endReason: 'diagnosed', toolCalls: 5 });
    expect(stored.steps.map((s) => [s.index, s.tool, s.summary])).toEqual([
      [1, 'query_metrics', 'metrics payments error_ratio 15m'],
      [2, 'recent_deploys', 'deploys since 10:20'],
      [3, 'diff_commit', `diff ${SHA.slice(0, 7)}`],
      [4, 'submit_diagnosis', 'diagnosis submitted'],
    ]);
    expect(stored.stopDetail).toBeNull();
  });

  it('stops for a wrapper that names another server or a built-in tool, and names its tool_id', async () => {
    for (const toolId of ['tool::builtin::execute_bash', 'tool::other::query_metrics', 'tool::exorcist::fs_read']) {
      const { h } = setup(() => ({ chunks: [toolCallLine('x1', 'Tool Call', { tool_id: toolId, arguments: { command: 'ls' } })], hang: true }));
      const r = await ask(h);
      await settle();
      expect(h.store.byId(r.huntId)).toMatchObject({ status: 'failed', endReason: 'foreign_tool', stopDetail: `Tool Call tool_id=${toolId}` });
    }
    const extra = setup(() => ({ chunks: [toolCallLine('x2', 'Tool Call', { tool_id: 'tool::exorcist::diff_commit', arguments: {}, command: 'ls' })], hang: true }));
    const r = await ask(extra.h);
    await settle();
    expect(extra.h.store.byId(r.huntId)).toMatchObject({ status: 'failed', endReason: 'foreign_tool' });
  });
});

// Feature: exorcist-agent, Property 17
describe('Property 17 (runner): any cascade gets one automatic Hunt, on its most downstream Service', () => {
  it('holds for any set of Incidents opened in any order inside the settle window', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uniqueArray(fc.constantFrom(...SERVICE_NAMES), { minLength: 1, maxLength: 4 }), async (order) => {
        const h = harness({ pick: () => ({ hang: true }) });
        await h.runner.start();
        for (const service of order) {
          const facts = h.store.addIncident(service, OPENED);
          h.bus.publish('incident.opened', { incidentId: facts.incidentId, service, openedAt: OPENED.toISOString(), level: 3, reason: null });
        }
        await sleep(40);
        await settle(30);
        const autos = h.store.hunts.filter((x) => x.trigger === 'auto');
        expect(autos).toHaveLength(1);
        expect(h.store.incidents.get(autos[0]!.incidentId)?.service).toBe(mostDownstream(order));
        await h.runner.stop();
      }),
      { numRuns: 25 },
    );
  });
});

describe('HuntRunner: a late Incident of a Service that an upstream Hunt already diagnosed', () => {
  const GOOD_SHA = '65c0fca31d0df62c4bab40d2d854c81b1044c650';
  const PAIRS = SERVICE_NAMES.flatMap((u) => downstreamOf(u).map((s) => [u, s] as const));

  /** A harness whose first Hunt (on `u`) submits a valid diagnosis that blames the deploy of `s`, and then waits to be released. */
  function cascade(u: ServiceName, s: ServiceName, hangs: boolean, timers?: HuntRunnerDeps['timers']) {
    const g = goodRun({ service: u });
    const h = harness({ pick: (_id, i) => (i === 0 ? { ledger: g.ledger, chunks: g.chunks, hang: hangs } : { hang: true }), timers });
    h.lab.deployList = [{ id: 'd-7', service: s, sha: GOOD_SHA, time: new Date(OPENED.getTime() - 30_000).toISOString() }];
    const open = (service: ServiceName, at: Date) => {
      const facts = h.store.addIncident(service, at);
      h.bus.publish('incident.opened', { incidentId: facts.incidentId, service, openedAt: at.toISOString(), level: 3, reason: null });
      return facts;
    };
    return { h, open };
  }
  const byIncident = (h: Harness, id: string) => h.store.hunts.find((x) => x.incidentId === id);

  // Feature: exorcist-agent, Property 20
  it('never gives the Service named as the cause a Hunt of its own: queued behind the upstream Hunt, or late', async () => {
    for (const [u, s] of PAIRS) {
      // (a) the downstream Incident opens while the upstream Hunt runs: it is queued, then withdrawn.
      {
        const { h, open } = cascade(u, s, true);
        await h.runner.start();
        const up = open(u, OPENED);
        await sleep(30);
        await settle();
        const down = open(s, new Date(OPENED.getTime() + 1000));
        await sleep(30);
        await settle();
        expect(byIncident(h, down.incidentId), `${u}/${s} queued`).toMatchObject({ status: 'queued', trigger: 'auto' });
        h.spawner.byHunt(byIncident(h, up.incidentId)!.id)?.release(0);
        await settle();
        expect(byIncident(h, up.incidentId), `${u}/${s}`).toMatchObject({ status: 'succeeded', endReason: 'diagnosed' });
        expect(h.store.byId(byIncident(h, up.incidentId)!.id).diagnosis?.culpritService).toBe(s);
        expect(byIncident(h, down.incidentId), `${u}/${s} withdrawn`).toMatchObject({ status: 'cancelled', endReason: 'diagnosed_upstream' });
        expect(h.spawner.processes, `${u}/${s} processes`).toHaveLength(1);
        const fin = h.events.find((e) => e.name === 'hunt.finished' && (e.payload as { huntId: string }).huntId === byIncident(h, down.incidentId)!.id)?.payload;
        expect(fin).toMatchObject({ status: 'cancelled', reason: 'diagnosed_upstream', diagnosedBy: u });
        expect(huntSequenceErrors(h.events, statusOf(h))).toEqual([]);
        await h.runner.stop();
      }
      // (b) the downstream Incident opens right after the diagnosis, inside the settle window.
      {
        const { h, open } = cascade(u, s, false);
        await h.runner.start();
        const up = open(u, OPENED);
        await sleep(40);
        await settle();
        expect(byIncident(h, up.incidentId)?.status).toBe('succeeded');
        const down = open(s, new Date(h.clock.t + 2));
        await sleep(40);
        await settle();
        expect(byIncident(h, down.incidentId), `${u}/${s} late`).toMatchObject({ status: 'cancelled', endReason: 'diagnosed_upstream' });
        expect(h.spawner.processes).toHaveLength(1);
        await h.runner.stop();
      }
      // (c) the downstream Incident opened before the diagnosis, but its settle window ends after it.
      {
        const fired: Array<() => void> = [];
        const timers = { set: (fn: () => void) => fired.push(fn) - 1, clear: () => undefined };
        const { h, open } = cascade(u, s, true, timers);
        await h.runner.start();
        const up = open(u, OPENED);
        fired[0]!();
        await settle();
        const down = open(s, new Date(OPENED.getTime() + 1000));
        h.spawner.byHunt(byIncident(h, up.incidentId)!.id)?.release(0);
        await settle();
        expect(byIncident(h, up.incidentId)?.status).toBe('succeeded');
        expect(byIncident(h, down.incidentId)).toBeUndefined();
        fired[1]!();
        await settle();
        expect(byIncident(h, down.incidentId), `${u}/${s} timer after`).toMatchObject({ status: 'cancelled', endReason: 'diagnosed_upstream' });
        expect(h.spawner.processes).toHaveLength(1);
        await h.runner.stop();
      }
    }
  });

  it('hunts an Incident of that Service that opens long after the settle window, and an operator request at any time', async () => {
    const { h, open } = cascade('payments', 'ledger', false);
    await h.runner.start();
    const up = open('payments', OPENED);
    await sleep(40);
    await settle();
    expect(byIncident(h, up.incidentId)?.status).toBe('succeeded');
    const late = open('ledger', new Date(h.clock.t + 10_000));
    await sleep(40);
    await settle();
    expect(byIncident(h, late.incidentId)).toMatchObject({ trigger: 'auto', status: 'running' });
    const operator = await h.runner.request({ trigger: 'operator', service: 'ledger' });
    expect(operator).toMatchObject({ kind: 'recorded', status: 'queued' });
    await h.runner.stop();
  });

  it('does not withdraw a queued Hunt whose Incident opened before the diagnosed one, nor an operator Hunt', async () => {
    const { h } = cascade('payments', 'ledger', true);
    await h.runner.start();
    const earlier = h.store.addIncident('ledger', new Date(OPENED.getTime() - 5000));
    const up = h.store.addIncident('payments', OPENED);
    const first = await h.runner.request({ trigger: 'operator', incidentId: up.incidentId });
    await settle();
    const queuedAuto = await h.runner.request({ trigger: 'auto', incidentId: earlier.incidentId });
    expect(queuedAuto).toMatchObject({ status: 'queued' });
    h.spawner.byHunt((first as { huntId: string }).huntId)?.release(0);
    await settle();
    expect(h.store.byId((first as { huntId: string }).huntId).status).toBe('succeeded');
    expect(h.store.byId((queuedAuto as { huntId: string }).huntId).status).toBe('running');
    await h.runner.stop();
  });

  it('keeps a queued operator Hunt of the diagnosed Service', async () => {
    const { h } = cascade('payments', 'ledger', true);
    await h.runner.start();
    const up = h.store.addIncident('payments', OPENED);
    h.store.addIncident('ledger', new Date(OPENED.getTime() + 1000));
    const first = await h.runner.request({ trigger: 'operator', incidentId: up.incidentId });
    await settle();
    const op = await h.runner.request({ trigger: 'operator', service: 'ledger' });
    expect(op).toMatchObject({ status: 'queued' });
    h.spawner.byHunt((first as { huntId: string }).huntId)?.release(0);
    await settle();
    expect(h.store.byId((op as { huntId: string }).huntId).status).toBe('running');
    await h.runner.stop();
  });
});

describe('HuntRunner: estimated credits', () => {
  const endOf = async (script: Script, config = testHuntConfig()) => {
    const { h } = setup(() => script, config);
    const r = await ask(h);
    await settle();
    return { h, hunt: h.store.byId(r.huntId) };
  };

  it('charges the per-hunt cap, marked as estimated, to a Hunt that ended without a Credits report', async () => {
    const cases: Array<[string, Script, string]> = [
      ['foreign tool', { chunks: [stepCall(1), toolCallLine('x', 'execute_bash', { command: 'ls' })], hang: true }, 'foreign_tool'],
      ['tool limit', { chunks: Array.from({ length: 25 }, (_, i) => loadLine(`l${i}`, 'query_metrics')), hang: true }, 'tool_limit'],
      ['no diagnosis', { code: 0, chunks: [stepCall(1)] }, 'no_diagnosis'],
      ['cli error', { code: 1 }, 'cli_error'],
      ['mcp startup', { code: 3 }, 'mcp_startup'],
    ];
    for (const [label, script, reason] of cases) {
      const { h, hunt } = await endOf(script);
      expect(hunt, label).toMatchObject({ endReason: reason, credits: 1.5, creditsEstimated: true });
      // It counts in the daily budget.
      expect(await h.store.creditsToday(h.now()), label).toBe(1.5);
    }
  });

  it('charges the cap to a Hunt stopped by the Kill switch or a shutdown', async () => {
    const { h } = setup(hang);
    const a = await ask(h);
    await settle();
    expect(await h.runner.setEnabled(false)).toBe(false);
    await settle();
    expect(h.store.byId(a.huntId)).toMatchObject({ endReason: 'disabled', credits: 1.5, creditsEstimated: true });
    const s = setup(hang);
    const b = await ask(s.h);
    await settle();
    await s.h.runner.stop();
    expect(s.h.store.byId(b.huntId)).toMatchObject({ endReason: 'shutdown', credits: 1.5, creditsEstimated: true });
  });

  it('keeps the reported amount when there was a Credits report, and charges nothing when the process never started', async () => {
    const reported = await endOf({ chunks: [stepCall(1), creditsLine(1.6)], hang: true });
    expect(reported.hunt).toMatchObject({ endReason: 'credit_cap', credits: 1.6, creditsEstimated: false });
    const good1 = await endOf(good());
    expect(good1.hunt).toMatchObject({ status: 'succeeded', credits: 0.9, creditsEstimated: false });
    const never = await endOf({ spawnFailed: true });
    expect(never.hunt).toMatchObject({ endReason: 'cli_error', credits: 0, creditsEstimated: false });
    const refused = setup(good);
    refused.h.workdir.failPrepare = true;
    const r = await ask(refused.h);
    await settle();
    expect(refused.h.store.byId(r.huntId)).toMatchObject({ credits: 0, creditsEstimated: false });
  });

  it('lets estimated credits use up the daily budget', async () => {
    const { h } = setup(() => ({ code: 1 }), testHuntConfig({ HUNT_DAILY_CREDIT_CAP: '3', HUNT_COOLDOWN_MS: '0' }));
    const outcomes: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await ask(h);
      await settle();
      outcomes.push(h.store.byId(r.huntId).endReason ?? '');
    }
    // 1.5 + 1.5 = 3, and the third would not fit.
    expect(outcomes).toEqual(['cli_error', 'cli_error', 'daily_cap']);
  });
});

describe('HuntRunner: Hunts per day', () => {
  const two = testHuntConfig({ HUNT_DAILY_MAX: '2', HUNT_COOLDOWN_MS: '0' });

  it('records a request beyond HUNT_DAILY_MAX as cancelled with daily_limit, operator and auto together', async () => {
    const { h, incident } = setup(good, two);
    await ask(h);
    await settle();
    const second = h.store.addIncident('orders', new Date(h.clock.t), 3);
    expect(await h.runner.request({ trigger: 'auto', incidentId: second.incidentId })).toMatchObject({ status: 'queued' });
    await settle();
    const third = await ask(h);
    expect(third).toMatchObject({ status: 'cancelled', reason: 'daily_limit' });
    expect(h.store.byId(third.huntId)).toMatchObject({ status: 'cancelled', endReason: 'daily_limit' });
    const fourth = h.store.addIncident('payments', new Date(h.clock.t), 3);
    expect(await h.runner.request({ trigger: 'auto', incidentId: fourth.incidentId })).toMatchObject({ status: 'cancelled', reason: 'daily_limit' });
    expect(h.spawner.processes).toHaveLength(2);
    expect(incident.incidentId).not.toBe(second.incidentId);
  });

  it('counts a Hunt that waits in the queue, and starts again the next UTC day', async () => {
    const { h } = setup(hang, two);
    await ask(h);
    await settle();
    expect(await ask(h)).toMatchObject({ status: 'queued' });
    expect(await ask(h)).toMatchObject({ status: 'cancelled', reason: 'daily_limit' });
    await h.runner.stop();
    const next = setup(good, two);
    await ask(next.h);
    await settle();
    await ask(next.h);
    await settle();
    expect(await ask(next.h)).toMatchObject({ status: 'cancelled', reason: 'daily_limit' });
    next.h.clock.t += 24 * 3_600_000;
    expect(await ask(next.h)).toMatchObject({ status: 'queued' });
  });

  it('checks the limit again when a queued Hunt is about to start', async () => {
    const { h } = setup(hang, testHuntConfig({ HUNT_DAILY_MAX: '2', HUNT_COOLDOWN_MS: '0' }));
    const a = await ask(h);
    await settle();
    const b = await ask(h);
    // Another Hunt of the day starts meanwhile (another process of the same database).
    const other = await h.store.create({ incidentId: 'x', serviceId: 'y', trigger: 'auto', model: 'm' });
    await h.store.markRunning(other.id, h.now());
    h.spawner.byHunt(a.huntId)?.release(0);
    await settle();
    expect(h.store.byId(b.huntId)).toMatchObject({ status: 'cancelled', endReason: 'daily_limit' });
  });
});

describe('HuntRunner: a diagnosis that arrived before a stop', () => {
  it('ends succeeded when the credit cap is reached after the diagnosis', async () => {
    const g = goodRun({ credits: 1.6 });
    const { h } = setup(() => ({ ledger: g.ledger, chunks: g.chunks, code: 0 }));
    const r = await ask(h);
    await settle();
    expect(h.store.byId(r.huntId)).toMatchObject({ status: 'succeeded', endReason: 'diagnosed', credits: 1.6, creditsEstimated: false });
    expect(h.store.byId(r.huntId).stopDetail).toMatch(/credit_cap/);
    expect(h.events.some((e) => e.name === 'hunt.diagnosis')).toBe(true);
  });

  it('ends succeeded when the tool limit is reached after the diagnosis', async () => {
    const g = goodRun();
    const extra = Array.from({ length: 22 }, (_, i) => loadLine(`z${i}`, 'query_metrics'));
    const { h } = setup(() => ({ ledger: g.ledger, chunks: [...g.chunks.slice(0, 9), ...extra, ...g.chunks.slice(9)], code: 0 }));
    const r = await ask(h);
    await settle();
    expect(h.store.byId(r.huntId)).toMatchObject({ status: 'succeeded', endReason: 'diagnosed' });
    expect(h.store.byId(r.huntId).stopDetail).toMatch(/tool_limit/);
  });

  it('still fails a stop with no diagnosis, and a diagnosis that does not validate', async () => {
    const none = setup(() => ({ chunks: [stepCall(1), creditsLine(1.6)], hang: true }));
    const r1 = await ask(none.h);
    await settle();
    expect(none.h.store.byId(r1.huntId)).toMatchObject({ status: 'failed', endReason: 'credit_cap' });
    const g = goodRun({ credits: 1.6 });
    const bad = setup(() => ({ ledger: g.ledger, chunks: g.chunks, code: 0 }));
    bad.h.lab.unreachable.add(SHA);
    const r2 = await ask(bad.h);
    await settle();
    expect(bad.h.store.byId(r2.huntId)).toMatchObject({ status: 'failed', endReason: 'credit_cap', diagnosis: null });
    expect(bad.h.events.some((e) => e.name === 'hunt.diagnosis')).toBe(false);
  });
});

describe('HuntRunner: a store that fails to take the end', () => {
  const failing = (h: Harness, times: number): { calls: () => number } => {
    const real = h.store.finish.bind(h.store);
    let n = 0;
    h.store.finish = async (id, f) => {
      n++;
      if (n <= times) throw Object.assign(new Error('connection to db.internal with password hunter2 lost'), { code: 'P1001' });
      return real(id, f);
    };
    return { calls: () => n };
  };

  it('tries again once, and the second try ends the Hunt normally', async () => {
    const { h } = setup(good);
    const f = failing(h, 1);
    const r = await ask(h);
    await settle();
    expect(f.calls()).toBe(2);
    expect(h.store.byId(r.huntId)).toMatchObject({ status: 'succeeded', endReason: 'diagnosed' });
    expect(names(h, r.huntId).slice(-2)).toEqual(['hunt.diagnosis', 'hunt.finished']);
    expect(h.logs.join('')).not.toContain('hunter2');
  });

  it('publishes the end anyway after two failures, drops the Hunt from memory and logs only the error code', async () => {
    const { h } = setup(good);
    const f = failing(h, 2);
    const r = await ask(h);
    await settle();
    expect(f.calls()).toBe(2);
    const finished = h.events.filter((e) => e.name === 'hunt.finished' && (e.payload as { huntId?: string }).huntId === r.huntId);
    expect(finished).toHaveLength(1);
    expect(finished[0]?.payload).toMatchObject({ status: 'failed', reason: 'cli_error' });
    // A diagnosis that was not stored is not shown.
    expect(h.events.some((e) => e.name === 'hunt.diagnosis')).toBe(false);
    expect(h.runner.latest('payments')).toBeNull();
    const text = h.logs.join('');
    expect(text).toContain('hunt finish failed');
    expect(text).toContain('P1001');
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('db.internal');
    // The runner goes on: the next Hunt runs.
    expect(await ask(h)).toMatchObject({ status: 'queued' });
    await settle();
  });

  it('publishes the end of a failed Hunt with its own reason after two failures', async () => {
    const { h } = setup(() => ({ code: 1 }));
    failing(h, 2);
    const r = await ask(h);
    await settle();
    const finished = h.events.find((e) => e.name === 'hunt.finished' && (e.payload as { huntId?: string }).huntId === r.huntId);
    expect(finished?.payload).toMatchObject({ status: 'failed', reason: 'cli_error', credits: 1.5 });
  });
});

describe('HuntRunner: the note of the process', () => {
  it('writes the pid note when the process starts and removes it when it ends', async () => {
    const { h } = setup(() => ({ hang: true, pid: 4242 }));
    const r = await ask(h);
    await settle();
    expect(h.workdir.pids.get(r.huntId)).toBe(4242);
    h.spawner.byHunt(r.huntId)?.release(0);
    await settle();
    expect(h.workdir.pids.size).toBe(0);
  });

  it('removes the note when the Hunt is stopped, and writes none for a process without a pid', async () => {
    const { h } = setup(() => ({ hang: true, pid: 77 }));
    const r = await ask(h);
    await settle();
    await h.runner.stop();
    expect(h.workdir.pids.has(r.huntId)).toBe(false);
    const quiet = setup(hang);
    await ask(quiet.h);
    await settle();
    expect(quiet.h.workdir.pids.size).toBe(0);
  });

  it('reaps leftover processes before it marks stale Hunts as lost', async () => {
    const { h } = setup(good);
    const sweep = h.store.sweepStale.bind(h.store);
    h.store.sweepStale = async (now) => {
      h.workdir.calls.push('sweep');
      return sweep(now);
    };
    h.workdir.reaped = 1;
    await h.runner.start();
    expect(h.workdir.calls.slice(0, 2)).toEqual(['reap', 'sweep']);
    expect(h.logs.some((l) => l.includes('hunt processes reaped'))).toBe(true);
    await h.runner.stop();
  });
});
