import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { StreamParser, type HuntStreamEvent } from '../hunts/stream-parser.js';
import { FixerGuard, IMAGE_READ, type GuardOutcome } from './fixer-guard.js';

/**
 * The guard against the tool schema built into kiro-cli 3.3.0 (task 22): `write` with `create`, `strReplace` and
 * `insert`; `read` with `Line` and `Directory` (and `Image`, refused), identified by `_meta.kiro.toolName`. The
 * fixtures `apps/api/test/fixtures/fixer-streams/*` listed in `scripts/fixer-stream-shapes.mjs` as schema-derived are
 * NOT recordings. No kiro-cli runs here.
 */
const FOLDER = '/work/fixer/cmproposal0000000000000001/work';
const SCOPE = 'services/payments/src/';
const FILE = `${SCOPE}refunds.ts`;
const fixture = (name: string): string => readFileSync(new URL(`../../test/fixtures/fixer-streams/${name}.stream.jsonl`, import.meta.url), 'utf8');
const events = (text: string): HuntStreamEvent[] => {
  const p = new StreamParser();
  return [...p.push(text), ...p.end()].filter((e) => e.type === 'tool_call' || e.type === 'tool_call_update');
};
/** The first stop of a replay (and where), or null. */
function replay(text: string): { at: number; outcome: Extract<GuardOutcome, { kind: 'stop' }> } | null {
  const guard = new FixerGuard(FOLDER, { writeScope: SCOPE });
  const evs = events(text);
  for (let i = 0; i < evs.length; i++) {
    const out = guard.judge(evs[i] as HuntStreamEvent);
    if (out.kind === 'stop') return { at: i, outcome: out };
  }
  return null;
}
const call = (rawInput: unknown, o: { toolName?: string | null; title?: string; kind?: string } = {}): HuntStreamEvent => ({
  type: 'tool_call',
  id: 'c1',
  title: o.title ?? 'Editing refunds.ts',
  kind: o.kind ?? 'edit',
  rawInput,
  ...(o.toolName === null ? {} : { toolName: o.toolName ?? 'write' }),
});
const judge = (ev: HuntStreamEvent): GuardOutcome => new FixerGuard(FOLDER, { writeScope: SCOPE }).judge(ev);
const readCall = (operations: unknown[], extra: Record<string, unknown> = {}): HuntStreamEvent => call({ operations, ...extra }, { toolName: 'read', title: 'Reading src:1', kind: 'read' });

describe('the schema-derived fixtures (not recordings)', () => {
  const EDITING = ['write-create', 'write-insert-line', 'write-insert-append', 'str-replace-all', 'read-directory', 'update-new-title', 'update-no-meta', 'edit-command'];
  it('every fixture that edits refunds.ts passes the guard whole, and counts one write', () => {
    for (const name of EDITING) {
      const text = fixture(name);
      expect(replay(text), name).toBeNull();
      const guard = new FixerGuard(FOLDER, { writeScope: SCOPE });
      for (const ev of events(text)) guard.judge(ev);
      expect(guard.writes, name).toBe(1);
      expect(text, name).toContain('refunds.ts');
    }
  });

  it('refuses the Image fixture with the reason image_read, before any other check of its keys', () => {
    const stop = replay(fixture('read-image'));
    expect(stop?.outcome.code).toBe('unknown_args');
    expect(stop?.outcome.detail).toBe(`fs_read arguments not understood: ${IMAGE_READ} kind=read keys=[operations]`);
  });

  it('keeps the tool of an update whose title changed or whose `_meta` is missing, and judges its input again', () => {
    expect(replay(fixture('update-new-title'))).toBeNull();
    expect(replay(fixture('update-no-meta'))).toBeNull();
    // The same update with an input that escapes is refused.
    const text = fixture('update-no-meta').trim().split('\n');
    const update = JSON.parse(text[1] as string) as { data: { update: Record<string, unknown> } };
    update.data.update.rawInput = { command: 'strReplace', path: '/etc/passwd', oldStr: 'a', newStr: 'b' };
    expect(replay([text[0], JSON.stringify(update), text[2]].join('\n'))?.outcome.code).toBe('path_outside');
  });
});

describe('the write schema: create, strReplace, insert (and the older snake_case family)', () => {
  const ok: Array<[string, Record<string, unknown>]> = [
    ['create', { command: 'create', path: FILE, content: 'export const a = 1;\n' }],
    ['create with a summary', { command: 'create', path: FILE, content: 'x', summary: 'why' }],
    ['create of a new file in scope', { command: 'create', path: `${SCOPE}new/deeper.ts`, content: 'x' }],
    ['strReplace', { command: 'strReplace', path: FILE, oldStr: 'a', newStr: 'b' }],
    ['strReplace replaceAll true', { command: 'strReplace', path: FILE, oldStr: 'a', newStr: 'b', replaceAll: true }],
    ['strReplace replaceAll false', { command: 'strReplace', path: FILE, oldStr: 'a', newStr: 'b', replaceAll: false }],
    ['strReplace replace_all (recorded spelling)', { command: 'strReplace', path: FILE, oldStr: 'a', newStr: 'b', replace_all: false }],
    ['insert with insertLine', { command: 'insert', path: FILE, content: 'x', insertLine: 8 }],
    ['insert with insertLine 0', { command: 'insert', path: FILE, content: 'x', insertLine: 0 }],
    ['insert without insertLine', { command: 'insert', path: FILE, content: 'x' }],
    ['legacy create', { command: 'create', path: FILE, file_text: 'x' }],
    ['legacy str_replace', { command: 'str_replace', path: FILE, old_str: 'a', new_str: 'b', summary: 's' }],
    ['legacy insert', { command: 'insert', path: FILE, insert_line: 2, new_str: 'x' }],
    ['legacy append', { command: 'append', path: FILE, new_str: 'x' }],
  ];
  it('accepts each shape, with the name `write`, with no name and the title Write File, and counts one write', () => {
    for (const [label, input] of ok) {
      expect(judge(call(input)), label).toEqual({ kind: 'step' });
      // The name is the identity; with only the old title the same arguments also pass (a title that says edit).
      expect(judge(call(input, { toolName: null, title: 'Editing refunds.ts' })), `${label} (title only)`).toEqual({ kind: 'step' });
      const guard = new FixerGuard(FOLDER, { writeScope: SCOPE });
      guard.judge(call(input));
      expect(guard.writes, label).toBe(1);
    }
  });

  /** One refused change of a good input, per command, with the stop code it must give. */
  const refused: Array<[string, Record<string, unknown>[], string]> = [
    ['an unknown key', [{ command: 'create', path: FILE, content: 'x', extra: 1 }, { command: 'strReplace', path: FILE, oldStr: 'a', newStr: 'b', extra: 1 }, { command: 'insert', path: FILE, content: 'x', extra: 1 }], 'unknown_args'],
    ['the key of another command', [{ command: 'create', path: FILE, content: 'x', insertLine: 1 }, { command: 'strReplace', path: FILE, oldStr: 'a', newStr: 'b', content: 'x' }, { command: 'insert', path: FILE, content: 'x', replaceAll: true }], 'unknown_args'],
    ['both families at once', [{ command: 'create', path: FILE, content: 'x', file_text: 'x' }, { command: 'insert', path: FILE, content: 'x', insert_line: 1 }], 'unknown_args'],
    ['a missing required key', [{ command: 'create', path: FILE }, { command: 'strReplace', path: FILE, oldStr: 'a' }, { command: 'strReplace', path: FILE, newStr: 'b' }, { command: 'insert', path: FILE }, { command: 'create', content: 'x' }, { path: FILE, content: 'x' }], 'unknown_args'],
    ['a wrong type', [{ command: 'create', path: FILE, content: 5 }, { command: 'strReplace', path: FILE, oldStr: 'a', newStr: ['b'] }, { command: 'strReplace', path: FILE, oldStr: 'a', newStr: 'b', replaceAll: 'yes' }, { command: 'insert', path: FILE, content: 'x', insertLine: '3' }, { command: 'insert', path: FILE, content: 'x', insertLine: 1.5 }, { command: 'insert', path: FILE, content: 'x', insertLine: -1 }, { command: 'create', path: 7, content: 'x' }, { command: 'create', path: FILE, content: 'x', summary: 3 }], 'unknown_args'],
    ['a text over the file size cap', [{ command: 'create', path: FILE, content: 'x'.repeat(256 * 1024 + 1) }, { command: 'insert', path: FILE, content: 'x'.repeat(256 * 1024 + 1) }, { command: 'strReplace', path: FILE, oldStr: 'x'.repeat(256 * 1024 + 1), newStr: 'b' }], 'unknown_args'],
    ['another command', [{ command: 'delete', path: FILE }, { command: 'rename', path: FILE, content: 'x' }, { command: 'view', path: FILE }, { command: 7, path: FILE }], 'unknown_args'],
    ['a path with `..`', [{ command: 'create', path: `${SCOPE}../x.ts`, content: 'x' }, { command: 'strReplace', path: '../x.ts', oldStr: 'a', newStr: 'b' }, { command: 'insert', path: 'services/payments/../../x', content: 'x' }], 'path_outside'],
    ['an absolute path', [{ command: 'create', path: '/etc/passwd', content: 'x' }, { command: 'strReplace', path: '/etc/passwd', oldStr: 'a', newStr: 'b' }, { command: 'insert', path: '/work/fixer/other/work/x.ts', content: 'x' }], 'path_outside'],
    ['a path outside the service sources', [{ command: 'create', path: 'package.json', content: 'x' }, { command: 'create', path: 'services/payments/test/a.test.js', content: 'x' }, { command: 'strReplace', path: 'services/orders/src/a.ts', oldStr: 'a', newStr: 'b' }, { command: 'insert', path: '.kiro/agents/exorcist-fixer.json', content: 'x' }], 'write_outside_scope'],
  ];
  it('refuses, for each command, an unknown key, a missing key, a wrong type, a path outside, `..`, an absolute path and any other command', () => {
    for (const [label, inputs, code] of refused) {
      for (const input of inputs) {
        const out = judge(call(input));
        expect(out.kind, `${label}: ${JSON.stringify(input).slice(0, 80)}`).toBe('stop');
        expect(out.kind === 'stop' ? out.code : '', `${label}: ${JSON.stringify(input).slice(0, 80)}`).toBe(code);
        // No value of the arguments reaches the detail.
        expect(out.kind === 'stop' ? out.detail : '').not.toContain('xxxx');
      }
    }
  });

  it('refuses a write with no `command` when the call has the stable name or an Editing title', () => {
    const out = judge(call({ path: FILE, text: 'x' }));
    expect(out).toMatchObject({ kind: 'stop', code: 'unknown_args' });
    expect(out.kind === 'stop' ? out.detail : '').toContain('command is missing');
    // The recorded shapes of the older titles still need no command.
    expect(judge(call({ path: FILE, text: 'x' }, { toolName: null, title: 'Write File' }))).toEqual({ kind: 'step' });
  });

  it('names the refused command, cleaned, and the tool name, in the detail, and never a value', () => {
    const cmd = judge(call({ command: 'rm -rf /', path: FILE, content: 'SECRET-TEXT' }));
    expect(cmd.kind === 'stop' ? cmd.detail : '').toContain('unknown command rm?-rf??');
    expect(cmd.kind === 'stop' ? cmd.detail : '').not.toContain('SECRET-TEXT');
    const name = judge(call({ command: 'create', path: FILE, content: 'x' }, { toolName: 'shell' }));
    expect(name).toMatchObject({ kind: 'stop', code: 'foreign_tool' });
    expect(name.kind === 'stop' ? name.detail : '').toContain('toolName=shell');
    const key = judge(call({ command: 'create', path: FILE, content: 'x', 'weird key!': 1 }));
    expect(key.kind === 'stop' ? key.detail : '').toContain('unknown key weird?key?');
  });

  it('judges the input of an update again, whatever its title or `_meta`', () => {
    const guard = new FixerGuard(FOLDER, { writeScope: SCOPE });
    expect(guard.judge(call({ command: 'insert', path: FILE, content: 'x', insertLine: 1 }))).toEqual({ kind: 'step' });
    const upd = (rawInput: unknown, title: string | null = null): HuntStreamEvent => ({ type: 'tool_call_update', id: 'c1', status: 'pending', title, rawInput });
    expect(guard.judge(upd({ command: 'insert', path: FILE, content: 'y' }, 'Whatever title'))).toEqual({ kind: 'pass' });
    expect(guard.judge(upd({ command: 'delete', path: FILE }))).toMatchObject({ kind: 'stop', code: 'unknown_args' });
    expect(guard.judge(upd({ command: 'insert', path: 'package.json', content: 'y' }))).toMatchObject({ kind: 'stop', code: 'write_outside_scope' });
    expect(guard.judge(upd({ command: 'insert', path: '../x', content: 'y' }))).toMatchObject({ kind: 'stop', code: 'path_outside' });
  });
});

describe('the read schema: Line and Directory operations; Image is refused', () => {
  it('accepts Line with offset and limit, Directory with depth 0 to 5 and exclude_patterns, up to 8 operations', () => {
    const good: unknown[][] = [
      [{ mode: 'Line', path: FILE }],
      [{ mode: 'Line', path: FILE, offset: 1, limit: 40 }],
      [{ mode: 'Line', path: FILE, offset: null, limit: null }],
      [{ mode: 'Directory', path: 'services/payments/src' }],
      [{ mode: 'Directory', path: '.', depth: 0 }],
      [{ mode: 'Directory', path: 'services', depth: 5, exclude_patterns: ['node_modules', '*.log'] }],
      [{ mode: 'Directory', path: 'services', exclude_patterns: Array.from({ length: 20 }, () => 'x'.repeat(100)) }],
      Array.from({ length: 8 }, () => ({ mode: 'Line', path: FILE })),
      // The older `Search` operation stays.
      [{ mode: 'Search', path: 'services', pattern: 'refund', context_lines: 2 }],
    ];
    for (const ops of good) {
      expect(judge(readCall(ops)), JSON.stringify(ops).slice(0, 80)).toEqual({ kind: 'step' });
      const guard = new FixerGuard(FOLDER, { writeScope: SCOPE });
      guard.judge(readCall(ops));
      expect(guard.writes).toBe(0);
    }
  });

  it('refuses Image with the reason image_read, however the other keys look', () => {
    for (const ops of [[{ mode: 'Image', image_paths: ['a.png'] }], [{ mode: 'Image', path: FILE }], [{ mode: 'Line', path: FILE }, { mode: 'Image' }]]) {
      const out = judge(readCall(ops));
      expect(out).toMatchObject({ kind: 'stop', code: 'unknown_args' });
      expect(out.kind === 'stop' ? out.detail : '').toContain(IMAGE_READ);
    }
  });

  it('refuses a path outside, `..`, an absolute path, an unknown key, a missing mode or path, a wrong type, a depth over 5, and bad patterns', () => {
    const bad: Array<[unknown[], string]> = [
      [[{ mode: 'Line', path: '/etc/passwd' }], 'path_outside'],
      [[{ mode: 'Directory', path: '../x' }], 'path_outside'],
      [[{ mode: 'Directory', path: 'services/payments/../../..' }], 'path_outside'],
      [[{ mode: 'Line', path: FILE, extra: 1 }], 'unknown_args'],
      [[{ mode: 'Line', path: FILE, depth: 1 }], 'unknown_args'],
      [[{ mode: 'Directory', path: FILE, offset: 1 }], 'unknown_args'],
      [[{ mode: 'Line' }], 'unknown_args'],
      [[{ path: FILE }], 'unknown_args'],
      [[{ mode: 'Exec', path: FILE }], 'unknown_args'],
      [[{ mode: 'Line', path: 5 }], 'unknown_args'],
      [[{ mode: 'Line', path: FILE, offset: '1' }], 'unknown_args'],
      [[{ mode: 'Line', path: FILE, limit: 1.5 }], 'unknown_args'],
      [[{ mode: 'Directory', path: '.', depth: 6 }], 'unknown_args'],
      [[{ mode: 'Directory', path: '.', depth: -1 }], 'unknown_args'],
      [[{ mode: 'Directory', path: '.', depth: '2' }], 'unknown_args'],
      [[{ mode: 'Directory', path: '.', exclude_patterns: 'node_modules' }], 'unknown_args'],
      [[{ mode: 'Directory', path: '.', exclude_patterns: [5] }], 'unknown_args'],
      [[{ mode: 'Directory', path: '.', exclude_patterns: ['x'.repeat(101)] }], 'unknown_args'],
      [[{ mode: 'Directory', path: '.', exclude_patterns: Array.from({ length: 21 }, () => 'x') }], 'unknown_args'],
      [Array.from({ length: 9 }, () => ({ mode: 'Line', path: FILE })), 'unknown_args'],
      [[], 'unknown_args'],
    ];
    for (const [ops, code] of bad) {
      const out = judge(readCall(ops));
      expect(out.kind === 'stop' ? out.code : out.kind, JSON.stringify(ops).slice(0, 90)).toBe(code);
    }
  });

  it('refuses `toolName: "shell"` and any name other than read and write, on a call that looks fine otherwise', () => {
    for (const toolName of ['shell', 'execute_bash', 'Read', 'READ', 'fs_read', '', 'read ']) {
      const out = judge(call({ command: 'create', path: FILE, content: 'x' }, { toolName }));
      expect(out, toolName).toMatchObject({ kind: 'stop', code: 'foreign_tool' });
    }
    expect(judge(call({ command: 'create', path: FILE, content: 'x' }, { toolName: 'shell', title: 'Editing refunds.ts' })).kind).toBe('stop');
  });
});

// Feature: fix-proposal-flow, Property 6e: every accepted shape of the schema passes; one mutation fails
describe('Property 6e: generated valid arguments of every accepted shape pass, one mutated key or an outside path stops', () => {
  const name = fc.stringMatching(/^[a-z]{1,8}$/);
  const path = name.map((n) => `${SCOPE}${n}.ts`);
  const text = fc.string({ maxLength: 40 });
  const bool = fc.boolean();
  const nat = fc.nat({ max: 500 });
  const summary = fc.option(text, { nil: undefined });
  const withSummary = (o: Record<string, unknown>, s: string | undefined): Record<string, unknown> => (s === undefined ? o : { ...o, summary: s });
  type Shape = { tool: 'read' | 'write'; input: Record<string, unknown> | unknown[] };
  const shape: fc.Arbitrary<Shape> = fc.oneof(
    fc.tuple(path, text, summary).map(([p, c, s]): Shape => ({ tool: 'write', input: withSummary({ command: 'create', path: p, content: c }, s) })),
    fc.tuple(path, text, text, fc.option(bool, { nil: undefined }), summary).map(
      ([p, o, n, all, s]): Shape => ({ tool: 'write', input: withSummary({ command: 'strReplace', path: p, oldStr: o, newStr: n, ...(all === undefined ? {} : { replaceAll: all }) }, s) }),
    ),
    fc.tuple(path, text, fc.option(nat, { nil: undefined }), summary).map(
      ([p, c, line, s]): Shape => ({ tool: 'write', input: withSummary({ command: 'insert', path: p, content: c, ...(line === undefined ? {} : { insertLine: line }) }, s) }),
    ),
    fc.tuple(path, text).map(([p, t]): Shape => ({ tool: 'write', input: { command: 'create', path: p, file_text: t } })),
    fc.tuple(path, text, text).map(([p, o, n]): Shape => ({ tool: 'write', input: { command: 'str_replace', path: p, old_str: o, new_str: n } })),
    fc.tuple(path, fc.option(nat, { nil: undefined }), fc.option(nat, { nil: undefined })).map(
      ([p, off, lim]): Shape => ({ tool: 'read', input: [{ mode: 'Line', path: p, ...(off === undefined ? {} : { offset: off }), ...(lim === undefined ? {} : { limit: lim }) }] }),
    ),
    fc.tuple(path, fc.integer({ min: 0, max: 5 }), fc.array(fc.stringMatching(/^[a-z*.]{1,20}$/), { maxLength: 20 })).map(
      ([p, depth, ex]): Shape => ({ tool: 'read', input: [{ mode: 'Directory', path: p, depth, exclude_patterns: ex }] }),
    ),
  );
  const ev = (s: Shape, over?: (input: Record<string, unknown>) => void): HuntStreamEvent => {
    if (s.tool === 'read') {
      const ops = (s.input as Record<string, unknown>[]).map((o) => ({ ...o }));
      if (over !== undefined) over(ops[0] as Record<string, unknown>);
      return readCall(ops);
    }
    const input = { ...(s.input as Record<string, unknown>) };
    if (over !== undefined) over(input);
    return call(input);
  };
  const outside = fc.constantFrom('/etc/passwd', '../x', 'services/payments/../../x', '~/x', '/work/fixer/other/work/x.ts', 'a\\b');

  it('passes every generated valid shape, with the stable name', () => {
    fc.assert(
      fc.property(shape, (s) => {
        expect(judge(ev(s))).toEqual({ kind: 'step' });
      }),
      { numRuns: 300 },
    );
  });

  it('stops for one unknown key added, and for a path outside the folder in the one path slot', () => {
    fc.assert(
      fc.property(shape, name, outside, (s, key, bad) => {
        expect(judge(ev(s, (o) => (o[`k_${key}`] = 1)))).toMatchObject({ kind: 'stop', code: 'unknown_args' });
        expect(judge(ev(s, (o) => (o.path = bad)))).toMatchObject({ kind: 'stop', code: 'path_outside' });
        // A write outside `services/<service>/src/` is its own stop (and a read has no such scope).
        const out = judge(ev(s, (o) => (o.path = 'package.json')));
        expect(out.kind === 'stop' ? out.code : 'pass').toBe(s.tool === 'write' ? 'write_outside_scope' : 'pass');
      }),
      { numRuns: 300 },
    );
  });

  it('stops for a required key taken away, and for any other tool name', () => {
    fc.assert(
      fc.property(shape, fc.stringMatching(/^[a-z_]{2,10}$/), (s, other) => {
        expect(judge(ev(s, (o) => delete o.path))).toMatchObject({ kind: 'stop', code: 'unknown_args' });
        if (s.tool === 'write') expect(judge(ev(s, (o) => delete o.command))).toMatchObject({ kind: 'stop', code: 'unknown_args' });
        const event = ev(s);
        if (other !== 'read' && other !== 'write') expect(judge({ ...event, toolName: other } as HuntStreamEvent)).toMatchObject({ kind: 'stop', code: 'foreign_tool' });
      }),
      { numRuns: 300 },
    );
  });
});
