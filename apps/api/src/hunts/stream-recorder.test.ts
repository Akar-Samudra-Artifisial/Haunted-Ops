import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterAll, describe, expect, it } from 'vitest';
import { creditsLine, finishedLine, loadLine, toolCallLine, toolUpdateLine } from '../../test/support/hunts.js';
import { HuntWorkdir, KEEP_STREAMS } from './hunt-workdir.js';
import { StreamRecorder, reduceStreamLine } from './stream-recorder.js';

const SECRET = 'lab-read-token-0123456789-abcdef';
const root = mkdtempSync(join(tmpdir(), 'stream-rec-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const line = (o: unknown): string => JSON.stringify(o);
const update = (u: Record<string, unknown>): string => line({ type: 'sessionUpdate', data: { sessionId: 'abc', update: u } });

describe('reduceStreamLine', () => {
  it('keeps tool calls with title and input, updates without the tool output, credits and the run ends', () => {
    const call = reduceStreamLine(toolCallLine('c1', '@exorcist/query_metrics', { service: 'payments' }).trim(), []);
    expect(JSON.parse(call as string)).toMatchObject({ data: { update: { sessionUpdate: 'tool_call', toolCallId: 'c1', title: '@exorcist/query_metrics', rawInput: { service: 'payments' } } } });
    const upd = reduceStreamLine(update({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', title: 'x', content: [{ text: 'LAB TEXT' }], rawOutput: { response: 'TOOL OUTPUT' } }), []);
    expect(upd).not.toContain('LAB TEXT');
    expect(upd).not.toContain('TOOL OUTPUT');
    expect(JSON.parse(upd as string).data.update).toMatchObject({ toolCallId: 'c1', status: 'completed', title: 'x' });
    expect(reduceStreamLine(creditsLine(0.9).trim(), [])).toContain('0.9');
    expect(reduceStreamLine(finishedLine().trim(), [])).toContain('runFinished');
    expect(reduceStreamLine(line({ type: 'runFinished', data: { status: 'success', finalText: 'THE AGENT SAYS' } }), [])).not.toContain('THE AGENT SAYS');
  });

  it('drops the model text, its thoughts, bad lines and long lines, and masks secrets', () => {
    expect(reduceStreamLine(update({ sessionUpdate: 'agent_message_chunk', content: { text: 'hello' } }), [])).toBeNull();
    expect(reduceStreamLine(update({ sessionUpdate: 'agent_thought_chunk', content: { text: 'hmm' } }), [])).toBeNull();
    expect(reduceStreamLine('not json', [])).toBeNull();
    expect(reduceStreamLine('[1]', [])).toBeNull();
    expect(reduceStreamLine(update({ sessionUpdate: 'tool_call', toolCallId: 'x', title: 'a', rawInput: { pad: 'x'.repeat(70_000) } }), [])).toBeNull();
    const masked = reduceStreamLine(toolCallLine('c2', '@exorcist/tail_logs', { since: SECRET }).trim(), [SECRET]);
    expect(masked).not.toContain(SECRET);
    expect(masked).toContain('[redacted]');
  });

  it('never keeps a text of the agent, whatever the line is', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), fc.constantFrom('agent_message_chunk', 'agent_thought_chunk', 'tool_call_update', 'session_info_update', 'plan'), (text, kind) => {
        const out = reduceStreamLine(update({ sessionUpdate: kind, content: { text: `AGENT-${text}` }, rawOutput: { response: `OUT-${text}` } }), []);
        if (out !== null) {
          expect(out).not.toContain('AGENT-');
          expect(out).not.toContain('OUT-');
        }
      }),
      { numRuns: 100 },
    );
  });
});

describe('StreamRecorder', () => {
  it('writes the reduced stream in order, whatever the chunk boundaries, with mode 0600', async () => {
    const path = join(root, 'cmrecorderaaaaaaaaaaaaaaa.stream.jsonl');
    const rec = new StreamRecorder(path, [SECRET]);
    const text = [loadLine('l1', 'query_metrics'), toolUpdateLine('l1'), toolCallLine('c1', '@exorcist/query_metrics', { service: 'payments', signal: 'error_ratio', window: '15m' }), creditsLine(0.9), finishedLine()].join('');
    for (let i = 0; i < text.length; i += 37) rec.write(text.slice(i, i + 37));
    await rec.close();
    const lines = readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { type: string; data: { update?: { toolCallId?: string; sessionUpdate: string } } });
    expect(lines.map((l) => l.data.update?.sessionUpdate ?? l.type)).toEqual(['tool_call', 'tool_call_update', 'tool_call', 'session_info_update', 'runFinished']);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('keeps a last line without a newline, and survives a path that cannot be written', async () => {
    const path = join(root, 'cmrecorderbbbbbbbbbbbbbbb.stream.jsonl');
    const rec = new StreamRecorder(path, []);
    rec.write(finishedLine().trim());
    await rec.close();
    expect(readFileSync(path, 'utf8')).toContain('runFinished');
    const lost = new StreamRecorder(join(root, 'no', 'such', 'folder', 'x.stream.jsonl'), []);
    lost.write(finishedLine());
    await expect(lost.close()).resolves.toBeUndefined();
  });
});

describe('HuntWorkdir: stream files', () => {
  it('keeps the newest 20 stream files across hunts and never touches other files of the folder', async () => {
    const dir = join(root, 'hunts');
    const workdir = new HuntWorkdir(dir, join(root, 'agent.json'));
    writeFileSync(join(root, 'agent.json'), '{}');
    await workdir.prepare();
    const ids = Array.from({ length: KEEP_STREAMS + 5 }, (_, i) => `cmstream${String(i).padStart(17, '0')}`);
    ids.forEach((id, i) => {
      const p = workdir.streamPath(id);
      writeFileSync(p, '{}\n');
      utimesSync(p, new Date(2026, 10, 13, 10, i), new Date(2026, 10, 13, 10, i));
    });
    writeFileSync(join(dir, 'stray.txt'), 'x');
    await workdir.prepare(); // prepare keeps stream files and removes the stray file
    expect(readdirSync(dir).filter((n) => n.endsWith('.stream.jsonl'))).toHaveLength(KEEP_STREAMS + 5);
    expect(readdirSync(dir)).not.toContain('stray.txt');
    await workdir.pruneStreams();
    const left = readdirSync(dir).filter((n) => n.endsWith('.stream.jsonl')).sort();
    expect(left).toHaveLength(KEEP_STREAMS);
    expect(left).toEqual(ids.slice(5).map((id) => `${id}.stream.jsonl`));
    expect(() => workdir.streamPath('../evil')).toThrow();
  });
});
