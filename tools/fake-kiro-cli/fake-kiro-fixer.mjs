#!/usr/bin/env node
// A stand-in for `kiro-cli` as the fix flow starts it (the `exorcist-fixer` agent: two file tools, no MCP): same
// command line, same stream-json shapes of kiro-cli 3.3.0, no model and no Credits. The fix runner starts it through
// the executable of `createFakeKiroFixer`, because the fixer environment is a fixed list and cannot carry a fixture.
//
// Fixture (`FAKE_KIRO_FIXTURE`, a name in `fixtures/fixer/` or an absolute path): `<name>.fixer.json`
//   { "steps": [ ... ], "finalCredits": 0.6, "endCredits": true, "exit": 0 }
// Steps:
//   read     { path, wrap? }                  an `fs_read` call, then the file is read
//   write    { path, content | lines, wrap? } an `fs_write` call that creates or overwrites the file
//   foreign  { title, input }                 a call to a tool that is not allowed (nothing runs)
//   reuse    { title, input }                 an update of the last call's id that names another tool
//   escape   { path }                         an `fs_write` call to a path (nothing is written)
//   symlink  { path, target }                 makes a symlink in the folder with no tool call (a model that found a way)
//   remove   { path }                         deletes a file with no tool call
//   sleep    { ms }
// `wrap: true` writes the call as the generic `Tool Call` wrapper (`tool_id` and `arguments`), announced with an
// update that has `title: null`, as kiro-cli 3.3.0 does.
// `FAKE_KIRO_OBSERVE` (optional): a file where the fake writes what it saw (argv, the NAMES of the environment
// variables, the working directory, the hash of the agent file and the files it found).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, lstatSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, 'fixtures', 'fixer');
const FLAGS = new Set(['--no-interactive', '--trust-workspace']);
const FLAGS_WITH_VALUE = new Set(['--agent', '--model', '--output-format']);
const out = (v) => process.stdout.write(`${typeof v === 'string' ? v : JSON.stringify(v)}\n`);
const fail = (code, message) => {
  process.stderr.write(`${message}\n`);
  process.exit(code);
};

/** Checks the command line like the real CLI would reject it. */
export function parseFixerArgv(argv) {
  const args = [...argv];
  if (args.shift() !== 'chat') return { error: 'expected the chat command' };
  const seen = new Set();
  const values = {};
  const positional = [];
  let trust = null;
  while (args.length > 0) {
    const a = args.shift();
    if (a.startsWith('--trust-tools=')) trust = a.slice('--trust-tools='.length);
    else if (FLAGS.has(a)) seen.add(a);
    else if (FLAGS_WITH_VALUE.has(a)) {
      const v = args.shift();
      if (v === undefined || v.startsWith('--')) return { error: `${a} needs a value` };
      values[a] = v;
    } else if (a.startsWith('--')) return { error: `unexpected argument '${a}'` };
    else positional.push(a);
  }
  for (const f of FLAGS) if (!seen.has(f)) return { error: `missing ${f}` };
  if (values['--output-format'] !== 'stream-json') return { error: 'output format must be stream-json' };
  if (values['--agent'] !== 'exorcist-fixer') return { error: 'unexpected --agent' };
  if (!values['--model'] || values['--model'] === 'auto') return { error: 'a pinned --model is required' };
  if (trust !== 'fs_read,fs_write') return { error: 'unexpected --trust-tools' };
  if (positional.length !== 1 || positional[0] === '') return { error: 'expected exactly one prompt' };
  return { agent: values['--agent'], model: values['--model'], prompt: positional[0] };
}

function findFixture(name) {
  if (!name) return null;
  const base = isAbsolute(name) ? name : join(FIXTURES, name);
  const path = base.endsWith('.fixer.json') ? base : `${base}.fixer.json`;
  return existsSync(path) ? path : null;
}

let counter = 0;
const update = (u) => out({ type: 'sessionUpdate', data: { sessionId: 'session-1', update: u } });
const WRAPPER_META = { kiro: { toolOrigin: 'default' } };
const emitUpdate = (id, status, extra = {}) => update({ sessionUpdate: 'tool_call_update', toolCallId: id, status, ...extra });
const emitCredits = (usage) => update({ sessionUpdate: 'session_info_update', _meta: { kiro: { kind: 'session_usage', credits: [{ usage, unit: 'credit', unitPlural: 'credits' }] } } });

function emitCall(tool, input, wrap) {
  const id = `call-${++counter}`;
  if (wrap) update({ sessionUpdate: 'tool_call', toolCallId: id, title: 'Tool Call', kind: 'other', rawInput: { tool_id: `tool::builtin::${tool}`, arguments: input }, _meta: WRAPPER_META });
  else update({ sessionUpdate: 'tool_call', toolCallId: id, title: tool, kind: 'other', rawInput: input });
  // The real one announces a running call without a title.
  emitUpdate(id, 'in_progress', { title: null });
  return id;
}

const contentOf = (step) => {
  if (typeof step.content === 'string') return step.content;
  const base = typeof step.prefix === 'string' ? step.prefix : '';
  return base + Array.from({ length: step.lines ?? 0 }, (_, i) => `// generated line ${i + 1}\n`).join('');
};

async function run(script) {
  let last = null;
  for (const step of script.steps ?? []) {
    switch (step.kind) {
      case 'read': {
        // The kiro-cli 3.3.0 form: a list of operations, each with a mode.
        const id = emitCall('fs_read', { operations: [{ mode: 'Line', path: step.path }] }, step.wrap === true);
        last = { id, tool: 'fs_read' };
        let ok = true;
        try {
          readFileSync(resolve(process.cwd(), step.path), 'utf8');
        } catch {
          ok = false;
        }
        emitUpdate(id, ok ? 'completed' : 'failed', { title: step.wrap === true ? 'Tool Call' : 'fs_read' });
        break;
      }
      case 'write': {
        const id = emitCall('fs_write', { command: 'create', path: step.path, file_text: contentOf(step) }, step.wrap === true);
        last = { id, tool: 'fs_write' };
        let ok = true;
        try {
          const target = resolve(process.cwd(), step.path);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, contentOf(step));
        } catch {
          ok = false;
        }
        emitUpdate(id, ok ? 'completed' : 'failed', { title: step.wrap === true ? 'Tool Call' : 'fs_write' });
        break;
      }
      case 'escape': {
        const id = emitCall('fs_write', { command: 'create', path: step.path, file_text: 'x' }, false);
        last = { id, tool: 'fs_write' };
        break;
      }
      case 'foreign': {
        const id = emitCall(step.title, step.input ?? {}, false);
        last = { id, tool: step.title };
        break;
      }
      case 'reuse': {
        if (last === null) fail(2, 'reuse needs a call before it');
        emitUpdate(last.id, 'in_progress', { title: step.title, rawInput: step.input ?? {} });
        break;
      }
      case 'symlink':
        symlinkSync(step.target, resolve(process.cwd(), step.path));
        break;
      case 'remove':
        rmSync(resolve(process.cwd(), step.path), { force: true });
        break;
      case 'sleep':
        await sleep(step.ms);
        break;
      default:
        fail(2, `unknown script step ${String(step.kind)}`);
    }
  }
  if (script.endCredits !== false) emitCredits(script.finalCredits ?? 0.6);
  update({ sessionUpdate: 'session_info_update', _meta: { kiro: { kind: 'turn_end', stopReason: 'end_turn' } } });
  out({ type: 'runFinished', data: { sessionId: 'session-1', status: 'success', stopReason: 'end_turn', finalText: 'Done.', finalTextTruncated: false } });
  process.exit(script.exit ?? 0);
}

function listFiles(dir, rel = '') {
  const names = [];
  for (const name of readdirSync(dir).sort()) {
    if (rel === '' && name === '.kiro') continue;
    const p = join(dir, name);
    const s = lstatSync(p);
    if (s.isDirectory()) names.push(...listFiles(p, rel === '' ? name : `${rel}/${name}`));
    else names.push(rel === '' ? name : `${rel}/${name}`);
  }
  return names;
}

async function main() {
  const parsed = parseFixerArgv(process.argv.slice(2));
  if (parsed.error) fail(2, `error: ${parsed.error}`);
  const agentPath = join(process.cwd(), '.kiro', 'agents', `${parsed.agent}.json`);
  if (process.env.FAKE_KIRO_OBSERVE) {
    const agentSha = existsSync(agentPath) ? createHash('sha256').update(readFileSync(agentPath)).digest('hex') : null;
    writeFileSync(
      process.env.FAKE_KIRO_OBSERVE,
      JSON.stringify({ argv: process.argv.slice(2), envNames: Object.keys(process.env).sort(), cwd: process.cwd(), agentSha, files: listFiles(process.cwd()), hasGit: existsSync(join(process.cwd(), '.git')) }),
    );
  }
  if (!existsSync(agentPath)) fail(4, `agent "${parsed.agent}" not found`);
  let agent;
  try {
    agent = JSON.parse(readFileSync(agentPath, 'utf8'));
  } catch {
    fail(4, 'agent config is not valid JSON');
  }
  if (JSON.stringify(agent.tools) !== '["fs_read","fs_write"]' || agent.mcpServers !== undefined) fail(4, 'agent has tools it must not have');
  const fixture = findFixture(process.env.FAKE_KIRO_FIXTURE);
  if (!fixture) fail(2, `error: unknown fixture "${basename(process.env.FAKE_KIRO_FIXTURE ?? '')}"`);
  await run(JSON.parse(readFileSync(fixture, 'utf8')));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => fail(1, 'fake-kiro-fixer: internal error'));
}
