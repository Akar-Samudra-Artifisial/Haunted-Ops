import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { REPLAY_FORBIDDEN, SERVICE_NAMES, replayForbiddenKind, replayReviewHash, validateReplayFile, type HuntDetail, type ProposalView, type ReplayFile, type ServiceState } from '../src/index.js';
import { fullShaArb, hauntLevelArb, serviceNameArb } from './arbitraries.js';
import { huntDetail, iso, proposalView, services } from './replay-fixture.js';
const word = fc.stringMatching(/^[a-z]{1,9}$/);
const wordsArb = (min: number, max: number) =>
  fc
    .array(word, { minLength: min, maxLength: max })
    .map((w) => w.join(' '))
    .filter((t) => t.length >= 1 && t.length <= 80);
const cuid25 = fc.stringMatching(/^[a-z][a-z0-9]{24}$/);
/** A valid hunt detail whose texts are plain words. */
const huntArb: fc.Arbitrary<HuntDetail> = fc
  .record({ id: cuid25, incident: cuid25, text: wordsArb(1, 8), sha: fullShaArb, steps: fc.integer({ min: 0, max: 5 }), credits: fc.double({ min: 0, max: 3, noNaN: true }), service: serviceNameArb, evidence: fc.array(wordsArb(1, 6), { maxLength: 4 }) })
  .map((r): HuntDetail => ({
    ...huntDetail,
    id: r.id,
    incidentId: r.incident,
    service: r.service,
    steps: huntDetail.steps.slice(0, r.steps),
    allSteps: huntDetail.allSteps.slice(0, r.steps).map((s) => ({ ...s, summary: r.text })),
    stepCount: r.steps,
    evidenceCount: r.evidence.length,
    diagnosis: { culpritDeploy: 'd-7', culpritSha: r.sha, culpritService: r.service, summary: r.text },
    credits: r.credits,
    evidence: r.evidence.map((detail, i) => ({ index: i + 1, kind: 'log', ref: `log:${i}`, detail, cited: i === 0 })),
    fixHint: r.text,
    proposal: null,
  }));
const proposalArb: fc.Arbitrary<ProposalView> = fc
  .record({ id: cuid25, huntId: cuid25, pr: fc.integer({ min: 1, max: 99_999 }), merged: fc.boolean() })
  .map((r): ProposalView => ({
    ...proposalView,
    id: r.id,
    huntId: r.huntId,
    prNumber: r.pr,
    prUrl: `https://github.com/Akar-Samudra-Artifisial/Haunted-Lab/pull/${r.pr}`,
    status: r.merged ? 'merged' : 'open',
    mergedBy: r.merged ? 'reviewer' : null,
    mergedAt: r.merged ? iso(9000) : null,
  }));
const servicesArb: fc.Arbitrary<ServiceState[]> = fc.array(fc.record({ level: hauntLevelArb, up: fc.double({ min: 0, max: 1, noNaN: true }) }), { minLength: 4, maxLength: 4 }).map((rows) =>
  services(0).map((s, i) => ({ ...s, name: SERVICE_NAMES[i] as ServiceState['name'], hauntLevel: (rows[i] as { level: ServiceState['hauntLevel'] }).level, reason: null, metrics: { errorRate: 0, p95Ms: 100, up: (rows[i] as { up: number }).up, at: iso(0) } })),
);
/** Any valid file: random frame count, times, services, hunts and pull requests. */
const replayArb: fc.Arbitrary<ReplayFile> = fc
  .record({
    id: fc.stringMatching(/^[a-z0-9][a-z0-9-]{2,30}$/),
    title: wordsArb(1, 8),
    scenario: fc.constantFrom('error-spike', 'fog', 'dark-room' as const),
    gaps: fc.array(fc.integer({ min: 0, max: 5000 }), { minLength: 0, maxLength: 40 }),
    pad: fc.integer({ min: 0, max: 5000 }),
    first: servicesArb,
    rest: fc.array(fc.record({ services: fc.option(servicesArb, { nil: undefined }), hunt: fc.option(fc.option(huntArb, { nil: null }), { nil: undefined }), proposal: fc.option(fc.option(proposalArb, { nil: null }), { nil: undefined }) }), { minLength: 40, maxLength: 40 }),
    review: fc.option(fc.record({ by: fc.stringMatching(/^[A-Za-z]{2,4}$/), note: wordsArb(0, 10).filter((n) => n.length <= 200) }), { nil: null }),
  })
  .map((r): ReplayFile => {
    let t = 0;
    const frames: ReplayFile['frames'] = [{ t: 0, services: r.first }];
    r.gaps.forEach((gap, i) => {
      t += gap;
      const extra = r.rest[i] as (typeof r.rest)[number];
      frames.push({ t, ...(extra.services === undefined ? {} : { services: extra.services }), ...(extra.hunt === undefined ? {} : { hunt: extra.hunt }), ...(extra.proposal === undefined ? {} : { proposal: extra.proposal }) });
    });
    const file: ReplayFile = { version: 1, id: r.id, title: r.title, scenario: r.scenario as ReplayFile['scenario'], recordedOn: '2026-11-15', durationMs: Math.max(1, t + r.pad), review: null, frames };
    // A review is bound to the content: the hash is of the file as it is.
    return r.review === null ? file : { ...file, review: { reviewedOn: '2026-11-16', ...r.review, sha256: replayReviewHash(file) } };
  });
/** One text of each forbidden kind, with random words around it. */
const forbiddenArb: fc.Arbitrary<{ kind: string; text: string }> = fc
  .record({ w: word, w2: word, n: fc.integer({ min: 1, max: 99 }), uuid: fc.uuid(), alnum: fc.stringMatching(/^[A-Za-z0-9]{20}$/) })
  .chain((r) =>
    fc.constantFrom(
      { kind: 'bearer value', text: `${r.w} Bearer ${r.alnum}` },
      { kind: 'email address', text: `${r.w}@${r.w2}.com` },
      { kind: 'home path', text: `in /Users/${r.w}/${r.w2}` },
      { kind: 'home path', text: `in /home/${r.w}` },
      { kind: 'temp path', text: `at /tmp/${r.w}` },
      { kind: 'temp path', text: `at /private/var/folders/${r.w}` },
      { kind: 'windows path', text: `C:\\Users\\${r.w}` },
      { kind: 'github token', text: `${r.w} ghp_${r.alnum}` },
      { kind: 'aws key id', text: `AKIA${r.alnum.toUpperCase()}` },
      { kind: 'api key', text: `sk-${r.alnum}` },
      { kind: 'private key', text: '-----BEGIN PRIVATE KEY-----' },
      { kind: 'uuid', text: `${r.w} ${r.uuid}` },
      { kind: 'account id', text: `${r.w} ${String(r.n).padStart(12, '1')}` },
      { kind: 'ip address', text: `${r.w} 10.${r.n}.2.3` },
      { kind: 'hostname', text: `${r.w} ${r.w2}.internal` },
      { kind: 'hostname', text: `${r.w}.${r.w2}.com` },
      { kind: 'hostname', text: `see staging-${r.n}.${r.w}.example.org.` },
      { kind: 'ip address', text: `${r.w} ${r.n + 100}.${r.n}.0.${r.n}.` },
      { kind: 'ipv6 address', text: `${r.w} ::1` },
      { kind: 'ipv6 address', text: `${r.w} fe80::${r.n}:1` },
      { kind: 'ipv6 address', text: `${r.w}:fe80::${r.n}:1` },
      { kind: 'ipv6 address', text: `device:fe80::${r.n}:1` },
      { kind: 'ipv6 address', text: `${r.w} 2001:db8:0:0:0:0:0:${r.n}` },
      { kind: 'bidi or zero-width character', text: `${r.w}\u200B${r.w2}` },
      { kind: 'bidi or zero-width character', text: `${r.w}\u202E${r.w2}` },
      { kind: 'bidi or zero-width character', text: `${r.w}\u2067${r.w2}` },
      { kind: 'bidi or zero-width character', text: `${r.w}\uFEFF${r.w2}` },
      { kind: 'html tag', text: `${r.w} <${r.w2}>` },
      { kind: 'html tag', text: `${r.w} </${r.w2}` },
      { kind: 'url', text: `${r.w} https://${r.w2}/x` },
      { kind: 'url', text: `${r.w} http://${r.w2}` },
      { kind: 'root path', text: `at /root/${r.w}` },
      { kind: 'control character', text: `${r.w}\u001b[0m${r.w2}` },
      { kind: 'control character', text: `${r.w}\u0000${r.w2}` },
      { kind: 'token shape', text: `${r.alnum}${r.alnum}` },
    ),
  );
/** Text of the shapes the validator must let through (service and tool names, lab files, versions, times, prose, 127.0.0.1). */
const allowedArb: fc.Arbitrary<string> = fc
  .record({ w: word, n: fc.integer({ min: 1, max: 99 }) })
  .chain((r) =>
    fc.constantFrom(
      `${r.w} payments query_metrics ${r.w}`,
      `edited services/payments/src/${r.w}.py and config.yaml`,
      `${r.w}.test.ts ${r.w}.json README.md`,
      `v${r.n}.2.3.4 and ${r.n}.2.3`,
      `ratio 0.${r.n} and p95 ${r.n}.5ms`,
      `at ${r.n}:30:45 on 127.0.0.1`,
      `${r.w}.Next sentence, e.g. ${r.w}`,
      `a < ${r.n} and ${r.n} > b`,
    ),
  );
/** Free-text leaves of a file: where a person or a model could have put a string. */
function textLeaves(file: ReplayFile): Array<{ path: string; set: (v: string) => void }> {
  const out: Array<{ path: string; set: (v: string) => void }> = [
    { path: '$.title', set: (v) => (file.title = v) },
  ];
  if (file.review !== null) {
    const review = file.review;
    out.push({ path: '$.review.note', set: (v) => (review.note = v) });
  }
  file.frames.forEach((frame, i) => {
    if (frame.hunt !== undefined && frame.hunt !== null) {
      const hunt = frame.hunt;
      out.push({ path: `$.frames[${i}].hunt.fixHint`, set: (v) => (hunt.fixHint = v) });
      if (hunt.diagnosis !== null) out.push({ path: `$.frames[${i}].hunt.diagnosis.summary`, set: (v) => ((hunt.diagnosis as { summary: string }).summary = v) });
      hunt.evidence.forEach((e, k) => out.push({ path: `$.frames[${i}].hunt.evidence[${k}].detail`, set: (v) => (e.detail = v) }));
      hunt.allSteps.forEach((s, k) => out.push({ path: `$.frames[${i}].hunt.allSteps[${k}].summary`, set: (v) => (s.summary = v) }));
    }
    frame.services?.forEach((s, k) => {
      if (s.openIncident !== null) {
        const inc = s.openIncident;
        out.push({ path: `$.frames[${i}].services[${k}].openIncident.id`, set: (v) => (inc.id = v) });
      }
    });
  });
  return out;
}
describe('replay file properties', () => {
  // Feature: replay, Property 1
  it('Property 1: every file the generator builds passes the validator and survives JSON', () => {
    fc.assert(
      fc.property(replayArb, (file) => {
        const r = validateReplayFile(file);
        if (!r.ok) throw new Error(r.errors.join(' '));
        expect(validateReplayFile(JSON.parse(JSON.stringify(file))).ok).toBe(true);
      }),
      { numRuns: 150 },
    );
  }, 30_000);
  // Feature: replay, Property 2
  it('Property 2: one forbidden string put anywhere in a text makes the file fail at that path, and the errors never hold the text', () => {
    fc.assert(
      fc.property(replayArb, forbiddenArb, fc.nat(), (file, bad, pick) => {
        const leaves = textLeaves(file);
        const leaf = leaves[pick % leaves.length] as (typeof leaves)[number];
        expect(replayForbiddenKind(bad.text)).not.toBeNull();
        const clean = validateReplayFile(file);
        expect(clean.ok).toBe(true);
        leaf.set(bad.text.replace(/\n/g, ' '));
        const r = validateReplayFile(file);
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.errors.some((p) => p === leaf.path || p.startsWith(`${leaf.path}`))).toBe(true);
          expect(r.errors.join('\n')).not.toContain(bad.text);
        }
      }),
      { numRuns: 300 },
    );
  }, 30_000);
  // Feature: replay, Property 2 (the other side)
  it('Property 2b: text of an allowed shape put anywhere in a text leaves a (re-reviewed) file valid', () => {
    fc.assert(
      fc.property(replayArb, allowedArb, fc.nat(), (file, text, pick) => {
        const leaves = textLeaves(file);
        const leaf = leaves[pick % leaves.length] as (typeof leaves)[number];
        leaf.set(text);
        const rehashed: ReplayFile = file.review === null ? file : { ...file, review: { ...file.review, sha256: replayReviewHash(file) } };
        const r = validateReplayFile(rehashed);
        if (!r.ok) throw new Error(`${r.errors.join(' ')} for ${JSON.stringify(text)}`);
      }),
      { numRuns: 300 },
    );
  }, 30_000);
  it('the generator covers every forbidden kind of the validator', () => {
    const kinds = new Set<string>();
    fc.assert(
      fc.property(forbiddenArb, ({ kind, text }) => {
        kinds.add(kind);
        expect(replayForbiddenKind(text)).not.toBeNull();
      }),
      { numRuns: 600 },
    );
    for (const f of REPLAY_FORBIDDEN) expect(kinds.has(f.name)).toBe(true);
  }, 30_000);
  it('an unsorted t, a frame after durationMs or an extra key always fails', () => {
    fc.assert(
      fc.property(replayArb, fc.integer({ min: 1, max: 5000 }), (file, over) => {
        const late = { ...file, frames: [...file.frames, { t: file.durationMs + over }] };
        expect(validateReplayFile(late).ok).toBe(false);
        expect(validateReplayFile({ ...file, extra: 1 }).ok).toBe(false);
        if (file.frames.length > 1) {
          const last = file.frames[file.frames.length - 1] as ReplayFile['frames'][number];
          if (last.t > 0) expect(validateReplayFile({ ...file, frames: [...file.frames, { t: last.t - 1 }] }).ok).toBe(false);
        }
      }),
      { numRuns: 100 },
    );
  }, 30_000);
});
