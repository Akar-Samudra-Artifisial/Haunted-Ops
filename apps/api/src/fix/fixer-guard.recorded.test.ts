import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { StreamParser, type HuntStreamEvent } from '../hunts/stream-parser.js';
import { FixerGuard, RECORDED_TITLES, type GuardOutcome } from './fixer-guard.js';

/**
 * The guard against the three sanitized recordings of kiro-cli 3.3.0 (`apps/api/test/fixtures/fixer-streams/`), and
 * mutated copies of them. No kiro-cli runs here.
 */
const FOLDER = '/work/fixer/cmproposal0000000000000001/work';
const fixture = (name: string): string => readFileSync(new URL(`../../test/fixtures/fixer-streams/${name}`, import.meta.url), 'utf8');
const events = (text: string): HuntStreamEvent[] => {
  const p = new StreamParser();
  return [...p.push(text), ...p.end()].filter((e) => e.type === 'tool_call' || e.type === 'tool_call_update');
};
/** Replays a stream; returns the first stop (and where it happened) or null. */
function replay(text: string, writeScope: string): { at: number; outcome: Extract<GuardOutcome, { kind: 'stop' }> } | null {
  const guard = new FixerGuard(FOLDER, { writeScope });
  const evs = events(text);
  for (let i = 0; i < evs.length; i++) {
    const out = guard.judge(evs[i] as HuntStreamEvent);
    if (out.kind === 'stop') return { at: i, outcome: out };
  }
  return null;
}
/** A copy of a recorded stream with `edit` applied to the update of line `index` (0-based, over all lines). */
function mutate(text: string, index: number, edit: (u: Record<string, unknown>) => void): string {
  return text
    .trim()
    .split('\n')
    .map((line, i) => {
      if (i !== index) return line;
      const ev = JSON.parse(line) as { data: { update: Record<string, unknown> } };
      edit(ev.data.update);
      return JSON.stringify(ev);
    })
    .join('\n')
    .concat('\n');
}

const FIRST = fixture('live-fix-first-call.stream.jsonl');
const REPLACE = fixture('probe-replace.stream.jsonl');
const CREATE = fixture('probe-create.stream.jsonl');

describe('the fixer guard on the recorded kiro-cli 3.3.0 streams', () => {
  it('passes the first call of the real fix run (Read File with offset and limit null)', () => {
    expect(events(FIRST)).toHaveLength(1);
    expect(replay(FIRST, 'services/payments/src/')).toBeNull();
  });

  it('ends both probe streams with no stop, and counts the calls and the writes', () => {
    expect(replay(REPLACE, 'services/x/src/')).toBeNull();
    expect(replay(CREATE, 'services/x/src/')).toBeNull();
    const guard = new FixerGuard(FOLDER, { writeScope: 'services/x/src/' });
    for (const ev of events(REPLACE)) guard.judge(ev);
    expect([guard.count, guard.writes]).toEqual([2, 1]);
  });

  it('stops a mutated copy: a foreign title, a path out of the folder, a write out of the service sources, a reused id', () => {
    const cases: Array<[string, string, string]> = [
      [mutate(REPLACE, 3, (u) => (u.title = 'Run Command')), 'foreign_tool', 'Run Command kind=edit keys=[newStr,oldStr,path]'],
      [mutate(REPLACE, 0, (u) => ((u.rawInput as Record<string, unknown>).path = '../x')), 'path_outside', 'fs_read path outside the folder kind=read keys=[limit,offset,path]'],
      [mutate(CREATE, 0, (u) => ((u.rawInput as Record<string, unknown>).path = 'package.json')), 'write_outside_scope', 'fs_write outside services/x/src/ kind=edit keys=[path,text]'],
      [mutate(REPLACE, 4, (u) => ((u.rawInput as Record<string, unknown>).path = 'services/x/package.json')), 'write_outside_scope', 'fs_write outside services/x/src/ kind=none keys=[newStr,oldStr,path,replace_all]'],
      // The Replace call's update arrives under the id of the earlier Read File call: its title is decorative, but its input is not the shape of a read.
      [mutate(REPLACE, 5, (u) => (u.toolCallId = 'call-1')), 'unknown_args', 'fs_read arguments not understood: unknown key oldStr kind=none keys=[newStr,oldStr,path,replace_all]'],
    ];
    for (const [text, code, detail] of cases) {
      const stop = replay(text, 'services/x/src/');
      expect(stop?.outcome.code, detail).toBe(code);
      expect(stop?.outcome.detail).toBe(detail);
      // No value of the input reaches the detail.
      expect(stop?.outcome.detail).not.toContain('export const');
    }
  });

  it('refuses a call whose input was never seen once it runs, and an update of an unknown id with no title', () => {
    const noInput = mutate(CREATE, 0, (u) => delete u.rawInput);
    // The `pending` update carries the input: it is judged there and the call passes.
    expect(replay(noInput, 'services/x/src/')).toBeNull();
    const never = [0, 1, 2].reduce((t, i) => mutate(t, i, (u) => delete u.rawInput), CREATE);
    expect(replay(never, 'services/x/src/')?.outcome.code).toBe('unjudged_input');
    const empty = [0, 1, 2].reduce((t, i) => mutate(t, i, (u) => (u.rawInput = {})), CREATE);
    expect(replay(empty, 'services/x/src/')?.outcome.code).toBe('unjudged_input');
    const orphan = mutate(CREATE, 1, (u) => (u.toolCallId = 'never-announced'));
    expect(replay(orphan, 'services/x/src/')?.outcome.code).toBe('unknown_update');
  });

  it('does not throw or stop on null or missing offset and limit, and refuses a non-number', () => {
    for (const extra of [{}, { offset: null }, { limit: null }, { offset: 3, limit: 10 }]) {
      const text = mutate(FIRST, 0, (u) => (u.rawInput = { path: 'services/payments/src/refunds.ts', ...extra }));
      expect(replay(text, 'services/payments/src/'), JSON.stringify(extra)).toBeNull();
    }
    const bad = replay(mutate(FIRST, 0, (u) => ((u.rawInput as Record<string, unknown>).offset = 'all')), 'services/payments/src/');
    expect(bad?.outcome.code).toBe('unknown_args');
  });
});

describe('the batch read shape of kiro-cli 3.3.0 (task 19): `Reading <file>:<line>`, `operations`, `_meta.kiro.toolName`', () => {
  const BATCH = fixture('read-operations.stream.jsonl');
  const SCOPE = 'services/payments/src/';
  const input = (u: Record<string, unknown>): Record<string, unknown> => u.rawInput as Record<string, unknown>;
  const ops = (u: Record<string, unknown>): Array<Record<string, unknown>> => input(u).operations as Array<Record<string, unknown>>;
  const withOps = (list: unknown[]): string => mutate(BATCH, 0, (u) => ((u.rawInput as Record<string, unknown>).operations = list));
  const op = (path: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ mode: 'Line', path, ...extra });

  it('passes the recorded event and counts it as one read', () => {
    expect(events(BATCH)).toHaveLength(1);
    expect(replay(BATCH, SCOPE)).toBeNull();
    const guard = new FixerGuard(FOLDER, { writeScope: SCOPE });
    for (const ev of events(BATCH)) guard.judge(ev);
    expect([guard.count, guard.writes]).toEqual([1, 0]);
  });

  it('passes 1 to 8 operations of the modes Line, Directory and Search, and the title with no toolName', () => {
    for (const n of [1, 8]) expect(replay(withOps(Array.from({ length: n }, () => op('services/payments/src/a.ts'))), SCOPE)).toBeNull();
    expect(replay(withOps([op('services/payments/src', { mode: 'Directory', depth: 2 }), op('services/payments/src', { mode: 'Search', pattern: 'refund', context_lines: 2 })]), SCOPE)).toBeNull();
    expect(replay(mutate(BATCH, 0, (u) => delete u._meta), SCOPE)).toBeNull();
  });

  it('refuses a path outside the folder, `..`, an absolute path, in any entry', () => {
    for (const path of ['/etc/passwd', '/work/fixer/other/work/x.ts', '../x', 'services/payments/../../x', '~/x', 'a\\b']) {
      const stop = replay(withOps([op('services/payments/src/a.ts'), op(path)]), SCOPE);
      expect(stop?.outcome.code, path).toBe('path_outside');
      expect(stop?.outcome.detail).toBe('fs_read path outside the folder kind=read keys=[operations]');
    }
  });

  it('refuses mode Image, image_paths, an unknown mode, an unknown key, no mode, 9 entries, none, and a non-list', () => {
    const cases: Array<[string, string]> = [
      [withOps([op('a.ts', { mode: 'Image' })]), 'image_read'],
      [withOps([{ mode: 'Image', image_paths: ['a.png'] }]), 'image_read'],
      [withOps([op('a.ts', { image_paths: ['a.png'] })]), 'unknown key image_paths'],
      [withOps([op('a.ts', { mode: 'Exec' })]), 'unknown mode'],
      [withOps([{ path: 'a.ts' }]), 'unknown mode'],
      [withOps([op('a.ts', { command: 'ls' })]), 'unknown key command'],
      [withOps(Array.from({ length: 9 }, () => op('a.ts'))), 'operations is not a list'],
      [withOps([]), 'operations is not a list'],
      [mutate(BATCH, 0, (u) => (input(u).operations = 'a.ts')), 'operations is not a list'],
      [mutate(BATCH, 0, (u) => (input(u).extra = 1)), 'unknown key extra'],
      [mutate(BATCH, 0, (u) => (input(u).path = 'a.ts')), 'unknown key path'],
    ];
    for (const [text, why] of cases) {
      const stop = replay(text, SCOPE);
      expect(stop?.outcome.code, why).toBe('unknown_args');
      expect(stop?.outcome.detail, why).toContain(why);
    }
  });

  it('refuses a toolName that is not read or write; with a toolName the title is decorative, the arguments are not', () => {
    const shell = replay(mutate(BATCH, 0, (u) => ((u._meta as { kiro: Record<string, unknown> }).kiro.toolName = 'shell')), SCOPE);
    expect(shell?.outcome.code).toBe('foreign_tool');
    expect(shell?.outcome.detail).toBe('toolName=shell kind=read keys=[operations]');
    const notText = replay(mutate(BATCH, 0, (u) => ((u._meta as { kiro: Record<string, unknown> }).kiro.toolName = { x: 1 })), SCOPE);
    expect(notText?.outcome.code).toBe('foreign_tool');
    // The name says write, so the arguments are judged as a write: a read-shaped input has no `command`.
    const asWrite = replay(mutate(BATCH, 0, (u) => ((u._meta as { kiro: Record<string, unknown> }).kiro.toolName = 'write')), SCOPE);
    expect(asWrite?.outcome.code).toBe('unknown_args');
    expect(asWrite?.outcome.detail).toContain('command is missing');
    // The name is the identity: any one-line title, and any kind, is fine (task 22).
    for (const edit of [(u: Record<string, unknown>) => (u.title = 'Replace in File'), (u: Record<string, unknown>) => (u.kind = 'edit'), (u: Record<string, unknown>) => delete u.kind, (u: Record<string, unknown>) => (u.title = 'Running ls')]) {
      expect(replay(mutate(BATCH, 0, edit), SCOPE)).toBeNull();
    }
    // Still one clean line (the parser already cuts a title at 200 characters; the guard checks the length too).
    expect(replay(mutate(BATCH, 0, (u) => (u.title = 'Reading a\nb')), SCOPE)?.outcome.code).toBe('foreign_tool');
    const guard = new FixerGuard(FOLDER, { writeScope: SCOPE });
    const long = guard.judge({ type: 'tool_call', id: 'x', title: `Reading ${'x'.repeat(200)}`, kind: 'read', rawInput: { operations: [op('services/payments/src/a.ts')] }, toolName: 'read' });
    expect(long).toMatchObject({ kind: 'stop', code: 'foreign_tool' });
    // With no toolName the recorded titles decide, as before: a dynamic title is read only when the kind says read.
    const noName = (edit: (u: Record<string, unknown>) => void): string =>
      mutate(BATCH, 0, (u) => {
        delete u._meta;
        edit(u);
      });
    expect(replay(noName((u) => (u.kind = 'edit')), SCOPE)?.outcome.code).toBe('foreign_tool');
    expect(replay(noName((u) => delete u.kind), SCOPE)?.outcome.code).toBe('foreign_tool');
    expect(replay(noName((u) => (u.title = 'Running ls')), SCOPE)?.outcome.code).toBe('foreign_tool');
    expect(replay(noName((u) => (u.title = 'Replace in File')), SCOPE)?.outcome.code).toBe('unknown_args');
  });

  it('keeps the same tool for a repeated call id: the updates pass, one that names another tool does not', () => {
    const call = JSON.parse(BATCH.trim()) as { data: { update: Record<string, unknown> } };
    const update = (extra: Record<string, unknown>): string =>
      JSON.stringify({ type: 'sessionUpdate', data: { sessionId: 'session-1', update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', ...extra } } });
    const meta = (toolName: string): Record<string, unknown> => ({ kiro: { toolName } });
    const run = (...lines: string[]) => replay([BATCH.trim(), ...lines].join('\n'), SCOPE);
    expect(run(update({ status: 'pending', title: null, rawInput: call.data.update.rawInput, _meta: meta('read') }), update({ status: 'completed', title: 'Reading refunds.ts:1', _meta: meta('read') }))).toBeNull();
    expect(run(update({ status: 'completed', title: null }))).toBeNull();
    // An update keeps the tool of its id whatever its title or `_meta` say (task 22); its input is judged again.
    expect(run(update({ status: 'completed', title: null, _meta: meta('write') }))).toBeNull();
    expect(run(update({ status: 'completed', title: 'Replace in File' }))).toBeNull();
    expect(run(update({ status: 'completed', title: 'Writing a.ts:1' }))).toBeNull();
    expect(run(update({ status: 'completed', title: 'a\nb' }))?.outcome.code).toBe('foreign_tool');
    expect(run(update({ status: 'pending', rawInput: { operations: [op('/etc/passwd')] } }))?.outcome.code).toBe('path_outside');
    expect(run(update({ status: 'pending', title: 'Reading a.ts:1', rawInput: { command: 'strReplace', path: 'services/payments/src/a.ts', oldStr: 'a', newStr: 'b' } }))?.outcome.code).toBe('unknown_args');
    // An update of an unknown id with no title is still refused, even with a tool name.
    const orphan = JSON.stringify({ type: 'sessionUpdate', data: { sessionId: 's', update: { sessionUpdate: 'tool_call_update', toolCallId: 'x', status: 'pending', _meta: meta('read') } } });
    expect(replay(orphan, SCOPE)?.outcome.code).toBe('unknown_update');
    // Same id reused for a call that names another tool.
    const second = JSON.stringify({ ...call, data: { ...call.data, update: { ...call.data.update, title: 'Write File', kind: 'edit', rawInput: { path: 'services/payments/src/a.ts', text: 'x' }, _meta: undefined } } });
    expect(run(second)?.outcome.code).toBe('foreign_tool');
    expect(ops(call.data.update)).toHaveLength(1);
  });
});

describe('the dynamic edit shape of kiro-cli 3.3.0 (task 20): `Editing <file>`, `command: strReplace`, `toolName` `write`', () => {
  const EDIT = fixture('edit-command.stream.jsonl');
  const SCOPE = 'services/payments/src/';
  const input = (u: Record<string, unknown>): Record<string, unknown> => u.rawInput as Record<string, unknown>;
  const meta = (u: Record<string, unknown>): Record<string, unknown> => (u._meta as { kiro: Record<string, unknown> }).kiro;
  const code = (text: string): string | undefined => replay(text, SCOPE)?.outcome.code;
  const update = (extra: Record<string, unknown>): string =>
    JSON.stringify({ type: 'sessionUpdate', data: { sessionId: 'session-1', update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', ...extra } } });

  it('passes the recorded event, follows its update, and counts one write', () => {
    expect(events(EDIT)).toHaveLength(2);
    expect(replay(EDIT, SCOPE)).toBeNull();
    const guard = new FixerGuard(FOLDER, { writeScope: SCOPE });
    for (const ev of events(EDIT)) guard.judge(ev);
    expect([guard.count, guard.writes]).toEqual([1, 1]);
    // With no toolName the title alone names the tool, and replace_all is accepted.
    expect(replay(mutate(EDIT, 0, (u) => delete u._meta), SCOPE)).toBeNull();
    expect(replay(mutate(EDIT, 0, (u) => (input(u).replace_all = true)), SCOPE)).toBeNull();
  });

  it('refuses a command other than strReplace, no command, and an unknown key (fail closed)', () => {
    const cases: Array<[string, string]> = [
      // `create` and `insert` are accepted now (task 22), but with their own keys: `oldStr` and `newStr` are not theirs.
      [mutate(EDIT, 0, (u) => (input(u).command = 'create')), 'unknown key oldStr'],
      [mutate(EDIT, 0, (u) => (input(u).command = 'insert')), 'unknown key oldStr'],
      [mutate(EDIT, 0, (u) => (input(u).command = 'str_replace')), 'unknown key oldStr'],
      [mutate(EDIT, 0, (u) => (input(u).command = 'delete')), 'unknown command delete'],
      // The command name is kept in the detail, cleaned; no value of the arguments is.
      [mutate(EDIT, 0, (u) => (input(u).command = 'rm -rf')), 'unknown command rm?-rf'],
      [mutate(EDIT, 0, (u) => (input(u).command = 7)), 'unknown command'],
      [mutate(EDIT, 0, (u) => delete input(u).command), 'command is missing'],
      [mutate(EDIT, 0, (u) => (input(u).extra = 1)), 'unknown key extra'],
      [mutate(EDIT, 0, (u) => (input(u).file_text = 'x')), 'unknown key file_text'],
      [mutate(EDIT, 0, (u) => (input(u).oldStr = 5)), 'oldStr or newStr is not a string'],
      [mutate(EDIT, 0, (u) => delete input(u).newStr), 'oldStr or newStr is not a string'],
      [mutate(EDIT, 0, (u) => delete input(u).path), 'path is missing'],
      [mutate(EDIT, 0, (u) => (input(u).replace_all = 'yes')), 'replace_all is not a boolean'],
      [mutate(EDIT, 0, (u) => (input(u).oldStr = 'x'.repeat(256 * 1024 + 1))), 'oldStr or newStr is too long'],
    ];
    for (const [text, why] of cases) {
      const stop = replay(text, SCOPE);
      expect(stop?.outcome.code, why).toBe('unknown_args');
      expect(stop?.outcome.detail, why).toContain(why);
      expect(stop?.outcome.detail, why).not.toContain('findRefund');
    }
  });

  it('refuses a path outside the folder, `..`, an absolute path, and a write outside the service sources', () => {
    for (const path of ['/etc/passwd', '/work/fixer/other/work/x.ts', '../x', 'services/payments/../../x', '~/x', 'a\\b']) {
      const stop = replay(mutate(EDIT, 0, (u) => (input(u).path = path)), SCOPE);
      expect(stop?.outcome.code, path).toBe('path_outside');
      expect(stop?.outcome.detail).toBe('fs_write path outside the folder kind=edit keys=[command,newStr,oldStr,path]');
    }
    expect(code(mutate(EDIT, 0, (u) => (input(u).path = 'package.json')))).toBe('write_outside_scope');
    // The update is judged too: a path swapped there is refused.
    expect(code(`${EDIT.trim().split('\n')[0]}\n${update({ status: 'pending', rawInput: { command: 'strReplace', path: '/etc/passwd', oldStr: 'a', newStr: 'b' } })}\n`)).toBe('path_outside');
  });

  it('refuses toolName shell, a title that names read, a title with a control character, and a title with another kind', () => {
    const shell = replay(mutate(EDIT, 0, (u) => (meta(u).toolName = 'shell')), SCOPE);
    expect(shell?.outcome.code).toBe('foreign_tool');
    expect(shell?.outcome.detail).toBe('toolName=shell kind=edit keys=[command,newStr,oldStr,path]');
    // The name `read` makes it a read: a write-shaped input is not understood as one.
    expect(code(mutate(EDIT, 0, (u) => (meta(u).toolName = 'read')))).toBe('unknown_args');
    expect(code(mutate(EDIT, 0, (u) => (u.title = 'Editing x')))).toBeUndefined();
    const readName = mutate(EDIT, 0, (u) => {
      u.title = 'Editing x';
      meta(u).toolName = 'read';
    });
    expect(replay(readName, SCOPE)?.outcome.code).toBe('unknown_args');
    // With the stable name the title and the kind are decorative: one clean line is all that is asked (task 22).
    expect(code(mutate(EDIT, 0, (u) => (u.title = 'Editing a\nb')))).toBe('foreign_tool');
    for (const edit of [(u: Record<string, unknown>) => (u.title = 'Editing '), (u: Record<string, unknown>) => (u.kind = 'read'), (u: Record<string, unknown>) => delete u.kind, (u: Record<string, unknown>) => (u.title = 'Edits x')]) {
      expect(code(mutate(EDIT, 0, edit))).toBeUndefined();
    }
    // With no name the recorded title and kind decide, as before.
    const noName = (edit: (u: Record<string, unknown>) => void): string =>
      mutate(EDIT, 0, (u) => {
        delete u._meta;
        edit(u);
      });
    expect(code(noName((u) => (u.kind = 'read')))).toBe('foreign_tool');
    expect(code(noName((u) => delete u.kind))).toBe('foreign_tool');
    expect(code(noName((u) => (u.title = 'Edits x')))).toBe('foreign_tool');
  });

  it('keeps one tool for a repeated call id: `title: null` follows it, an update that names another tool does not', () => {
    const first = EDIT.trim().split('\n')[0] as string;
    const input0 = { command: 'strReplace', path: 'services/payments/src/refunds.ts', oldStr: 'a', newStr: 'b' };
    const run = (...lines: string[]) => replay([first, ...lines].join('\n'), SCOPE);
    expect(run(update({ status: 'pending', title: null, rawInput: input0 }), update({ status: 'completed', title: 'Editing refunds.ts', rawInput: input0 }))?.outcome.code).toBeUndefined();
    expect(run(update({ status: 'completed', title: null, rawInput: input0 }))).toBeNull();
    // An update keeps the tool of its id: another title or another name does not turn it into another tool (task 22).
    expect(run(update({ status: 'completed', title: 'Reading refunds.ts:1' }))).toBeNull();
    expect(run(update({ status: 'completed', title: 'Read File' }))).toBeNull();
    expect(run(update({ status: 'completed', title: null, _meta: { kiro: { toolName: 'read' } } }))).toBeNull();
    // Its input is judged again as a write: a read-shaped one is refused.
    expect(run(update({ status: 'pending', title: 'Read File', rawInput: { operations: [{ mode: 'Line', path: 'services/payments/src/a.ts' }] } }))?.outcome.code).toBe('unknown_args');
    // The same id reused for a call that names the other tool.
    const reread = JSON.stringify({ type: 'sessionUpdate', data: { sessionId: 's', update: { sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'Read File', kind: 'read', rawInput: { path: 'services/payments/src/a.ts', offset: null, limit: null } } } });
    expect(run(reread)?.outcome.code).toBe('foreign_tool');
    // A completed update that never saw the input is refused.
    const bare = [0, 1].reduce((t, i) => mutate(t, i, (u) => delete u.rawInput), EDIT);
    expect(code(bare)).toBe('unjudged_input');
  });
});

// Feature: fix-proposal-flow, Property 6 (recorded shapes)
describe('Property 6b: recorded titles with in-scope paths never stop; one foreign title stops at that call', () => {
  const service = 'payments';
  const file = fc.stringMatching(/^[a-z]{1,8}\.ts$/).map((f) => `services/${service}/src/${f}`);
  const call = fc.record({ title: fc.constantFrom(...RECORDED_TITLES, 'fs_read', 'fs_write'), path: file, text: fc.string({ maxLength: 20 }) });
  const input = (title: string, path: string, text: string): Record<string, unknown> => {
    if (title === 'Read File') return { path, offset: null, limit: null };
    if (title === 'Replace in File') return { path, oldStr: text, newStr: `${text}!` };
    if (title === 'Write File') return { path, text };
    if (title === 'fs_read') return { operations: [{ mode: 'Line', path }] };
    return { command: 'create', path, file_text: text };
  };
  const line = (u: Record<string, unknown>): string => JSON.stringify({ type: 'sessionUpdate', data: { sessionId: 's', update: u } });
  /** A call as the recordings show it: the call, an update with no title, an update with the same title. */
  const callLines = (id: string, title: string, rawInput: Record<string, unknown>): string[] => [
    line({ sessionUpdate: 'tool_call', toolCallId: id, title, kind: title === 'Read File' ? 'read' : 'edit', rawInput }),
    line({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'pending', rawInput }),
    line({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', title, rawInput }),
  ];
  const foreign = fc.constantFrom('Run Command', 'execute_bash', 'Shell', 'Fetch URL', 'Delete File', 'Read file', '', 'toString');

  it('never stops a sequence of accepted calls', () => {
    fc.assert(
      fc.property(fc.array(call, { minLength: 1, maxLength: 12 }), (calls) => {
        const text = calls.flatMap((c, i) => callLines(`id-${i}`, c.title, input(c.title, c.path, c.text))).join('\n');
        expect(replay(text, `services/${service}/src/`)).toBeNull();
      }),
      { numRuns: 200 },
    );
  });

  it('stops exactly at an injected foreign call', () => {
    fc.assert(
      fc.property(fc.array(call, { minLength: 1, maxLength: 10 }), fc.nat(), foreign, (calls, at, title) => {
        const k = at % (calls.length + 1);
        const lines = calls.flatMap((c, i) => callLines(`id-${i}`, c.title, input(c.title, c.path, c.text)));
        lines.splice(k * 3, 0, line({ sessionUpdate: 'tool_call', toolCallId: 'id-foreign', title, kind: 'execute', rawInput: { command: 'ls' } }));
        const stop = replay(lines.join('\n'), `services/${service}/src/`);
        expect(stop?.at).toBe(k * 3);
        expect(stop?.outcome.code).toBe('foreign_tool');
      }),
      { numRuns: 200 },
    );
  });
});

// Feature: fix-proposal-flow, Property 6 (batch read shape, task 19)
describe('Property 6c: a batch read passes iff its toolName, title, entries and paths are understood', () => {
  const scope = 'services/payments/src/';
  const path = fc.stringMatching(/^[a-z]{1,8}\.ts$/).map((f) => `${scope}${f}`);
  const outsidePath = fc.constantFrom('/etc/passwd', '../x', 'services/payments/../../x', '~/x', '/work/fixer/other/work/x.ts');
  const mode = fc.constantFrom('Line', 'Directory', 'Search');
  const read = (toolName: string | undefined, operations: unknown[], extra: Record<string, unknown> = {}): string =>
    JSON.stringify({
      type: 'sessionUpdate',
      data: {
        sessionId: 's',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'c1',
          title: 'Reading a.ts:1',
          kind: 'read',
          rawInput: { operations, ...extra },
          ...(toolName === undefined ? {} : { _meta: { kiro: { toolName } } }),
        },
      },
    });

  it('passes 1 to 8 inside entries, with or without the toolName `read`', () => {
    fc.assert(
      fc.property(fc.array(fc.record({ mode, path }), { minLength: 1, maxLength: 8 }), fc.constantFrom('read', undefined), (ops, name) => {
        expect(replay(read(name, ops), scope)).toBeNull();
      }),
      { numRuns: 200 },
    );
  });

  it('stops for any outside path in any entry, any count above 8, any other toolName, and any unknown key', () => {
    fc.assert(
      fc.property(fc.array(fc.record({ mode, path }), { minLength: 1, maxLength: 7 }), fc.nat(), outsidePath, fc.stringMatching(/^[a-z]{2,8}$/), (ops, at, bad, other) => {
        const k = at % (ops.length + 1);
        const withBad = [...ops.slice(0, k), { mode: 'Line', path: bad }, ...ops.slice(k)];
        expect(replay(read('read', withBad), scope)?.outcome.code).toBe('path_outside');
        const nine = Array.from({ length: 9 + (at % 4) }, () => ops[0]);
        expect(replay(read('read', nine), scope)?.outcome.code).toBe('unknown_args');
        if (other !== 'read' && other !== 'write') expect(replay(read(other, ops), scope)?.outcome.code).toBe('foreign_tool');
        expect(replay(read('read', ops, { [`k_${other}`]: 1 }), scope)?.outcome.code).toBe('unknown_args');
        expect(replay(read('read', [{ ...ops[0], [`k_${other}`]: 1 }]), scope)?.outcome.code).toBe('unknown_args');
      }),
      { numRuns: 200 },
    );
  });
});

// Feature: fix-proposal-flow, Property 6 (dynamic edit shape, task 20)
describe('Property 6d: an `Editing` call passes iff its command, keys, strings and path are understood', () => {
  const scope = 'services/payments/src/';
  const path = fc.stringMatching(/^[a-z]{1,8}\.ts$/).map((f) => `${scope}${f}`);
  const outsidePath = fc.constantFrom('/etc/passwd', '../x', 'services/payments/../../x', '~/x', 'package.json', '/work/fixer/other/work/x.ts');
  const text = fc.string({ maxLength: 30 });
  const edit = (rawInput: Record<string, unknown>, toolName: string | undefined = 'write', title = 'Editing a.ts'): string =>
    JSON.stringify({
      type: 'sessionUpdate',
      data: {
        sessionId: 's',
        update: { sessionUpdate: 'tool_call', toolCallId: 'c1', title, kind: 'edit', rawInput, ...(toolName === undefined ? {} : { _meta: { kiro: { toolName } } }) },
      },
    });

  it('passes strReplace with an inside path, strings, and an optional replace_all', () => {
    fc.assert(
      fc.property(path, text, text, fc.constantFrom(undefined, true, false), fc.constantFrom('write', undefined), (p, oldStr, newStr, all, name) => {
        const input = { command: 'strReplace', path: p, oldStr, newStr, ...(all === undefined ? {} : { replace_all: all }) };
        expect(replay(edit(input, name), scope)).toBeNull();
      }),
      { numRuns: 200 },
    );
  });

  it('stops for any other command, any unknown key, any outside path, a non-string and any other toolName', () => {
    fc.assert(
      fc.property(path, text, outsidePath, fc.stringMatching(/^[a-z_]{2,10}$/), (p, s, bad, other) => {
        const ok = { command: 'strReplace', path: p, oldStr: s, newStr: s };
        if (other !== 'strReplace') expect(replay(edit({ ...ok, command: other }), scope)?.outcome.code).toBe('unknown_args');
        expect(replay(edit({ path: p, oldStr: s, newStr: s }), scope)?.outcome.code).toBe('unknown_args');
        if (!['command', 'path', 'oldStr', 'newStr', 'replace_all'].includes(other)) expect(replay(edit({ ...ok, [other]: 1 }), scope)?.outcome.code).toBe('unknown_args');
        expect(replay(edit({ ...ok, path: bad }), scope)?.outcome.code).toBe(bad === 'package.json' ? 'write_outside_scope' : 'path_outside');
        expect(replay(edit({ ...ok, oldStr: 1 }), scope)?.outcome.code).toBe('unknown_args');
        if (other !== 'read' && other !== 'write') expect(replay(edit(ok, other), scope)?.outcome.code).toBe('foreign_tool');
        expect(replay(edit(ok, 'read'), scope)?.outcome.code).toBe('unknown_args');
      }),
      { numRuns: 200 },
    );
  });
});
