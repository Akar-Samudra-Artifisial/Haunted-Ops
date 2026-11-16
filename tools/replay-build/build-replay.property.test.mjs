import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import fc from 'fast-check';
import { MAX_FRAMES, buildReplay, loadDeps } from './build-replay.mjs';
import { BASE, PLANTED, SHA } from './test-support.mjs';
let deps;
before(async () => {
  deps = await loadDeps({ check: false });
});
const SERVICES = ['gate', 'orders', 'payments', 'ledger'];
const word = fc.stringMatching(/^[a-z]{1,9}$/);
/** Text with words and, often, one text of a kind that must not survive. */
const dirtyText = fc.tuple(fc.array(word, { minLength: 1, maxLength: 6 }), fc.option(fc.constantFrom(...Object.values(PLANTED), '<b>x</b>', '[a](http://x.test/y)', '@someone #12 `c`'), { nil: null, freq: 2 })).map(([w, d]) => (d === null ? w.join(' ') : `${w.join(' ')} ${d}`));
const rowsArb = fc
  .record({
    open: fc.integer({ min: 30, max: 120 }),
    lead: fc.integer({ min: 0, max: 30 }),
    length: fc.integer({ min: 60, max: 600 }),
    service: fc.constantFrom(...SERVICES),
    closes: fc.option(fc.integer({ min: 1, max: 200 }), { nil: null }),
    signals: fc.array(
      fc.record({ service: fc.constantFrom(...SERVICES), kind: fc.constantFrom('error_rate', 'p95_ms', 'up'), value: fc.double({ min: 0, max: 5000, noNaN: true }), second: fc.double({ min: 0, max: 1, noNaN: true }) }),
      { maxLength: 250 },
    ),
    hunt: fc.option(
      fc.record({
        state: fc.constantFrom('queued', 'running', 'succeeded', 'failed'),
        created: fc.integer({ min: 0, max: 50 }),
        wait: fc.integer({ min: 0, max: 10 }),
        steps: fc.array(fc.record({ tool: fc.constantFrom('query_metrics', 'search_errors', 'tail_logs', 'recent_deploys', 'diff_commit'), text: dirtyText, gap: fc.integer({ min: 0, max: 15 }) }), { maxLength: 10 }),
        evidence: fc.array(fc.record({ kind: fc.constantFrom('metric', 'error', 'log', 'deploy', 'commit'), ref: dirtyText, detail: dirtyText, cited: fc.boolean() }), { maxLength: 6 }),
        summary: dirtyText,
        fixHint: fc.option(dirtyText, { nil: null }),
        stopDetail: fc.option(dirtyText, { nil: null }),
        credits: fc.double({ min: 0, max: 3, noNaN: true }),
        tail: fc.integer({ min: 1, max: 30 }),
        proposal: fc.option(
          fc.record({
            state: fc.constantFrom('drafting', 'open', 'merged', 'deployed', 'rejected', 'checks_failed', 'failed'),
            pr: fc.integer({ min: 1, max: 9999 }),
            gaps: fc.array(fc.integer({ min: 1, max: 20 }), { minLength: 4, maxLength: 4 }),
            login: fc.option(word, { nil: null }),
          }),
          { nil: null },
        ),
      }),
      { nil: null },
    ),
  })
  .map((r) => {
    const startMs = BASE;
    const at = (s) => new Date(startMs + Math.round(s * 1000));
    const openedAt = at(r.open);
    let hunt = null;
    let proposal = null;
    let end = Math.max(r.length, r.open + 60);
    if (r.hunt !== null) {
      const h = r.hunt;
      const created = r.open + h.created;
      const started = created + h.wait;
      let t = started;
      const steps = h.steps.map((s, i) => ({ index: i + 1, tool: s.tool, summary: s.text, at: at((t += s.gap)) }));
      const finished = t + h.tail;
      const ended = h.state === 'succeeded' || h.state === 'failed';
      const ok = h.state === 'succeeded';
      hunt = {
        id: 'real-hunt',
        incidentId: 'real-incident',
        service: r.service,
        status: h.state,
        trigger: 'auto',
        endReason: ok ? 'diagnosed' : h.state === 'failed' ? 'timeout' : null,
        invalidCheck: null,
        model: 'claude-sonnet-5.5',
        credits: h.credits,
        creditsEstimated: false,
        toolCalls: steps.length,
        culpritDeploy: ok ? 'd-7' : null,
        culpritSha: ok ? SHA : null,
        culpritService: ok ? r.service : null,
        summary: ok ? h.summary : null,
        fixHint: ok ? h.fixHint : null,
        stopDetail: h.stopDetail,
        diagnosedBy: null,
        linkedHuntId: null,
        startedAt: h.state === 'queued' ? null : at(started),
        finishedAt: ended ? at(finished) : null,
        durationMs: ended ? (finished - started) * 1000 : null,
        createdAt: at(created),
        steps: h.state === 'queued' ? [] : steps,
        evidence: ended ? h.evidence.map((e, i) => ({ order: i + 1, kind: e.kind, ref: e.ref, detail: e.detail, cited: e.cited })) : [],
      };
      end = Math.max(end, finished + 20);
      if (ok && h.proposal !== null) {
        const p = h.proposal;
        const c = finished + p.gaps[0];
        const o = c + p.gaps[1];
        const m = o + p.gaps[2];
        const d = m + p.gaps[3];
        const failed = p.state === 'checks_failed' || p.state === 'failed';
        const hasPr = ['open', 'merged', 'deployed', 'rejected'].includes(p.state) || (p.state === 'failed' && p.gaps[0] % 2 === 0);
        const merged = p.state === 'merged' || p.state === 'deployed';
        proposal = {
          id: 'real-proposal',
          huntId: 'real-hunt',
          attempt: 1,
          kind: p.state === 'drafting' || p.state === 'checks_failed' ? null : 'ai_patch',
          status: p.state,
          failReason: failed ? 'checks_failed' : null,
          aiFailReason: null,
          prNumber: hasPr ? p.pr : null,
          prUrl: hasPr ? `https://github.com/someone/other/pull/${p.pr}` : null,
          mergedBy: merged ? p.login : null,
          checks: [{ name: 'non_empty', ok: true }],
          credits: 0.1,
          creditsEstimated: false,
          createdAt: at(c),
          openedAt: hasPr ? at(o) : null,
          mergedAt: merged ? at(m) : null,
          deployedAt: p.state === 'deployed' ? at(d) : null,
          finishedAt: p.state === 'deployed' ? at(d) : failed || p.state === 'rejected' ? at(d) : null,
          aiFailDetail: 'internal text',
          updatedAt: new Date(),
        };
        end = Math.max(end, d + 20);
      }
    }
    const startOffset = Math.max(0, r.open - r.lead - 1);
    const windowStart = startMs + startOffset * 1000;
    const windowEnd = Math.min(startMs + end * 1000, windowStart + 900_000);
    return {
      incident: { id: 'real-incident', service: r.service, openedAt, closedAt: r.closes === null ? null : at(r.open + r.closes), peakLevel: 2 },
      services: SERVICES.map((name, i) => ({ name, roomX: i % 2, roomY: Math.floor(i / 2) })),
      signals: r.signals.map((s) => ({ service: s.service, kind: s.kind, value: s.kind === 'up' ? Math.min(1, s.value) : s.kind === 'error_rate' ? Math.min(1, s.value / 5000) : s.value, at: new Date(windowStart + Math.round(s.second * (windowEnd - windowStart))) })),
      hunt,
      proposal,
      window: { startMs: windowStart, endMs: windowEnd },
    };
  });
// Feature: replay, Property 3
test('Property 3: any rows of a valid incident give a valid file, within the limits, with nothing that must not survive', () => {
  fc.assert(
    fc.property(rowsArb, fc.stringMatching(/^[a-z0-9][a-z0-9-]{2,30}$/), fc.constantFrom('error-spike', 'fog', 'dark-room'), (rows, id, scenario) => {
      const file = buildReplay(rows, { id, title: 'Synthetic property run', scenario }, deps);
      assert.equal(deps.validateReplayFile(file).ok, true);
      assert.equal(file.review, null);
      assert.equal(file.frames[0].t, 0);
      assert.ok(file.frames.length <= MAX_FRAMES);
      const text = JSON.stringify(file);
      assert.ok(Buffer.byteLength(text) <= 256 * 1024);
      for (const [name, value] of Object.entries(PLANTED)) assert.ok(!text.includes(value), `${name} survived`);
      for (const real of ['real-hunt', 'real-incident', 'real-proposal', 'internal text', 'someone/other']) assert.ok(!text.includes(real), `${real} survived`);
      assert.deepEqual(file.frames.map((f) => f.t), [...file.frames.map((f) => f.t)].sort((a, b) => a - b));
      assert.ok(file.frames.at(-1).t <= file.durationMs);
      // Same rows, same replay id: the same bytes.
      assert.equal(JSON.stringify(buildReplay(rows, { id, title: 'Synthetic property run', scenario }, deps)), text);
    }),
    { numRuns: 120 },
  );
});
