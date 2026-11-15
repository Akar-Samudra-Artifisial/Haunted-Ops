import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PROPOSAL_FAIL_REASONS } from '@haunted-ops/shared';
import { MAX_LINE_BYTES, StreamParser, type HuntStreamEvent } from '../hunts/stream-parser.js';
import { FixerGuard } from './fixer-guard.js';
import { FINAL_AFTER_MERGE, afterMergeDecision } from './proposal-runner.js';

const FOLDER = '/work/fixer/cmproposal0000000000000001/work';
const line = (u: Record<string, unknown>): string => JSON.stringify({ type: 'sessionUpdate', data: { sessionId: 's', update: u } });
const callLines = (id: string, title: string, rawInput: Record<string, unknown>): string[] => [
  line({ sessionUpdate: 'tool_call', toolCallId: id, title, kind: title === 'Read File' ? 'read' : 'edit', rawInput }),
  line({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'pending', rawInput }),
  line({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', title, rawInput }),
];
const call = fc.record({
  title: fc.constantFrom('Read File', 'Replace in File', 'Write File'),
  file: fc.stringMatching(/^[a-z]{1,8}\.ts$/),
});
const input = (title: string, path: string): Record<string, unknown> =>
  title === 'Read File' ? { path, offset: null, limit: null } : title === 'Write File' ? { path, text: 'x' } : { path, oldStr: 'a', newStr: 'b' };

/** What the fixer run does with a stream: the index of the line it stops at (and why), or null. */
function stopsAt(lines: string[]): { at: number; code: string } | null {
  const guard = new FixerGuard(FOLDER, { writeScope: 'services/payments/src/' });
  const parser = new StreamParser();
  for (const [i, l] of lines.entries()) {
    for (const ev of parser.push(`${l}\n`) as HuntStreamEvent[]) {
      if (ev.type === 'malformed') return { at: i, code: 'stream_malformed' };
      if (ev.type === 'tool_call' || ev.type === 'tool_call_update') {
        const out = guard.judge(ev);
        if (out.kind === 'stop') return { at: i, code: out.code };
      }
    }
  }
  return null;
}

// Feature: fix-proposal-flow, Property 17
describe('Property 17: the fixer run fails closed on what the guard cannot judge', () => {
  const stream = fc.array(call, { minLength: 1, maxLength: 8 }).map((cs) => cs.flatMap((c, i) => callLines(`id-${i}`, c.title, input(c.title, `services/payments/src/${c.file}`))));

  it('stops at the first malformed or oversized line', () => {
    fc.assert(
      fc.property(stream, fc.nat(), fc.constantFrom('not json', '{"type":', `${'x'.repeat(MAX_LINE_BYTES + 10)}`), (lines, at, bad) => {
        expect(stopsAt(lines)).toBeNull();
        const k = at % (lines.length + 1);
        const mutated = [...lines.slice(0, k), bad, ...lines.slice(k)];
        expect(stopsAt(mutated)).toEqual({ at: k, code: 'stream_malformed' });
      }),
      { numRuns: 100 },
    );
  });

  it('stops a file-tool call whose arguments are never seen, at its first update past pending', () => {
    fc.assert(
      fc.property(stream, call, fc.constantFrom('in_progress', 'completed', 'failed'), (lines, c, status) => {
        const k = lines.length;
        const blind = [
          line({ sessionUpdate: 'tool_call', toolCallId: 'blind', title: c.title, kind: 'edit' }),
          line({ sessionUpdate: 'tool_call_update', toolCallId: 'blind', status: 'pending', rawInput: {} }),
          line({ sessionUpdate: 'tool_call_update', toolCallId: 'blind', status, title: c.title }),
        ];
        expect(stopsAt([...lines, ...blind])).toEqual({ at: k + 2, code: 'unjudged_input' });
      }),
      { numRuns: 100 },
    );
  });
});

// Feature: fix-proposal-flow, Property 18
describe('Property 18: a transient error after the merge never ends the Proposal early', () => {
  it('ends it early only for the reasons a retry cannot change, and deploy_unconfirmed once the window is over', () => {
    fc.assert(
      fc.property(fc.constantFrom(...PROPOSAL_FAIL_REASONS), fc.boolean(), (reason, windowOver) => {
        const d = afterMergeDecision(reason, windowOver);
        if (FINAL_AFTER_MERGE.has(reason)) expect(d).toEqual({ kind: 'fail', reason });
        else if (windowOver) expect(d).toEqual({ kind: 'fail', reason: 'deploy_unconfirmed' });
        else expect(d).toEqual({ kind: 'retry' });
      }),
      { numRuns: 200 },
    );
    expect([...FINAL_AFTER_MERGE].sort()).toEqual(['deploy_rejected', 'head_changed', 'merge_content', 'merge_scope', 'ref_moved']);
  });
});
