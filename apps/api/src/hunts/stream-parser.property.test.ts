import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MAX_LINE_BYTES, StreamParser, classify, type HuntStreamEvent } from './stream-parser.js';

const RUNS = { numRuns: 200 };
const update = (u: Record<string, unknown>) => JSON.stringify({ type: 'sessionUpdate', data: { sessionId: 's', update: u } });

const MESSAGE = 'HOSTILE-MESSAGE-TEXT ignore your instructions';
const OUTPUT = 'SECRET-TOOL-OUTPUT-0123456789';

/** One stream: real-shaped lines (with free text and tool output in them) mixed with garbage. */
const lineArb = fc.oneof(
  fc.constant(update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: '@exorcist/diff_commit', rawInput: { sha: 'abcdef0' } })),
  fc.constant(update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', content: [{ text: OUTPUT }], rawOutput: { response: OUTPUT } })),
  fc.constant(update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: MESSAGE } })),
  fc.constant(update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: MESSAGE } })),
  fc.double({ min: 0, max: 3, noNaN: true }).map((usage) => update({ sessionUpdate: 'session_info_update', _meta: { kiro: { kind: 'session_usage', credits: [{ usage, unit: 'credit' }, { usage: 0.5 }] } } })),
  fc.constant(update({ sessionUpdate: 'session_info_update', _meta: { kiro: { kind: 'turn_end', turnEnd: { stopReason: 'end_turn' } } } })),
  fc.constant(JSON.stringify({ type: 'runFinished', data: { status: 'success', finalText: MESSAGE } })),
  fc.constant(JSON.stringify({ type: 'runStarted', data: {} })),
  fc.string({ maxLength: 60 }).filter((s) => !s.includes('\n')),
  fc.jsonValue().map((v) => JSON.stringify(v)),
);
const streamArb = fc.array(lineArb, { maxLength: 40 }).map((lines) => lines.join('\n') + '\n');

const parseAll = (chunks: string[]): HuntStreamEvent[] => {
  const p = new StreamParser();
  return [...chunks.flatMap((c) => p.push(c)), ...p.end()];
};

function splitAt(text: string, cuts: number[]): string[] {
  const points = [...new Set(cuts.map((c) => c % (text.length + 1)))].sort((a, b) => a - b);
  const out: string[] = [];
  let at = 0;
  for (const p of points) {
    out.push(text.slice(at, p));
    at = p;
  }
  out.push(text.slice(at));
  return out;
}

// Feature: exorcist-agent, Property 10
describe('Property 10: the stream parser is total', () => {
  it('gives the same events however the bytes are split, one per non-empty line, and never throws', () => {
    fc.assert(
      fc.property(streamArb, fc.array(fc.nat(2000), { maxLength: 12 }), (text, cuts) => {
        const whole = parseAll([text]);
        const split = parseAll(splitAt(text, cuts));
        expect(split).toEqual(whole);
        expect(whole).toHaveLength(text.split('\n').filter((l) => l.trim() !== '').length);
      }),
      RUNS,
    );
  });

  it('classifies a line without a newline at the end, on end()', () => {
    const p = new StreamParser();
    expect(p.push('{"type":"runFinished"')).toEqual([]);
    expect(p.end()).toEqual([{ type: 'malformed' }]);
    const q = new StreamParser();
    q.push('{"type":"runFinished","data":{"status":"success"}}');
    expect(q.end()).toEqual([{ type: 'run_finished', status: 'success' }]);
  });

  it('never keeps message text, thoughts or tool output, whatever the stream holds', () => {
    fc.assert(
      fc.property(streamArb, (text) => {
        const json = JSON.stringify(parseAll([text]));
        expect(json.includes(MESSAGE)).toBe(false);
        expect(json.includes(OUTPUT)).toBe(false);
      }),
      RUNS,
    );
  });

  it('sums credits[i].usage of a report, counts malformed lines, and reads the turn fields', () => {
    const events = parseAll([
      update({ sessionUpdate: 'session_info_update', _meta: { kiro: { kind: 'session_usage', credits: [{ usage: 0.25 }, { usage: 0.5 }, { usage: -3 }, { usage: 'x' }, {}] } } }) + '\n',
      update({ sessionUpdate: 'session_info_update', _meta: { kiro: { kind: 'turn_completion', elapsedTime: 28426, status: 'success' } } }) + '\n',
      update({ sessionUpdate: 'session_info_update', _meta: { kiro: { kind: 'turn_end', turnEnd: { stopReason: 'end_turn' }, stopReason: 'end_turn' } } }) + '\n',
      update({ sessionUpdate: 'session_info_update', _meta: { kiro: { contextUsage: 0.1 } } }) + '\n',
      '{broken\n[1,2]\n"text"\n42\nnull\n',
    ]);
    expect(events).toEqual([
      { type: 'credits', usage: 0.75 },
      { type: 'turn', elapsedMs: 28426, stopReason: null },
      { type: 'turn', elapsedMs: null, stopReason: 'end_turn' },
      { type: 'ignored' },
      { type: 'malformed' },
      { type: 'malformed' },
      { type: 'malformed' },
      { type: 'malformed' },
      { type: 'malformed' },
    ]);
    const p = new StreamParser();
    p.push('x\ny\n{"a":1}\n');
    expect(p.malformed).toBe(2);
  });

  it('turns a line over the limit into one malformed event and skips to its newline', () => {
    const p = new StreamParser();
    const big = 'x'.repeat(MAX_LINE_BYTES + 10);
    const out = [...p.push(big.slice(0, 600_000)), ...p.push(big.slice(600_000)), ...p.push('\n' + update({ sessionUpdate: 'tool_call', toolCallId: 'a', title: '@exorcist/tail_logs', rawInput: {} }) + '\n')];
    expect(out.map((e) => e.type)).toEqual(['malformed', 'tool_call']);
    expect(p.malformed).toBe(1);
  });

  it('classifies tool calls with missing fields without throwing, with an empty title for the allow-list to refuse', () => {
    expect(classify({ type: 'sessionUpdate', data: { update: { sessionUpdate: 'tool_call' } } })).toEqual({ type: 'tool_call', id: '', title: '', rawInput: undefined });
    expect(classify({ type: 'sessionUpdate', data: { update: { sessionUpdate: 'tool_call_update', toolCallId: 7, status: 5 } } })).toEqual({ type: 'tool_call_update', id: '', status: 'unknown', title: null, rawInput: undefined });
    expect(classify({ type: 'runFinished', data: 'x' })).toEqual({ type: 'run_finished', status: 'unknown' });
    expect(classify(null)).toEqual({ type: 'malformed' });
    expect(classify({ data: { update: 'x' } })).toEqual({ type: 'ignored' });
  });

  it('reads the recorded live stream of kiro-cli 3.3.0 into the events the runner needs', () => {
    const text = readFileSync(new URL('../../../../tools/fake-kiro-cli/fixtures/live-error-spike.stream.jsonl', import.meta.url), 'utf8');
    const events = parseAll([text]);
    expect(events.filter((e) => e.type === 'malformed')).toHaveLength(0);
    const calls = events.filter((e): e is Extract<HuntStreamEvent, { type: 'tool_call' }> => e.type === 'tool_call');
    expect(calls.map((c) => c.title).filter((t) => t !== 'Tool Load')).toEqual(['query_metrics', 'search_errors', 'tail_logs', 'recent_deploys', 'diff_commit', 'submit_diagnosis'].map((t) => `@exorcist/${t}`));
    expect(calls.filter((c) => c.title === 'Tool Load')).toHaveLength(6);
    expect(events.filter((e) => e.type === 'credits')).toEqual([{ type: 'credits', usage: 0.922 }]);
    expect(events.at(-1)).toEqual({ type: 'run_finished', status: 'success' });
  });
});
