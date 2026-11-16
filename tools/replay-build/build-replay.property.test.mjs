import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import fc from 'fast-check';
import { MAX_FRAMES, buildReplay, loadDeps, replayBase, rewriteClocks } from './build-replay.mjs';
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
// Feature: replay, Property 9
test('Property 9: an epoch number or an ISO time with an offset inside any window is rewritten to the base plus its offset, and the source value is gone', () => {
  const pad = (n) => String(n).padStart(2, '0');
  fc.assert(
    fc.property(
      fc.integer({ min: Date.UTC(2026, 0, 1), max: Date.UTC(2027, 11, 31) }),
      fc.integer({ min: 1, max: 900 }),
      fc.double({ min: 0, max: 1, noNaN: true }),
      fc.constantFrom('epochS', 'epochMs', 'isoOffset'),
      fc.integer({ min: -47, max: 56 }),
      (startMs, lengthS, where, form, quarters) => {
        const win = { startMs, endMs: startMs + lengthS * 1000 };
        const { recordedOn, baseMs } = replayBase(startMs);
        const shift = baseMs - startMs;
        // Whole seconds, so that every format holds the instant exactly.
        const instant = Math.floor((startMs + Math.floor(where * lengthS * 1000)) / 1000) * 1000;
        const sign = quarters < 0 ? '-' : '+';
        const minutes = Math.abs(quarters) * 15;
        const offset = `${sign}${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
        const local = new Date(instant + (quarters < 0 ? -1 : 1) * minutes * 60_000).toISOString().slice(0, 19);
        const source = { epochS: String(instant / 1000), epochMs: String(instant), isoOffset: `${local}${offset}` }[form];
        const want = { epochS: String(Math.floor((instant + shift) / 1000)), epochMs: String(instant + shift), isoOffset: `${new Date(instant + shift).toISOString().slice(0, 19)}Z` }[form];
        const r = rewriteClocks(`see ${source} now`, win);
        assert.equal(r.outOfRange, false);
        assert.equal(r.text, `see ${want} now`, `${form} ${source}`);
        // The rewritten instant is on the recording date, and the source value is gone unless the shift is zero.
        const back = form === 'epochS' ? Number(want) * 1000 : form === 'epochMs' ? Number(want) : Date.parse(want);
        assert.equal(new Date(back).toISOString().slice(0, 10), recordedOn);
        if (want !== source) assert.ok(!r.text.includes(source), `${source} survived`);
      },
    ),
    { numRuns: 300 },
  );
});
// Feature: replay, Property 8
test('Property 8: a clock at any offset inside any window, rewritten and read back, has the same offset from the base', () => {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  fc.assert(
    fc.property(
      fc.integer({ min: Date.UTC(2026, 0, 1), max: Date.UTC(2027, 11, 31) }),
      fc.integer({ min: 1, max: 900 }),
      fc.double({ min: 0, max: 1, noNaN: true }),
      fc.constantFrom('iso', 'isoMs', 'z', 'hms', 'hm'),
      (startMs, lengthS, where, form) => {
        const win = { startMs, endMs: startMs + lengthS * 1000 };
        // Each format has its precision: the clock is the instant at the offset, cut to that precision.
        const unit = { iso: 1000, isoMs: 1, z: 1000, hms: 1000, hm: 60_000 }[form];
        const clockMs = Math.floor((startMs + Math.floor(where * lengthS * 1000)) / unit) * unit;
        const c = new Date(clockMs);
        const hms = `${pad(c.getUTCHours())}:${pad(c.getUTCMinutes())}:${pad(c.getUTCSeconds())}`;
        const text = { iso: `${c.toISOString().slice(0, 19)}Z`, isoMs: c.toISOString(), z: `${hms}Z`, hms, hm: hms.slice(0, 5) }[form];
        const r = rewriteClocks(`at ${text} done`, win);
        assert.equal(r.outOfRange, false);
        const out = r.text.slice(3, -5);
        const { recordedOn, baseMs } = replayBase(startMs);
        const back = form === 'iso' || form === 'isoMs' ? Date.parse(out) : Date.parse(`${recordedOn}T${form === 'hm' ? `${out}:00` : out.replace('Z', '')}${form === 'isoMs' ? '' : '.000'}Z`);
        // Read back on the recording date, it is the base plus the same offset (cut to the precision of the format).
        assert.equal(back, Math.floor((baseMs + (clockMs - startMs)) / unit) * unit, `${form} ${text} -> ${out}`);
        if (form === 'iso' || form === 'isoMs') assert.equal(out.slice(0, 10), recordedOn);
      },
    ),
    { numRuns: 300 },
  );
});
