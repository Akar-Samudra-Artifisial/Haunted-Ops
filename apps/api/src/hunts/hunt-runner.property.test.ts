import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  creditsLine,
  goodRun,
  harness,
  huntSequenceErrors,
  labFor,
  loadLine,
  settle,
  toolCallLine,
  type Harness,
  type Script,
} from '../../test/support/hunts.js';
import type { ServiceName } from '@haunted-ops/shared';

const OPENED = new Date('2026-11-13T10:41:00.000Z');
const SERVICES: ServiceName[] = ['payments', 'orders'];
const COOLDOWN = 1000;

type Op =
  | { op: 'ask'; kind: 'operator' | 'auto'; service: ServiceName }
  | { op: 'finish' }
  | { op: 'disable' }
  | { op: 'enable' }
  | { op: 'tick'; ms: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ op: fc.constant('ask' as const), kind: fc.constantFrom('operator' as const, 'auto' as const), service: fc.constantFrom(...SERVICES) }) },
  { weight: 3, arbitrary: fc.constant({ op: 'finish' } as const) },
  { weight: 1, arbitrary: fc.constant({ op: 'disable' } as const) },
  { weight: 1, arbitrary: fc.constant({ op: 'enable' } as const) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant('tick' as const), ms: fc.integer({ min: 0, max: 1500 }) }) },
);

function build(pick?: (id: string, i: number) => Script): Harness {
  const h = harness({ pick, config: undefined });
  for (const s of SERVICES) h.store.addIncident(s, OPENED);
  h.lab.deployList = labFor({ openedAt: OPENED }).deployList;
  return h;
}

// Feature: exorcist-agent, Property 3
describe('Property 3: one Hunt runs, one waits, and the cooldown and the Kill switch hold', () => {
  it('matches a plain model of the queue under any interleaving of requests, endings, switches and time', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 24 }), async (ops) => {
        const h = build();
        const model = {
          running: null as { id: string; service: ServiceName } | null,
          queued: null as { id: string; service: ServiceName } | null,
          enabled: true,
          last: new Map<ServiceName, number>(),
          started: 0,
        };
        const startNext = (): void => {
          if (model.running === null && model.queued !== null) {
            model.running = model.queued;
            model.queued = null;
            model.started++;
          }
        };
        for (const step of ops) {
          if (step.op === 'ask') {
            let want: { status: 'queued' | 'cancelled'; reason: string | null };
            const cooled = step.kind === 'auto' && model.last.has(step.service) && h.clock.t - (model.last.get(step.service) as number) < COOLDOWN;
            if (!model.enabled) want = { status: 'cancelled', reason: 'disabled' };
            else if (model.running !== null && model.queued !== null) want = { status: 'cancelled', reason: 'busy' };
            else if (cooled) want = { status: 'cancelled', reason: 'cooldown' };
            else want = { status: 'queued', reason: null };
            const r =
              step.kind === 'auto'
                ? await h.runner.request({ trigger: 'auto', incidentId: h.store.addIncident(step.service, new Date(h.clock.t)).incidentId })
                : await h.runner.request({ trigger: 'operator', service: step.service });
            expect(r.kind).toBe('recorded');
            if (r.kind !== 'recorded') return;
            expect({ status: r.status, reason: r.reason }).toEqual(want);
            if (want.status === 'queued') {
              if (model.running === null) model.queued = { id: r.huntId, service: step.service };
              else model.queued = { id: r.huntId, service: step.service };
              startNext();
            }
          } else if (step.op === 'finish') {
            await settle();
            if (model.running !== null) {
              h.spawner.byHunt(model.running.id)?.release(0);
              model.last.set(model.running.service, h.clock.t);
              model.running = null;
              startNext();
            }
          } else if (step.op === 'disable') {
            await h.runner.setEnabled(false);
            model.enabled = false;
            model.queued = null;
            if (model.running !== null) {
              await settle();
              model.last.set(model.running.service, h.clock.t);
              model.running = null;
            }
          } else if (step.op === 'enable') {
            await h.runner.setEnabled(true);
            model.enabled = true;
          } else {
            h.clock.t += step.ms;
          }
          await settle();

          const count = (s: string): number => h.store.hunts.filter((x) => x.status === s).length;
          expect(count('running')).toBe(model.running === null ? 0 : 1);
          expect(count('queued')).toBe(model.queued === null ? 0 : 1);
          expect(h.spawner.maxLive).toBeLessThanOrEqual(1);
          expect(h.spawner.processes.filter((p) => p.started)).toHaveLength(model.started);
          if (model.running !== null) expect(h.store.byId(model.running.id).status).toBe('running');
          if (model.queued !== null) expect(h.store.byId(model.queued.id).status).toBe('queued');
        }
        await h.runner.stop();
        expect(h.store.hunts.every((x) => x.status !== 'queued' && x.status !== 'running')).toBe(true);
      }),
      { numRuns: 60 },
    );
  });
});

const stepCall = (n: number): string => toolCallLine(`c${n}`, '@exorcist/query_metrics', { service: 'payments', signal: 'error_ratio', window: '15m' });
const good = (): Script => {
  const g = goodRun();
  return { ledger: g.ledger, chunks: g.chunks };
};
const SCRIPTS: Script[] = [
  good(),
  { ...good(), code: 1 },
  { chunks: [stepCall(1), toolCallLine('x', 'execute_bash', { command: 'ls' }), stepCall(2)], hang: true },
  { chunks: [stepCall(1), creditsLine(1.7)], hang: true },
  { chunks: [stepCall(1), stepCall(2)] },
  { chunks: Array.from({ length: 25 }, () => 'garbage\n'), hang: true },
  { chunks: Array.from({ length: 25 }, (_, i) => loadLine(`l${i}`, 'tail_logs')), hang: true },
  { code: 3 },
  { spawnFailed: true },
  { hang: true },
  { ledger: good().ledger, chunks: [...(good().chunks ?? [])].reverse() },
];

// Feature: exorcist-agent, Property 9
describe('Property 9: hunt events form one well-ordered sequence per Hunt', () => {
  it('holds for every kind of ending, with every payload valid', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: SCRIPTS.length - 1 }), { minLength: 1, maxLength: 6 }),
        fc.array(opArb, { minLength: 1, maxLength: 18 }),
        async (scriptIds, ops) => {
          const h = build((_, i) => SCRIPTS[scriptIds[i % scriptIds.length] as number] as Script);
          for (const step of ops) {
            if (step.op === 'ask') {
              if (step.kind === 'auto') await h.runner.request({ trigger: 'auto', incidentId: h.store.addIncident(step.service, new Date(h.clock.t)).incidentId });
              else await h.runner.request({ trigger: 'operator', service: step.service });
            } else if (step.op === 'finish') {
              for (const p of h.spawner.processes) p.release(0);
            } else if (step.op === 'disable') await h.runner.setEnabled(false);
            else if (step.op === 'enable') await h.runner.setEnabled(true);
            else h.clock.t += step.ms;
            await settle(30);
          }
          for (const p of h.spawner.processes) p.release(0);
          await settle();
          await h.runner.stop();

          expect(huntSequenceErrors(h.events, (id) => h.store.hunts.find((x) => x.id === id)?.status)).toEqual([]);
          // The bus validates every payload with the shared validators; a refusal is logged by name.
          expect(h.logs.filter((l) => l.includes('hunt event not published'))).toEqual([]);
          const ended = new Set(h.events.filter((e) => e.name === 'hunt.finished').map((e) => (e.payload as { huntId: string }).huntId));
          expect(ended.size).toBe(h.store.hunts.length);
          for (const x of h.store.hunts) {
            expect(['succeeded', 'failed', 'cancelled']).toContain(x.status);
            expect((x.status === 'succeeded') === (x.endReason === 'diagnosed')).toBe(true);
            expect((x.diagnosis !== null) === (x.status === 'succeeded')).toBe(true);
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});
