import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkToolCall, describeForeign } from './guards.js';
import { StreamRecorder, reduceStreamLine } from './stream-recorder.js';
import { stepSummary } from './step-summary.js';
// Feature: exorcist-agent, Property 24 (the purpose text is never kept or shown)
const PURPOSE = 'PURPOSE-TEXT Find when payments error ratio changed';
const root = mkdtempSync(join(tmpdir(), 'purpose-key-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const callLine = (rawInput: unknown): string =>
  JSON.stringify({ type: 'sessionUpdate', data: { sessionId: 's', update: { sessionUpdate: 'tool_call', toolCallId: 'toolu_1', title: 'Running: @exorcist/query_metrics', rawInput, _meta: { kiro: { toolName: 'query_metrics', mcpServerName: 'exorcist' } } } } });
const ARGS = { service: 'payments', signal: 'error_ratio', window: '15m' };
describe('the key `__tool_use_purpose`', () => {
  it('is not in the step summary, and the call still gets its normal summary', () => {
    expect(stepSummary('query_metrics', { ...ARGS, __tool_use_purpose: PURPOSE })).toBe('metrics payments error_ratio 15m');
    expect(stepSummary('query_metrics', { ...ARGS, __tool_use_purpose: PURPOSE, extra: 1 })).toBe('query_metrics (input refused)');
  });
  it('is not in a refused call or its stop detail', () => {
    const v = checkToolCall({ id: 'c', title: 'Running: @other/query_metrics', rawInput: { ...ARGS, __tool_use_purpose: PURPOSE } });
    expect(v).toEqual({ kind: 'foreign', title: 'Running: @other/query_metrics' });
    expect(describeForeign('Running: @other/query_metrics', { __tool_use_purpose: PURPOSE })).not.toContain('PURPOSE-TEXT');
    expect(describeForeign('Tool Call', { tool_id: 'tool::builtin::x', arguments: { __tool_use_purpose: PURPOSE } })).not.toContain('PURPOSE-TEXT');
  });
  it('is not written by the stream recorder, at the top of the input or in the arguments of a wrapper', async () => {
    expect(reduceStreamLine(callLine({ ...ARGS, __tool_use_purpose: PURPOSE }), [])).not.toContain('PURPOSE-TEXT');
    expect(JSON.parse(reduceStreamLine(callLine({ ...ARGS, __tool_use_purpose: PURPOSE }), []) as string).data.update).toMatchObject({ rawInput: ARGS, title: 'Running: @exorcist/query_metrics', _meta: { kiro: { mcpServerName: 'exorcist' } } });
    expect(reduceStreamLine(callLine({ tool_id: 'tool::exorcist::tail_logs', arguments: { ...ARGS, __tool_use_purpose: PURPOSE } }), [])).not.toContain('PURPOSE-TEXT');
    // Another unknown key is kept as it is (the recording is for seeing shapes).
    expect(reduceStreamLine(callLine({ ...ARGS, __tool_use_purpose: PURPOSE, extra: 1 }), [])).toContain('"extra":1');
    const path = join(root, 'cmpurposeaaaaaaaaaaaaaaaaa.stream.jsonl');
    const rec = new StreamRecorder(path, []);
    rec.write(`${callLine({ ...ARGS, __tool_use_purpose: PURPOSE })}\n`);
    await rec.close();
    expect(readFileSync(path, 'utf8')).not.toContain('PURPOSE-TEXT');
  });
});
