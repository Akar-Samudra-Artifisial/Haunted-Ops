import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { SERVICE_NAMES, isCulpritCandidate, type DiagnosisCheck, type ServiceName } from '@haunted-ops/shared';
import type { LedgerLine } from '@haunted-ops/exorcist-mcp/ledger';
import type { SubmitDiagnosisInput } from '@haunted-ops/exorcist-mcp/schemas';
import { validateDiagnosis, type DiagnosisVerdict } from './diagnosis-validator.js';
import { MemoryLab } from '../../test/support/hunts.js';

const RUNS = { numRuns: 300 };
const SHA = '65c0fca31d0df62c4bab40d2d854c81b1044c650';
const OPENED = Date.parse('2026-11-13T10:41:00.000Z');

/** Each tampering breaks exactly one check; `rank` is the place of that check in the design table. */
const TAMPERINGS = {
  no_diagnosis: { rank: -1 },
  duplicate: { rank: 0, check: 'stream_mismatch' },
  stream: { rank: 0, check: 'stream_mismatch' },
  service: { rank: 1, check: 'service' },
  lab_deploys: { rank: 2, check: 'lab_unavailable' },
  deploy_unknown: { rank: 3, check: 'deploy_unknown' },
  deploy_service: { rank: 4, check: 'deploy_service' },
  deploy_late: { rank: 5, check: 'deploy_after_incident' },
  sha_mismatch: { rank: 6, check: 'sha_mismatch' },
  sha_unreachable: { rank: 7, check: 'sha_unreachable' },
  lab_commit: { rank: 7, check: 'lab_unavailable' },
  evidence_unseen: { rank: 8, check: 'evidence_unseen' },
  evidence_kind: { rank: 8, check: 'evidence_kind' },
  not_cited: { rank: 9, check: 'culprit_not_cited' },
} as const;
type Tampering = keyof typeof TAMPERINGS;
const ALL = Object.keys(TAMPERINGS) as Tampering[];

/** Two tamperings of the same rank would give two answers; the property is about the first failure. */
const unambiguous = (set: Tampering[]): boolean => {
  const same = (a: Tampering, b: Tampering): boolean => set.includes(a) && set.includes(b);
  return !same('sha_unreachable', 'lab_commit') && !same('evidence_unseen', 'evidence_kind');
};

function build(set: readonly Tampering[], extraDeploys: number, summary: string, over: { incident?: ServiceName; deployService?: ServiceName } = {}) {
  const has = (t: Tampering): boolean => set.includes(t);
  let input: SubmitDiagnosisInput = {
    service: over.incident ?? 'payments',
    culprit_deploy: 'd-7',
    culprit_sha: SHA.slice(0, 7),
    summary,
    evidence: [
      { kind: 'metric', ref: 'metric:payments/error_ratio/15m', detail: 'errors rose' },
      { kind: 'deploy', ref: 'deploy:d-7', detail: 'the deploy' },
      { kind: 'commit', ref: `commit:${SHA}`, detail: 'the commit' },
    ],
    fix_hint: 'Restore the guard.',
  };
  if (has('service')) input = { ...input, service: 'orders' };
  if (has('deploy_unknown')) input = { ...input, culprit_deploy: 'd-99' };
  if (has('sha_mismatch')) input = { ...input, culprit_sha: 'deadbee' };
  if (has('evidence_unseen')) input = { ...input, evidence: [{ kind: 'log', ref: 'log:99', detail: 'x' }, ...input.evidence.slice(1)] };
  if (has('evidence_kind')) input = { ...input, evidence: [{ kind: 'log', ref: 'metric:payments/error_ratio/15m', detail: 'x' }, ...input.evidence.slice(1)] };
  if (has('not_cited')) input = { ...input, evidence: input.evidence.slice(0, 1) };

  const handle = (h: string, kind: 'metric' | 'deploy' | 'commit', seq: number): LedgerLine => ({
    type: 'handle',
    seq,
    at: '2026-11-13T10:41:30.000Z',
    handle: h,
    kind,
    tool: 'query_metrics',
    service: null,
    deployId: null,
    sha: null,
    detail: h,
  });
  const diagnosis = (seq: number): LedgerLine => ({ type: 'diagnosis', seq, input, at: '2026-11-13T10:42:00.000Z' });
  const ledger: LedgerLine[] = [handle('metric:payments/error_ratio/15m', 'metric', 1), handle('deploy:d-7', 'deploy', 2), handle(`commit:${SHA}`, 'commit', 3)];
  if (!has('no_diagnosis')) ledger.push(diagnosis(4));
  if (has('duplicate') && !has('no_diagnosis')) ledger.push(diagnosis(5));
  const streamInput: unknown = has('stream') ? { ...input, summary: `${input.summary} (changed)` } : input;

  const lab = new MemoryLab();
  lab.deployList = [
    ...Array.from({ length: extraDeploys }, (_, i) => ({ id: `d-${10 + i}`, service: 'orders', sha: 'c'.repeat(39) + String(i % 10), time: new Date(OPENED - 3_600_000).toISOString() })),
    {
      id: 'd-7',
      service: has('deploy_service') ? 'orders' : (over.deployService ?? over.incident ?? 'payments'),
      sha: SHA,
      time: new Date(OPENED + (has('deploy_late') ? 61_000 : -30_000)).toISOString(),
    },
  ];
  lab.deploysDown = has('lab_deploys');
  lab.commitsDown = has('lab_commit');
  if (has('sha_unreachable')) lab.unreachable.add(SHA);
  return { ledger, streamInput, lab, input };
}

const expected = (set: readonly Tampering[]): DiagnosisVerdict | 'valid' => {
  if (set.length === 0) return 'valid';
  const first = [...set].sort((a, b) => TAMPERINGS[a].rank - TAMPERINGS[b].rank)[0] as Tampering;
  const t = TAMPERINGS[first];
  return 'check' in t ? { ok: false, reason: 'invalid_diagnosis', check: t.check as DiagnosisCheck } : { ok: false, reason: 'no_diagnosis' };
};

const incident = { service: 'payments' as const, openedAt: new Date(OPENED) };

// Feature: exorcist-agent, Property 8
describe('Property 8: diagnosis validation accepts exactly the grounded diagnoses', () => {
  it('is valid iff no check fails, and otherwise names the first failing check', async () => {
    await fc.assert(
      fc.asyncProperty(fc.subarray(ALL).filter(unambiguous), fc.integer({ min: 0, max: 6 }), async (set, extra) => {
        const s = build(set, extra, 'The guard was removed.');
        const verdict = await validateDiagnosis(incident, s.ledger, s.streamInput, s.lab);
        const want = expected(set);
        if (want === 'valid') {
          expect(verdict.ok).toBe(true);
          if (verdict.ok) {
            expect(verdict.diagnosis.culpritSha).toBe(SHA);
            expect(verdict.diagnosis.culpritDeploy).toBe('d-7');
            expect(verdict.diagnosis.cited).toEqual(s.input.evidence.map((e) => e.ref));
          }
        } else {
          expect(verdict).toEqual(want);
        }
      }),
      RUNS,
    );
  });

  it('never accepts a SHA the lab did not serve or a handle the Hunt did not see', async () => {
    await fc.assert(
      fc.asyncProperty(fc.stringMatching(/^[0-9a-f]{7,40}$/), fc.stringMatching(/^[a-z]{3,10}:[a-z0-9]{1,12}$/), async (sha, ref) => {
        fc.pre(!SHA.startsWith(sha) && !['metric', 'deploy', 'commit'].some((k) => ref.startsWith(`${k}:`)));
        const base = build([], 0, 'ok');
        const wrongSha = { ...base.input, culprit_sha: sha };
        const unseen = { ...base.input, evidence: [{ kind: 'error' as const, ref, detail: 'x' }, ...base.input.evidence.slice(1)] };
        for (const input of [wrongSha, unseen]) {
          const ledger = base.ledger.map((l) => (l.type === 'diagnosis' ? { ...l, input } : l));
          const verdict = await validateDiagnosis(incident, ledger, input, base.lab);
          expect(verdict.ok).toBe(false);
        }
      }),
      RUNS,
    );
  });

  it('keeps the full SHA, strips control characters and caps the text', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1, maxLength: 600, unit: 'binary' }), async (summary) => {
        const s = build([], 1, summary);
        const verdict = await validateDiagnosis(incident, s.ledger, s.streamInput, s.lab);
        expect(verdict.ok).toBe(true);
        if (!verdict.ok) return;
        expect(verdict.diagnosis.culpritSha).toHaveLength(40);
        expect(verdict.diagnosis.summary.length).toBeGreaterThan(0);
        expect(verdict.diagnosis.summary.length).toBeLessThanOrEqual(600);
        // eslint-disable-next-line no-control-regex
        expect(verdict.diagnosis.summary).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
      }),
      RUNS,
    );
  });
});

describe('diagnosis validator: boundaries', () => {
  it('accepts a deploy recorded exactly 60 s after the Incident opened and refuses 61 s', async () => {
    for (const [ms, ok] of [[60_000, true], [61_000, false]] as const) {
      const s = build([], 0, 'ok');
      s.lab.deployList = s.lab.deployList.map((d) => ({ ...d, time: new Date(OPENED + ms).toISOString() }));
      const v = await validateDiagnosis(incident, s.ledger, s.streamInput, s.lab);
      expect(v.ok).toBe(ok);
    }
  });

  it('refuses an input that is not a valid diagnosis even when both channels agree', async () => {
    const s = build([], 0, 'ok');
    const bad = { ...s.input, extra: true };
    const ledger = s.ledger.map((l) => (l.type === 'diagnosis' ? { ...l, input: bad as never } : l));
    expect(await validateDiagnosis(incident, ledger, bad, s.lab)).toEqual({ ok: false, reason: 'invalid_diagnosis', check: 'stream_mismatch' });
  });

  it('answers no_diagnosis when the stream shows none and the ledger has none', async () => {
    const s = build(['no_diagnosis'], 0, 'ok');
    expect(await validateDiagnosis(incident, s.ledger, undefined, s.lab)).toEqual({ ok: false, reason: 'no_diagnosis' });
  });
});

// Feature: exorcist-agent, Property 18
describe('Property 18: a culprit is valid iff its service is the hunted one or downstream of it', () => {
  const pairs = SERVICE_NAMES.flatMap((hunted) => SERVICE_NAMES.map((culprit) => [hunted, culprit] as const));

  it('accepts exactly those pairs, names the culprit service, and refuses the others as deploy_service', async () => {
    for (const [hunted, culprit] of pairs) {
      const s = build([], 0, 'ok', { incident: hunted, deployService: culprit });
      const verdict = await validateDiagnosis({ service: hunted, openedAt: new Date(OPENED) }, s.ledger, s.streamInput, s.lab);
      if (isCulpritCandidate(hunted, culprit)) {
        expect(verdict.ok, `${hunted} / ${culprit}`).toBe(true);
        if (verdict.ok) expect(verdict.diagnosis.culpritService).toBe(culprit);
      } else {
        expect(verdict, `${hunted} / ${culprit}`).toEqual({ ok: false, reason: 'invalid_diagnosis', check: 'deploy_service' });
      }
    }
  });

  it('holds with the other checks on: the first failing check still wins over a good culprit service', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...pairs), fc.subarray(ALL).filter(unambiguous), async ([hunted, culprit], set) => {
        const s = build(set.filter((t) => t !== 'service' && t !== 'deploy_service'), 0, 'ok', { incident: hunted, deployService: culprit });
        const rest = set.filter((t) => t !== 'service' && t !== 'deploy_service');
        const verdict = await validateDiagnosis({ service: hunted, openedAt: new Date(OPENED) }, s.ledger, s.streamInput, s.lab);
        const earlier = rest.filter((t) => TAMPERINGS[t].rank < 4);
        // The culprit-service check sits between `deploy_unknown` (3) and `deploy_after_incident` (5).
        const want: DiagnosisVerdict | 'valid' =
          earlier.length === 0 && !isCulpritCandidate(hunted, culprit) ? { ok: false, reason: 'invalid_diagnosis', check: 'deploy_service' } : expected(rest);
        if (want === 'valid') expect(verdict.ok).toBe(true);
        else expect(verdict).toEqual(want);
      }),
      RUNS,
    );
  });
});
