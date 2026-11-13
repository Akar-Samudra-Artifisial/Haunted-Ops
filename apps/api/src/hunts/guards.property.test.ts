import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { HUNT_TOOLS } from '@haunted-ops/shared';
import { CreditMeter, ToolCounter, checkToolCall, describeForeign, firstForeignCall, fitsDailyBudget, isSameCall, loadedTools, wrappedCall, type AcceptedCall } from './guards.js';
import type { HuntStreamEvent } from './stream-parser.js';

const RUNS = { numRuns: 300 };
type Call = Extract<HuntStreamEvent, { type: 'tool_call' }>;
const call = (title: string, rawInput: unknown = {}): Call => ({ type: 'tool_call', id: 'c', title, rawInput });

const GOOD_TITLES = HUNT_TOOLS.map((t) => `@exorcist/${t}`);
const loadOf = (name: string, shape: 'id' | 'tool_ids' | 'bare'): unknown =>
  shape === 'id' ? { id: `tool::exorcist::${name}` } : shape === 'tool_ids' ? { tool_ids: [`tool::exorcist::${name}`] } : { tool_ids: [name] };

const goodCall: fc.Arbitrary<Call> = fc.oneof(
  fc.constantFrom(...GOOD_TITLES).map((t) => call(t, { service: 'payments' })),
  fc.tuple(fc.constantFrom(...HUNT_TOOLS), fc.constantFrom('id' as const, 'tool_ids' as const, 'bare' as const)).map(([n, shape]) => call('Tool Load', loadOf(n, shape))),
);
const foreignCall: fc.Arbitrary<Call> = fc.oneof(
  fc.constantFrom('fs_read', 'fs_write', 'execute_bash', 'shell', 'Tool Load ', 'tool load', '@exorcist/', '@exorcist/shell', '@exorcist/query_metrics/x', '@other/query_metrics', ' @exorcist/query_metrics', '').map((t) => call(t)),
  fc.string({ maxLength: 30 }).filter((t) => !GOOD_TITLES.includes(t) && t !== 'Tool Load').map((t) => call(t)),
  // A Tool Load that loads something else, loads nothing readable, or sneaks one extra tool in.
  fc.constantFrom({ id: 'tool::other::fs_read' }, { id: 'fs_read' }, { id: 'tool::exorcist::fs_read' }, { tool_ids: ['tool::exorcist::query_metrics', 'fs_write'] }, { tool_ids: [] }, { tool_ids: 'query_metrics' }, {}, null, 'tool::exorcist::query_metrics', { id: 7 }, { id: ['tool::exorcist::query_metrics'] }).map((i) => call('Tool Load', i)),
);
const otherEvent: fc.Arbitrary<HuntStreamEvent> = fc.constantFrom<HuntStreamEvent>(
  { type: 'ignored' },
  { type: 'tool_call_update', id: 'c', status: 'completed' },
  { type: 'credits', usage: 0.2 },
  { type: 'malformed' },
  { type: 'run_finished', status: 'success' },
);

// Feature: exorcist-agent, Property 1
describe('Property 1: the allow-list rejects every foreign tool call', () => {
  it('flags exactly the first tool call that is not one of the six tools or a Tool Load of only those', () => {
    fc.assert(
      fc.property(fc.array(fc.oneof(goodCall, foreignCall, otherEvent), { maxLength: 30 }), (events) => {
        const expected = events.findIndex((e) => e.type === 'tool_call' && !GOOD_TITLES.includes(e.title) && !(e.title === 'Tool Load' && isReadableSix(e.rawInput)));
        expect(firstForeignCall(events)).toBe(expected);
        for (const e of events) {
          if (e.type !== 'tool_call') continue;
          const v = checkToolCall(e);
          expect(v.kind === 'foreign').toBe(!GOOD_TITLES.includes(e.title) && !(e.title === 'Tool Load' && isReadableSix(e.rawInput)));
        }
      }),
      RUNS,
    );
  });

  it('names the tool of a step and keeps the arguments untouched', () => {
    const input = { service: 'payments', signal: 'up', window: '5m' };
    expect(checkToolCall(call('@exorcist/query_metrics', input))).toEqual({ kind: 'step', tool: 'query_metrics', id: 'c', input });
    expect(checkToolCall(call('Tool Load', { id: 'tool::exorcist::tail_logs' }))).toEqual({ kind: 'load', id: 'c' });
    expect(checkToolCall(call('fs_read', { path: '/etc/hosts' }))).toEqual({ kind: 'foreign', title: 'fs_read' });
  });

  it('reads the tool names of both shapes of Tool Load', () => {
    expect(loadedTools({ id: 'tool::exorcist::diff_commit' })).toEqual(['diff_commit']);
    expect(loadedTools({ tool_ids: ['query_metrics', 'tool::exorcist::tail_logs'] })).toEqual(['query_metrics', 'tail_logs']);
    expect(loadedTools({ id: 'tool::exorcist::a', tool_ids: ['b'] })).toEqual(['a', 'b']);
    for (const bad of [null, undefined, 'x', [], {}, { tool_ids: 'x' }, { id: 3 }, { tool_ids: [1] }, { id: 'a b' }]) expect(loadedTools(bad)).toBeNull();
  });
});

/** Reference model: every id of a Tool Load must be readable and name one of the six tools. */
function isReadableSix(rawInput: unknown): boolean {
  const names = loadedTools(rawInput);
  return names !== null && names.every((n) => (HUNT_TOOLS as readonly string[]).includes(n));
}

// Feature: exorcist-agent, Property 2
describe('Property 2: caps stop the hunt within one report', () => {
  const capsArb = fc.tuple(fc.double({ min: 0.1, max: 10, noNaN: true }), fc.double({ min: 0, max: 100, noNaN: true })).map(([hunt, extra]) => ({ hunt, daily: hunt + extra }));

  it('stops at the first report where the hunt total reaches the per-hunt cap or the day total reaches the daily cap, never earlier', () => {
    fc.assert(
      // A hunt only starts when the day's spent Credits plus the per-hunt cap fit the daily cap.
      fc.property(capsArb, fc.double({ min: 0, max: 1, noNaN: true }), fc.array(fc.double({ min: 0, max: 2, noNaN: true }), { minLength: 1, maxLength: 40 }), (caps, share, reports) => {
        const spent = share * (caps.daily - caps.hunt) * (1 - 1e-9);
        expect(fitsDailyBudget(spent, caps.hunt, caps.daily)).toBe(true);
        const meter = new CreditMeter(caps.hunt, caps.daily, spent);
        let total = 0;
        let stopped = false;
        for (const usage of reports) {
          total += usage;
          const verdict = meter.add(usage);
          const shouldStop = total >= caps.hunt || spent + total >= caps.daily;
          expect(verdict !== null).toBe(shouldStop);
          expect(meter.total).toBeCloseTo(total, 9);
          if (verdict !== null) {
            expect(verdict).toBe(total >= caps.hunt ? 'credit_cap' : 'daily_cap');
            // The recorded total exceeds the cap by at most the report that crossed it.
            if (verdict === 'credit_cap') expect(meter.total - caps.hunt).toBeLessThan(usage + 1e-9);
            else expect(meter.dayTotal - caps.daily).toBeLessThan(usage + 1e-9);
            stopped = true;
            break;
          }
        }
        if (!stopped) expect(total).toBeLessThan(caps.hunt);
      }),
      RUNS,
    );
  });

  it('does not start a hunt when the day plus the per-hunt cap would pass the daily cap', () => {
    fc.assert(
      fc.property(capsArb, fc.double({ min: 0, max: 130, noNaN: true }), (caps, spent) => {
        expect(fitsDailyBudget(spent, caps.hunt, caps.daily)).toBe(spent + caps.hunt <= caps.daily);
      }),
      RUNS,
    );
    expect(fitsDailyBudget(28.5, 1.5, 30)).toBe(true);
    expect(fitsDailyBudget(28.6, 1.5, 30)).toBe(false);
  });

  it('ignores a report that is not a positive number, and counts tool calls up to the limit', () => {
    const m = new CreditMeter(1, 10, 0);
    for (const bad of [Number.NaN, -1, 0, Number.POSITIVE_INFINITY * 0]) expect(m.add(bad)).toBeNull();
    expect(m.total).toBe(0);
    expect(m.add(1)).toBe('credit_cap');
    const c = new ToolCounter(3);
    expect([c.add(), c.add(), c.add(), c.add()]).toEqual([null, null, null, 'tool_limit']);
    expect(c.count).toBe(4);
  });
});

// Feature: exorcist-agent, Property 19
describe('Property 19: every Tool Load shape of the six tools is accepted, and nothing else', () => {
  const ONE = ['id', 'tool_id'] as const;
  const MANY = ['tool_ids', 'ids', 'tools', 'toolIds'] as const;
  const FORMS = [(t: string) => `tool::exorcist::${t}`, (t: string) => `@exorcist/${t}`, (t: string) => t] as const;
  const toolArb = fc.constantFrom(...HUNT_TOOLS);
  const formArb = fc.constantFrom(...FORMS);

  it('accepts one id under id or tool_id, and a list under tool_ids, ids, tools or toolIds, in each name form', () => {
    fc.assert(
      fc.property(fc.constantFrom(...ONE), fc.constantFrom(...MANY), formArb, fc.array(fc.tuple(formArb, toolArb), { minLength: 1, maxLength: 6 }), toolArb, (one, many, form, list, tool) => {
        expect(checkToolCall(call('Tool Load', { [one]: form(tool) })).kind).toBe('load');
        expect(checkToolCall(call('Tool Load', { [many]: list.map(([f, t]) => f(t)) })).kind).toBe('load');
        // Extra keys that name nothing are not read.
        expect(checkToolCall(call('Tool Load', { [one]: form(tool), reason: 'need it', extra: { a: 1 } })).kind).toBe('load');
      }),
      RUNS,
    );
  });

  it('refuses a list with one foreign member, a list under a one-id key, an id under a list key, empty and mistyped values', () => {
    fc.assert(
      fc.property(fc.constantFrom(...ONE), fc.constantFrom(...MANY), formArb, toolArb, fc.constantFrom('fs_read', 'execute_bash', 'tool::other::query_metrics', '@other/query_metrics', 'exorcist/query_metrics', '', '@exorcist/', 'QUERY_METRICS'), (one, many, form, tool, bad) => {
        expect(checkToolCall(call('Tool Load', { [many]: [form(tool), bad] })).kind).toBe('foreign');
        expect(checkToolCall(call('Tool Load', { [one]: bad })).kind).toBe('foreign');
        expect(checkToolCall(call('Tool Load', { [one]: [form(tool)] })).kind).toBe('foreign');
        expect(checkToolCall(call('Tool Load', { [many]: form(tool) })).kind).toBe('foreign');
        expect(checkToolCall(call('Tool Load', { [many]: [] })).kind).toBe('foreign');
        expect(checkToolCall(call('Tool Load', { [many]: [7] })).kind).toBe('foreign');
        // Mixing a good key with a bad one still refuses.
        expect(checkToolCall(call('Tool Load', { [one]: form(tool), [many]: [bad] })).kind).toBe('foreign');
      }),
      RUNS,
    );
  });

  it('describes a refusal in at most 200 characters with no control character, and reads only the title and the ids', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300, unit: 'binary' }), fc.array(fc.string({ maxLength: 100, unit: 'binary' }), { maxLength: 9 }), (title, ids) => {
        for (const t of [title, 'Tool Load']) {
          const text = describeForeign(t, { ids, secret: 'must-not-appear', path: '/etc/hosts' });
          expect(text.length).toBeGreaterThan(0);
          expect(text.length).toBeLessThanOrEqual(200);
          // eslint-disable-next-line no-control-regex
          expect(text).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
          expect(text).not.toContain('must-not-appear');
          expect(text).not.toContain('/etc/hosts');
        }
      }),
      RUNS,
    );
  });
});

// Feature: exorcist-agent, Property 21
describe('Property 21: the Tool Call wrapper is accepted iff it names one of the six exorcist tools', () => {
  const wrapper = (rawInput: unknown): Call => call('Tool Call', rawInput);
  const idArb = fc.oneof(
    fc.constantFrom(...HUNT_TOOLS).map((t) => `tool::exorcist::${t}`),
    fc.constantFrom('tool::builtin::execute_bash', 'tool::builtin::fs_read', 'tool::other::query_metrics', 'tool::exorcist::fs_read', 'tool::exorcist::', 'tool::exorcist::query_metrics ', 'tool::exorcist::QUERY_METRICS', '@exorcist/query_metrics', 'query_metrics', '', 'tool::exorcist::query_metrics::x', ' tool::exorcist::query_metrics'),
    fc.string({ maxLength: 60 }),
  );
  const good = (id: string): boolean => /^tool::exorcist::(query_metrics|search_errors|tail_logs|recent_deploys|diff_commit|submit_diagnosis)$/.test(id);

  it('becomes a step of that tool with the arguments as input, exactly for the six', () => {
    fc.assert(
      fc.property(idArb, fc.dictionary(fc.string({ maxLength: 8 }), fc.oneof(fc.string({ maxLength: 12 }), fc.integer()), { maxKeys: 4 }), (id, args) => {
        const verdict = checkToolCall(wrapper({ tool_id: id, arguments: args }));
        if (good(id)) {
          expect(verdict).toEqual({ kind: 'step', tool: id.slice('tool::exorcist::'.length), id: 'c', input: args });
        } else {
          expect(verdict.kind).toBe('foreign');
        }
      }),
      RUNS,
    );
  });

  it('refuses extra keys, missing keys, and arguments that are not an object', () => {
    const id = 'tool::exorcist::diff_commit';
    for (const raw of [
      { tool_id: id, arguments: {}, extra: 1 },
      { tool_id: id },
      { arguments: {} },
      {},
      { tool_id: id, arguments: null },
      { tool_id: id, arguments: [] },
      { tool_id: id, arguments: 'sha' },
      { tool_id: id, arguments: 7 },
      { tool_id: 7, arguments: {} },
      { tool_id: [id], arguments: {} },
      { id, arguments: {} },
      { tool_id: id, args: {} },
      null,
      'tool::exorcist::diff_commit',
      [id],
    ]) {
      expect(checkToolCall(wrapper(raw)).kind, JSON.stringify(raw)).toBe('foreign');
      expect(wrappedCall(raw)).toBeNull();
    }
    expect(wrappedCall({ tool_id: id, arguments: { sha: 'abc1234' } })).toEqual({ tool: 'diff_commit', arguments: { sha: 'abc1234' } });
  });

  it('is read only for the title Tool Call: the same input under another title is not a wrapper', () => {
    const raw = { tool_id: 'tool::exorcist::diff_commit', arguments: { sha: 'abc1234' } };
    for (const title of ['tool call', 'Tool  Call', 'Tool Call ', '@exorcist/Tool Call', '']) expect(checkToolCall(call(title, raw)).kind).toBe('foreign');
  });

  it('names the refused tool_id in the stop detail, cleaned, in at most 80 characters', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 120, unit: 'binary' }), (id) => {
        const text = describeForeign('Tool Call', { tool_id: id, arguments: { command: 'must-not-appear' } });
        expect(text.startsWith('Tool Call tool_id=')).toBe(true);
        expect(text.length).toBeLessThanOrEqual(80);
        // eslint-disable-next-line no-control-regex
        expect(text).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
        expect(text).not.toContain('must-not-appear');
      }),
      RUNS,
    );
    expect(describeForeign('Tool Call', { tool_id: 'tool::builtin::execute_bash', arguments: {} })).toBe('Tool Call tool_id=tool::builtin::execute_bash');
    expect(describeForeign('Tool Call', {})).toBe('Tool Call');
  });
});

// Feature: exorcist-agent, Property 22: a repeated tool call id is the same call only if it names the same tool
describe('Property 22: an id seen again passes only when it names the tool it was accepted for', () => {
  const tool = fc.constantFrom(...HUNT_TOOLS);
  const names = (t: string): unknown => ({ tool_id: `tool::exorcist::${t}`, arguments: {} });
  type Title = { kind: 'none' } | { kind: 'empty' } | { kind: 'direct'; tool: string } | { kind: 'wrap' } | { kind: 'load' } | { kind: 'foreign'; title: string };
  type Input = { kind: 'absent' } | { kind: 'args' } | { kind: 'names'; tool: string };
  const title: fc.Arbitrary<Title> = fc.oneof(
    fc.constant<Title>({ kind: 'none' }),
    fc.constant<Title>({ kind: 'empty' }),
    tool.map<Title>((t) => ({ kind: 'direct', tool: t })),
    fc.constant<Title>({ kind: 'wrap' }),
    fc.constant<Title>({ kind: 'load' }),
    fc.constantFrom('fs_read', 'execute_bash', '@exorcist/shell', '@other/query_metrics', 'x').map<Title>((t) => ({ kind: 'foreign', title: t })),
  );
  const input: fc.Arbitrary<Input> = fc.oneof(fc.constant<Input>({ kind: 'absent' }), fc.constant<Input>({ kind: 'args' }), tool.map<Input>((t) => ({ kind: 'names', tool: t })));
  const titleText = (t: Title): string | null => (t.kind === 'none' ? null : t.kind === 'empty' ? '' : t.kind === 'direct' ? `@exorcist/${t.tool}` : t.kind === 'wrap' ? 'Tool Call' : t.kind === 'load' ? 'Tool Load' : t.title);
  const inputValue = (i: Input): unknown => (i.kind === 'absent' ? undefined : i.kind === 'args' ? { service: 'payments' } : names(i.tool));

  it('holds for any step and any later event with its id', () => {
    fc.assert(
      fc.property(tool, title, input, (accepted, t, i) => {
        // The oracle: no title or the same direct title, or the wrapper title with an input that names the same tool;
        // and an input that, when it names a tool, names the same one.
        const titleOk = t.kind === 'none' || t.kind === 'empty' || (t.kind === 'direct' && t.tool === accepted) || (t.kind === 'wrap' && (i.kind === 'absent' || (i.kind === 'names' && i.tool === accepted)));
        const inputOk = i.kind !== 'names' || i.tool === accepted;
        expect(isSameCall({ kind: 'step', tool: accepted }, titleText(t), inputValue(i))).toBe(titleOk && inputOk);
      }),
      RUNS,
    );
  });

  it('holds for any load and any later event with its id', () => {
    const loadInput = fc.oneof(fc.constant(undefined), tool.map((t) => ({ id: `tool::exorcist::${t}` })), tool.map((t) => ({ ids: [`@exorcist/${t}`] })), fc.constant({ id: 'fs_read' }));
    fc.assert(
      fc.property(tool, title, loadInput, (accepted, t, i) => {
        const expected = (t.kind === 'none' || t.kind === 'empty' || t.kind === 'load') && (i === undefined || (loadedTools(i)?.length === 1 && loadedTools(i)?.[0] === accepted));
        expect(isSameCall({ kind: 'load', names: [accepted] }, titleText(t), i)).toBe(expected);
      }),
      RUNS,
    );
  });

  it('passes the update sequences of kiro-cli 3.3.0 and refuses a swapped title', () => {
    const step = { kind: 'step', tool: 'query_metrics' } as const;
    const args = { service: 'payments', signal: 'error_ratio', window: '15m' };
    expect(isSameCall(step, null, undefined)).toBe(true);
    expect(isSameCall(step, '@exorcist/query_metrics', args)).toBe(true);
    expect(isSameCall(step, 'fs_read', { path: '/etc/hosts' })).toBe(false);
    const wrapped = { kind: 'step', tool: 'diff_commit' } as const;
    expect(isSameCall(wrapped, 'Tool Call', { tool_id: 'tool::exorcist::diff_commit', arguments: {} })).toBe(true);
    expect(isSameCall(wrapped, 'Tool Call', { tool_id: 'tool::exorcist::tail_logs', arguments: {} })).toBe(false);
    const load: AcceptedCall = { kind: 'load', names: ['query_metrics'] };
    expect(isSameCall(load, 'Tool Load', undefined)).toBe(true);
    expect(isSameCall(load, 'Tool Load', { id: 'tool::exorcist::query_metrics' })).toBe(true);
    expect(isSameCall(load, 'fs_read', undefined)).toBe(false);
  });
});
