import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { HuntStreamEvent } from '../hunts/stream-parser.js';
import { FixerGuard, checkFixerCall, describeFixerStop, fileToolArgsProblem, isInside, isSameFixerCall, pathsOf } from './fixer-guard.js';

const FOLDER = '/var/fix/fixer/cmprop0000000000000000001/work';
const call = (id: string, title: string, rawInput: unknown): HuntStreamEvent => ({ type: 'tool_call', id, title, rawInput });
const update = (id: string, title: string | null, rawInput?: unknown): HuntStreamEvent => ({ type: 'tool_call_update', id, status: 'in_progress', title, rawInput });

describe('the fixer allow-list, with the shapes of kiro-cli 3.3.0', () => {
  it('refuses a title that is an inherited property name of an object', () => {
    for (const title of ['toString', '__proto__', 'constructor', 'hasOwnProperty', 'valueOf']) {
      expect(checkFixerCall(title, { path: 'services/payments/src/charge.js' }), title).toEqual({ kind: 'foreign', title });
      const g = new FixerGuard(FOLDER);
      expect(g.judge(call('c1', title, { path: 'a' })).kind, title).toBe('stop');
      // A known id followed by an inherited name is a different tool, not the same call.
      const h = new FixerGuard(FOLDER);
      h.judge(call('c2', 'fs_read', { path: 'a' }));
      expect(h.judge(update('c2', title, { path: 'a' })).kind, title).toBe('stop');
    }
  });

  it('accepts a direct file tool call, its update with title null and its completed update with the same title', () => {
    const g = new FixerGuard(FOLDER);
    expect(g.judge(call('c1', 'fs_read', { path: 'services/payments/src/charge.js' }))).toEqual({ kind: 'step' });
    expect(g.judge(update('c1', null))).toEqual({ kind: 'pass' });
    expect(g.judge(update('c1', 'fs_read', { path: 'services/payments/src/charge.js' }))).toEqual({ kind: 'pass' });
    expect(g.judge(call('c2', 'fs_write', { command: 'create', path: 'services/payments/src/charge.js', file_text: 'x' }))).toEqual({ kind: 'step' });
    expect(g.judge(update('c2', null))).toEqual({ kind: 'pass' });
    expect(g.judge(update('c2', 'fs_write'))).toEqual({ kind: 'pass' });
    expect(g.count).toBe(2);
  });

  it('accepts the Tool Call wrapper with tool_id and arguments, and its updates', () => {
    const g = new FixerGuard(FOLDER);
    const wrapped = { tool_id: 'tool::builtin::fs_write', arguments: { command: 'create', path: 'services/payments/src/a.js', file_text: 'x' } };
    expect(g.judge(call('w1', 'Tool Call', wrapped))).toEqual({ kind: 'step' });
    expect(g.judge(update('w1', null))).toEqual({ kind: 'pass' });
    expect(g.judge(update('w1', 'Tool Call', wrapped))).toEqual({ kind: 'pass' });
    // The same id again as a call: the same tool passes, another tool is refused.
    expect(g.judge(call('w1', 'Tool Call', wrapped))).toEqual({ kind: 'pass' });
    expect(g.judge(call('w1', 'Tool Call', { tool_id: 'tool::builtin::execute_bash', arguments: { command: 'ls' } })).kind).toBe('stop');
    expect(g.count).toBe(1);
    // A wrapper for a shell, for an MCP tool, with extra keys or with arguments that are not an object.
    const h = new FixerGuard(FOLDER);
    for (const input of [
      { tool_id: 'tool::builtin::execute_bash', arguments: {} },
      { tool_id: 'tool::exorcist::query_metrics', arguments: {} },
      { tool_id: 'tool::builtin::fs_read', arguments: {}, command: 'ls' },
      { tool_id: 'tool::builtin::fs_read', arguments: 'x' },
      { tool_id: 'fs_read' },
      'tool::builtin::fs_read',
    ]) expect(h.judge(call(`x${JSON.stringify(input).length}`, 'Tool Call', input)).kind, JSON.stringify(input)).toBe('stop');
  });

  it('accepts a Tool Load of the two file tools only', () => {
    const g = new FixerGuard(FOLDER);
    expect(g.judge(call('l1', 'Tool Load', { id: 'tool::builtin::fs_read' })).kind).toBe('step');
    expect(g.judge(call('l2', 'Tool Load', { tool_ids: ['fs_read', 'tool::builtin::fs_write'] })).kind).toBe('step');
    expect(g.judge(update('l1', 'Tool Load')).kind).toBe('pass');
    for (const input of [{ id: 'tool::builtin::execute_bash' }, { tool_ids: ['fs_read', 'execute_bash'] }, {}, null, { id: 7 }]) {
      expect(g.judge(call(`b${JSON.stringify(input)?.length}`, 'Tool Load', input)).kind, JSON.stringify(input)).toBe('stop');
    }
  });

  it('refuses a repeated call id that names another tool, as a call or as an update', () => {
    const g = new FixerGuard(FOLDER);
    g.judge(call('c1', 'fs_read', { path: 'services/payments/src/charge.js' }));
    expect(g.judge(call('c1', 'fs_write', { path: 'services/payments/src/charge.js' })).kind).toBe('stop');
    expect(g.judge(update('c1', 'execute_bash', { command: 'ls' })).kind).toBe('stop');
    expect(g.judge(update('c1', 'Tool Call', { tool_id: 'tool::builtin::fs_write', arguments: {} })).kind).toBe('stop');
    expect(g.judge(update('c1', 'fs_read', { path: '../x' })).kind).toBe('stop');
    expect(g.judge(update('c1', 'fs_read', { path: 'services/payments/src/other.js' })).kind).toBe('pass');
  });

  it('refuses an update with no title for a call id it never saw, and judges a titled one as a new call that counts', () => {
    // 13.7: `title: null` names nothing, so an unknown id with it is refused, never passed through.
    for (const input of [undefined, null, {}, { path: 'services/payments/src/charge.js' }, { path: '/etc/hosts' }]) {
      expect(new FixerGuard(FOLDER).judge(update('zz', null, input)), JSON.stringify(input)).toMatchObject({ kind: 'stop', detail: 'update of an unknown call' });
    }
    const g = new FixerGuard(FOLDER);
    expect(g.judge(update('zz', 'fs_read', { operations: [{ mode: 'Line', path: 'services/payments/src/charge.js' }] })).kind).toBe('step');
    expect(g.count).toBe(1);
    // Its later updates are those of an accepted call.
    expect(g.judge(update('zz', null)).kind).toBe('pass');
    expect(g.judge(update('yy', 'execute_bash', { command: 'ls' })).kind).toBe('stop');
    expect(g.count).toBe(1);
  });

  it('reads the kiro-cli 3.3.0 argument shapes: the wrapper, fs_read operations (with Image mode) and fs_write commands', () => {
    const ok = [
      ['fs_read', { operations: [{ mode: 'Line', path: 'services/payments/src/charge.js', start_line: 1, end_line: 20 }] }],
      ['fs_read', { operations: [{ mode: 'Directory', path: 'services/payments', depth: 2 }, { mode: 'Search', path: 'services', pattern: 'charge', context_lines: 2 }], summary: 'look' }],
      ['fs_read', { operations: [{ mode: 'Image', image_paths: ['services/payments/a.png', `${FOLDER}/b.png`] }] }],
      ['fs_read', { mode: 'Line', path: 'services/payments/src/charge.js' }],
      ['fs_write', { command: 'str_replace', path: 'services/payments/src/charge.js', old_str: 'a', new_str: 'b', summary: 'fix' }],
      ['fs_write', { command: 'insert', path: 'services/payments/src/charge.js', insert_line: 3, new_str: 'x' }],
      ['fs_write', { command: 'append', path: 'services/payments/src/charge.js', new_str: 'x' }],
    ] as const;
    for (const [tool, args] of ok) {
      expect(new FixerGuard(FOLDER).judge(call('a', tool, args)).kind, JSON.stringify(args)).toBe('step');
      expect(new FixerGuard(FOLDER).judge(call('b', 'Tool Call', { tool_id: `tool::builtin::${tool}`, arguments: args })).kind, JSON.stringify(args)).toBe('step');
      expect(fileToolArgsProblem(tool, args)).toBeNull();
    }
  });

  it('stops the run (agent_failed) for any path argument outside the folder, at any depth, and for any shape it does not know', () => {
    const stops = [
      // A path in the second operation, an image path, a key that ends in `path` or `paths`.
      ['fs_read', { operations: [{ mode: 'Line', path: 'services/payments/src/charge.js' }, { mode: 'Line', path: '/etc/passwd' }] }],
      ['fs_read', { operations: [{ mode: 'Image', image_paths: ['services/payments/a.png', '/etc/ssh/ssh_host_ed25519_key'] }] }],
      ['fs_read', { operations: [{ mode: 'Image', image_paths: ['../../outside.png'] }] }],
      ['fs_write', { command: 'create', path: 'services/payments/src/a.js', file_text: 'x', target_path: '/etc/x' }],
      // Unknown keys, an unknown mode or command, a wrong type, a missing path.
      ['fs_read', { operations: [{ mode: 'Line', path: 'a.js', follow: true }] }],
      ['fs_read', { operations: [{ mode: 'Exec', path: 'a.js' }] }],
      ['fs_read', { operations: [{ mode: 'Line' }] }],
      ['fs_read', { operations: [] }],
      ['fs_read', { operations: 'a.js' }],
      ['fs_read', { operations: [{ mode: 'Line', path: 'a.js' }], extra: 1 }],
      ['fs_read', { operations: [{ mode: 'Image', image_paths: 'a.png' }] }],
      ['fs_read', { operations: [{ mode: 'Line', path: ['a.js'] }] }],
      ['fs_write', { command: 'delete', path: 'services/payments/src/a.js' }],
      ['fs_write', { command: 'create', file_text: 'x' }],
      ['fs_write', { path: 'services/payments/src/a.js', file_text: 'x' }],
      ['fs_write', { command: 'create', path: 'a.js', file_text: 7 }],
      ['fs_write', { command: 'create', path: 'a.js', mode: '0777' }],
      ['fs_write', 'create a.js'],
    ] as const;
    for (const [tool, args] of stops) {
      expect(new FixerGuard(FOLDER).judge(call('a', tool, args)).kind, `${tool} ${JSON.stringify(args)}`).toBe('stop');
      expect(new FixerGuard(FOLDER).judge(call('b', 'Tool Call', { tool_id: `tool::builtin::${tool}`, arguments: args })).kind, `wrapped ${JSON.stringify(args)}`).toBe('stop');
      // And as the arguments of a later update of an accepted call.
      const g = new FixerGuard(FOLDER);
      g.judge(call('c', tool, tool === 'fs_read' ? { operations: [{ mode: 'Line', path: 'a.js' }] } : { command: 'create', path: 'a.js', file_text: 'x' }));
      expect(g.judge(update('c', null, args)).kind, `update ${JSON.stringify(args)}`).toBe('stop');
    }
  });

  it('treats any key ending in path or paths as a path key, and arrays of them', () => {
    expect(pathsOf({ operations: [{ mode: 'Image', image_paths: ['a', 'b'] }] })).toEqual(['a', 'b']);
    expect(pathsOf({ source_path: 'x', workspacePaths: ['y', 'z'], dir: 'd' })).toEqual(['x', 'y', 'z', 'd']);
    expect(pathsOf({ new_str: '../../x', file_text: '/etc/passwd' })).toEqual([]);
  });

  it('describes a refusal in a few clean characters, and reads nothing else', () => {
    expect(describeFixerStop('execute_bash\u001b[31m' + 'x'.repeat(200), { command: 'secret' })).toHaveLength(80);
    expect(describeFixerStop('Tool Call', { tool_id: 'tool::builtin::execute_bash', arguments: { command: 'must-not-appear' } })).toBe('Tool Call tool_id=tool::builtin::execute_bash');
    expect(describeFixerStop('', {})).toBe('(no title)');
  });

  it('finds the paths of an input at any depth under the path keys, and not in file content', () => {
    expect(pathsOf({ path: 'a' })).toEqual(['a']);
    expect(pathsOf({ operations: [{ path: 'a', mode: 'Line' }, { path: 'b' }] })).toEqual(['a', 'b']);
    expect(pathsOf({ arguments: { file_path: 'c', file_text: '../../etc/passwd' } })).toEqual(['c']);
    expect(pathsOf({ paths: ['a', 'b'] })).toEqual(['a', 'b']);
    expect(pathsOf('x')).toEqual([]);
  });
});

// Feature: fix-proposal-flow, Property 6: the fixer allow-list accepts only the two file tools inside the folder
describe('Property 6: the fixer allow-list accepts only the two file tools inside the folder', () => {
  const safeSeg = fc.stringMatching(/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,10}$/).filter((s) => s !== '.' && s !== '..');
  const inside = fc.array(safeSeg, { minLength: 1, maxLength: 5 }).chain((segs) =>
    fc.constantFrom(`${segs.join('/')}`, `./${segs.join('/')}`, `${FOLDER}/${segs.join('/')}`),
  );
  const outside = fc.oneof(
    fc.constantFrom('../x', '../../etc/passwd', 'a/../../b', '/etc/hosts', '/var/fix/other/work/x', `${FOLDER}/../escape`, `${FOLDER}x/y`, '~/x', '$HOME/x', '%2e%2e/x', 'file:///etc/passwd', 'C:\\x', 'a\\b', '', '\0', 'a\0b', '..'),
    fc.array(safeSeg, { minLength: 1, maxLength: 3 }).map((s) => `../${s.join('/')}`),
    fc.array(safeSeg, { minLength: 1, maxLength: 3 }).map((s) => `/${s.join('/')}`),
  );
  const toolTitle = fc.constantFrom('fs_read', 'fs_write', 'Read', 'Write');
  const wrapped = (tool: string, args: unknown) => ({ title: 'Tool Call', input: { tool_id: `tool::builtin::${tool}`, arguments: args } });
  /** Arguments of a known kiro-cli 3.3.0 shape for the tool a title names, with the path in every path slot. */
  const argsFor = (title: string, path: string): unknown => {
    if (title === 'fs_write' || title === 'Write') return { command: 'create', path, file_text: 'x' };
    return { operations: [{ mode: 'Line', path }, { mode: 'Image', image_paths: [path] }] };
  };
  const callArb = fc.oneof(
    fc.tuple(toolTitle, fc.oneof(inside, outside)).map(([title, path]) => ({ title, input: argsFor(title, path), expected: insideOracle(path) })),
    fc.tuple(fc.constantFrom('fs_read', 'fs_write'), fc.oneof(inside, outside)).map(([tool, path]) => ({ ...wrapped(tool, argsFor(tool, path)), expected: insideOracle(path) })),
    fc.tuple(fc.string({ maxLength: 20 }).filter((t) => !['fs_read', 'fs_write', 'Read', 'Write', 'Tool Call', 'Tool Load'].includes(t)), inside).map(([title, path]) => ({ title, input: { path }, expected: false })),
    fc.constantFrom('execute_bash', 'shell', 'fs_delete', 'web_search', 'use_aws', 'fs_read ', ' fs_read', 'FS_READ', '@exorcist/query_metrics').map((title) => ({ title, input: { path: 'a.js' }, expected: false })),
  );

  function insideOracle(p: string): boolean {
    if (p === '' || /[\0\\%~$]/.test(p) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(p)) return false;
    if (p.split('/').includes('..')) return false;
    if (p.startsWith('/')) return p === FOLDER || p.startsWith(`${FOLDER}/`);
    return true;
  }

  it('accepts a call iff its title names a file tool and every path is inside the folder', () => {
    fc.assert(
      fc.property(callArb, ({ title, input, expected }) => {
        const g = new FixerGuard(FOLDER);
        const verdictOk = checkFixerCall(title, input).kind !== 'foreign';
        const out = g.judge(call('c1', title, input));
        expect(out.kind === 'step').toBe(expected && verdictOk);
        expect(out.kind === 'stop').toBe(!(expected && verdictOk));
      }),
      { numRuns: 400 },
    );
  });

  it('judges a later event with the id of an accepted call: it passes iff it names the same tool with paths inside', () => {
    const later = fc.oneof(
      fc.constant({ title: null as string | null, input: undefined as unknown }),
      fc.constantFrom('fs_read', 'fs_write', 'Read', 'Write', 'execute_bash', 'Tool Load').map((title) => ({ title: title as string | null, input: undefined as unknown })),
      fc.tuple(fc.constantFrom('fs_read', 'fs_write'), fc.oneof(inside, outside)).map(([tool, path]) => ({ title: 'Tool Call' as string | null, input: { tool_id: `tool::builtin::${tool}`, arguments: argsFor(tool, path) } as unknown })),
      fc.oneof(inside, outside).map((path) => ({ title: 'fs_read' as string | null, input: argsFor('fs_read', path) })),
      fc.oneof(inside, outside).map((path) => ({ title: 'fs_write' as string | null, input: argsFor('fs_write', path) })),
    );
    fc.assert(
      fc.property(fc.constantFrom('fs_read' as const, 'fs_write' as const), later, fc.boolean(), (accepted, ev, asCall) => {
        const g = new FixerGuard(FOLDER);
        expect(g.judge(call('c1', accepted, argsFor(accepted, 'services/payments/src/charge.js'))).kind).toBe('step');
        const event = asCall ? call('c1', ev.title ?? '', ev.input) : update('c1', ev.title, ev.input);
        const out = g.judge(event);
        const same = isSameFixerCall({ kind: 'step', tool: accepted }, ev.title, ev.input);
        const pathsFine = pathsOf(ev.input).every((p) => isInside(FOLDER, p));
        // The generated arguments are always of a known shape for their tool, so only the tool and the paths decide.
        expect(out.kind === 'pass').toBe(same && pathsFine);
        // A different tool is never the same call.
        const names = ev.title === 'Tool Call' ? (ev.input as { tool_id: string }).tool_id.split('::').at(-1) : ev.title;
        if (names !== null && names !== undefined && ['fs_read', 'fs_write'].includes(names) && names !== accepted) expect(out.kind).toBe('stop');
        if (ev.title === 'execute_bash' || ev.title === 'Tool Load') expect(out.kind).toBe('stop');
      }),
      { numRuns: 400 },
    );
  });

  it('never counts an update, and counts each accepted call once', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom('c1', 'c2', 'c3'), { minLength: 1, maxLength: 12 }), (ids) => {
        const g = new FixerGuard(FOLDER);
        const seen = new Set<string>();
        for (const id of ids) {
          g.judge(call(id, 'fs_read', { path: 'a.js' }));
          g.judge(update(id, null));
          g.judge(update(id, 'fs_read'));
          seen.add(id);
        }
        expect(g.count).toBe(seen.size);
      }),
      { numRuns: 100 },
    );
  });
});
