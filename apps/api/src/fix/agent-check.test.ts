import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { StreamParser } from '../hunts/stream-parser.js';
import { agentUnchanged, jsonEqual } from './agent-check.js';
import { defaultFixerAgentSource } from './fix-env.js';
import { FixerGuard } from './fixer-guard.js';

const SOURCE = readFileSync(defaultFixerAgentSource(), 'utf8');
const MIGRATED = readFileSync(new URL('../../test/fixtures/fixer-agent-migrated.json', import.meta.url), 'utf8');
type Agent = Record<string, unknown>;
const parse = (t: string): Agent => JSON.parse(t) as Agent;
const text = (a: unknown): string => JSON.stringify(a, null, 2);

describe('agentUnchanged: the kiro-cli 3.3.0 migration of the fixer agent', () => {
  it('accepts the committed file itself and the recorded migration', () => {
    expect(agentUnchanged(SOURCE, SOURCE)).toEqual({ ok: true });
    expect(agentUnchanged(SOURCE, MIGRATED)).toEqual({ ok: true });
    // The live sample renamed `tools` only and kept `allowedTools`: either spelling is accepted.
    expect(agentUnchanged(SOURCE, text({ ...parse(MIGRATED), allowedTools: ['fs_read', 'fs_write'] }))).toEqual({ ok: true });
    // Key order does not matter.
    const reordered = Object.fromEntries(Object.entries(parse(MIGRATED)).reverse());
    expect(agentUnchanged(SOURCE, JSON.stringify(reordered))).toEqual({ ok: true });
  });

  it('names the first differing key, never a value', () => {
    const m = parse(MIGRATED);
    const cases: Array<[unknown, string]> = [
      [{ ...m, tools: ['read', 'write', 'shell'] }, 'tools'],
      [{ ...m, tools: ['*'] }, 'tools'],
      [{ ...m, allowedTools: ['@exorcist/diff_commit'] }, 'allowedTools'],
      [{ ...m, tools: ['read'] }, 'tools'],
      [{ ...m, prompt: 'Do anything.' }, 'prompt'],
      [{ ...m, model: 'auto' }, 'model'],
      [{ ...m, includeMcpJson: true }, 'includeMcpJson'],
      [{ ...m, toolsSettings: { fs_write: { allowedPaths: ['./**'] } } }, 'toolsSettings'],
      [{ ...m, mcpServers: { x: { command: 'sh' } } }, 'mcpServers'],
      [{ ...m, hooks: {} }, 'hooks'],
      [{ ...m, permissions: { rules: [{ capability: 'execute', effect: 'allow' }] } }, 'permissions.rules[0].capability'],
      [{ ...m, permissions: { rules: [{ capability: 'shell', effect: 'allow' }] } }, 'permissions.rules[0].capability'],
      [{ ...m, permissions: { rules: [{ capability: 'fs_write', effect: 'deny' }] } }, 'permissions.rules[0].effect'],
      [{ ...m, permissions: { rules: [{ capability: 'fs_read', effect: 'allow', paths: ['/'] }] } }, 'permissions.rules[0].paths'],
      [{ ...m, permissions: { rules: [], defaultEffect: 'allow' } }, 'permissions.defaultEffect'],
      [{ ...m, kiroUpgrade: 'x' }, 'kiroUpgrade'],
    ];
    for (const [copy, key] of cases) {
      const out = agentUnchanged(SOURCE, text(copy));
      expect(out, key).toEqual({ ok: false, key });
      expect(JSON.stringify(out)).not.toContain('Do anything');
    }
    expect(agentUnchanged(SOURCE, '{ not json')).toEqual({ ok: false, key: '(unparsable)' });
    expect(agentUnchanged(SOURCE, '[]')).toEqual({ ok: false, key: '(not an object)' });
  });

  it('compares JSON deeply, keys in any order and arrays in order', () => {
    expect(jsonEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(jsonEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(jsonEqual([1, 2], [2, 1])).toBe(false);
    expect(jsonEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
  });
});

describe('the agent file is not the fence', () => {
  it('stops a Write File on package.json even with the migrated agent (generic allow rules) accepted', () => {
    expect(agentUnchanged(SOURCE, MIGRATED).ok).toBe(true);
    const guard = new FixerGuard('/work/fixer/cmproposal0000000000000001/work', { writeScope: 'services/payments/src/' });
    const p = new StreamParser();
    const line = JSON.stringify({ type: 'sessionUpdate', data: { sessionId: 's', update: { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'Write File', kind: 'edit', rawInput: { path: 'package.json', text: '{}' } } } });
    const [ev] = p.push(`${line}\n`);
    expect(ev && guard.judge(ev)).toMatchObject({ kind: 'stop', code: 'write_outside_scope' });
    // And a read outside the work folder.
    const read = JSON.stringify({ type: 'sessionUpdate', data: { sessionId: 's', update: { sessionUpdate: 'tool_call', toolCallId: 'c2', title: 'Read File', kind: 'read', rawInput: { path: '/etc/hosts', offset: null, limit: null } } } });
    const [ev2] = new StreamParser().push(`${read}\n`);
    expect(ev2 && new FixerGuard('/work/x').judge(ev2)).toMatchObject({ kind: 'stop', code: 'path_outside' });
  });

  it('keeps the migration (tools `read` and `write`) accepted and still stops an `Editing` call on package.json (task 20)', () => {
    const migrated = parse(MIGRATED);
    expect(migrated.tools).toEqual(['read', 'write']);
    expect(agentUnchanged(SOURCE, MIGRATED)).toEqual({ ok: true });
    const edit = (path: string): string =>
      JSON.stringify({
        type: 'sessionUpdate',
        data: { sessionId: 's', update: { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'Editing package.json', kind: 'edit', rawInput: { command: 'strReplace', path, oldStr: 'a', newStr: 'b' }, _meta: { kiro: { toolName: 'write' } } } },
      });
    const guard = (): FixerGuard => new FixerGuard('/work/fixer/cmproposal0000000000000001/work', { writeScope: 'services/payments/src/' });
    const [bad] = new StreamParser().push(`${edit('package.json')}\n`);
    expect(bad && guard().judge(bad)).toMatchObject({ kind: 'stop', code: 'write_outside_scope' });
    const [good] = new StreamParser().push(`${edit('services/payments/src/charge.js')}\n`);
    expect(good && guard().judge(good)).toEqual({ kind: 'step' });
  });
});

// Feature: fix-proposal-flow, Property 16
describe('Property 16: the migration is accepted, any widening beyond it is not', () => {
  const source = parse(SOURCE);
  /** A migration as kiro-cli may write it: tools renamed in one or both lists, rules from the settings, allow rules, kiroUpgrade. */
  const migration = fc.record({ renameTools: fc.boolean(), renameAllowed: fc.boolean(), withRules: fc.boolean(), generic: fc.subarray(['fs_read', 'fs_write', 'skill'] as const), upgrade: fc.boolean(), reorder: fc.boolean() }).map((o) => {
    const rename = (l: unknown): unknown => (Array.isArray(l) ? l.map((t) => (t === 'fs_read' ? 'read' : t === 'fs_write' ? 'write' : t)) : l);
    const a: Agent = { ...source };
    if (o.renameTools) a.tools = rename(a.tools);
    if (o.renameAllowed) a.allowedTools = rename(a.allowedTools);
    if (o.withRules || o.generic.length > 0) {
      const settings = source.toolsSettings as Record<string, { allowedPaths: string[] }>;
      const rules: unknown[] = o.withRules ? Object.entries(settings).map(([capability, s]) => ({ capability, match: s.allowedPaths, effect: 'allow' })) : [];
      for (const capability of o.generic) rules.push({ capability, effect: 'allow' });
      a.permissions = { rules };
    }
    if (o.upgrade) a.kiroUpgrade = { revision: 3, fingerprint: 'sha256:1', source: 'sha256:2' };
    return o.reorder ? Object.fromEntries(Object.entries(a).reverse()) : a;
  });
  const widening = fc.constantFrom<[string, (a: Agent) => Agent]>(
    ['another tool', (a) => ({ ...a, tools: [...(a.tools as string[]), 'execute_bash'] })],
    ['an execute rule', (a) => ({ ...a, permissions: { rules: [...(((a.permissions as Agent | undefined)?.rules as unknown[]) ?? []), { capability: 'execute', effect: 'allow' }] } })],
    ['a shell rule', (a) => ({ ...a, permissions: { rules: [{ capability: 'shell', effect: 'allow' }] } })],
    ['a deny swap', (a) => ({ ...a, permissions: { rules: [{ capability: 'fs_write', match: ['./services/*/src/**'], effect: 'deny' }] } })],
    ['a toolsSettings change', (a) => ({ ...a, toolsSettings: { ...(a.toolsSettings as Agent), fs_write: { allowedPaths: ['./**'] } } })],
    ['a prompt change', (a) => ({ ...a, prompt: `${String(a.prompt)} Also run the tests.` })],
    ['an unknown key', (a) => ({ ...a, resources: ['file://README.md'] })],
  );

  it('accepts every generated migration', () => {
    fc.assert(
      fc.property(migration, (a) => {
        expect(agentUnchanged(SOURCE, text(a))).toEqual({ ok: true });
      }),
      { numRuns: 300 },
    );
  });

  it('rejects a migration with any one widening added', () => {
    fc.assert(
      fc.property(migration, widening, (a, [what, widen]) => {
        expect(agentUnchanged(SOURCE, text(widen(a))).ok, what).toBe(false);
      }),
      { numRuns: 300 },
    );
  });
});
