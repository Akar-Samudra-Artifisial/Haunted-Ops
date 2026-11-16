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
//   edit-command  { path, oldStr, newStr }    the `Editing <file>` call of kiro-cli 3.3.0 (`strReplace`), then the file is edited
//   read-dynamic  { path }                    the `Reading <file>:<line>` call of kiro-cli 3.3.0 (`operations`, `toolName`)
//   `running: true` on edit-command and read-dynamic writes the form of kiro-cli 3.3.0 with `KIRO_API_KEY`: the title starts with
//   `Running: ` and the input carries `__tool_use_purpose` (model text). `server` adds `_meta.kiro.mcpServerName` (a built-in tool has none).
//   escape   { path }                         an `fs_write` call to a path (nothing is written)
//   symlink  { path, target }                 makes a symlink in the folder with no tool call (a model that found a way)
//   remove   { path }                         deletes a file with no tool call
//   sleep    { ms }
// `purpose: true` (with `wrap`) puts `__tool_use_purpose` (model text) inside the `arguments` of the wrapper, as kiro-cli 3.3.0 does.
// `wrap: true` writes the call as the generic `Tool Call` wrapper (`tool_id` and `arguments`), announced with an
// update that has `title: null`, as kiro-cli 3.3.0 does.
// `FAKE_KIRO_STREAM` (optional, instead of a fixture): the path of a `*.stream.jsonl`; its lines are replayed and the edits
// of its calls are applied in the work folder (`applyEdit`). Used by the parity test with the files in
// `apps/api/test/fixtures/fixer-streams/`.
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

function emitCall(tool, input, wrap, purpose = false) {
  const id = `call-${++counter}`;
  if (wrap) update({ sessionUpdate: 'tool_call', toolCallId: id, title: 'Tool Call', kind: 'other', rawInput: { tool_id: `tool::builtin::${tool}`, arguments: purpose ? { ...input, __tool_use_purpose: 'Read or write the file' } : input }, _meta: WRAPPER_META });
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
        const id = emitCall('fs_read', { operations: [{ mode: 'Line', path: step.path }] }, step.wrap === true, step.purpose === true);
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
        const id = emitCall('fs_write', { command: 'create', path: step.path, file_text: contentOf(step) }, step.wrap === true, step.purpose === true);
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
      case 'edit-command': {
        // The dynamic shape of kiro-cli 3.3.0 (task 20): title `Editing <file>`, `strReplace`, `_meta.kiro.toolName` `write`.
        const id = `call-${++counter}`;
        const input = { command: 'strReplace', path: step.path, oldStr: step.oldStr, newStr: step.newStr };
        const shown = step.running === true ? { ...input, __tool_use_purpose: 'Fix the bad line' } : input;
        const title = `${step.running === true ? 'Running: ' : ''}Editing ${basename(step.path)}`;
        const meta = { kiro: { toolName: 'write', ...(step.server === undefined ? {} : { mcpServerName: step.server }) } };
        update({ sessionUpdate: 'tool_call', toolCallId: id, title, kind: 'edit', rawInput: shown, _meta: meta });
        emitUpdate(id, 'pending', { title: null, rawInput: shown });
        last = { id, tool: 'fs_write' };
        let ok = true;
        try {
          const target = resolve(process.cwd(), step.path);
          const text = readFileSync(target, 'utf8');
          if (!text.includes(step.oldStr)) throw new Error('no match');
          writeFileSync(target, text.replace(step.oldStr, () => step.newStr));
        } catch {
          ok = false;
        }
        emitUpdate(id, ok ? 'completed' : 'failed', { rawInput: shown });
        break;
      }
      case 'read-dynamic': {
        // The batch read of kiro-cli 3.3.0 (task 19): title `Reading <file>:<line>`, `operations`, `toolName` `read`.
        const id = `call-${++counter}`;
        const input = { operations: [{ mode: 'Line', path: step.path }] };
        const shown = step.running === true ? { ...input, __tool_use_purpose: 'Read the file' } : input;
        const title = `${step.running === true ? 'Running: ' : ''}Reading ${basename(step.path)}:1`;
        const meta = { kiro: { toolName: 'read', ...(step.server === undefined ? {} : { mcpServerName: step.server }) } };
        update({ sessionUpdate: 'tool_call', toolCallId: id, title, kind: 'read', rawInput: shown, _meta: meta });
        last = { id, tool: 'fs_read' };
        emitUpdate(id, 'completed', { title, rawInput: shown });
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
      case 'migrate-agent': {
        // What kiro-cli 3.3.0 does to the agent file on first use: tools renamed, allow rules and kiroUpgrade added.
        const file = resolve(process.cwd(), '.kiro/agents/exorcist-fixer.json');
        const original = readFileSync(file);
        // kiro-cli keeps the file it migrated next to it, byte-equal to what it found (`bak: false` skips it).
        if (step.bak !== false) writeFileSync(`${file}.bak`, step.bakContent ?? original);
        const agent = JSON.parse(original.toString('utf8'));
        const rename = (list) => (Array.isArray(list) ? list.map((t) => (t === 'fs_read' ? 'read' : t === 'fs_write' ? 'write' : t)) : list);
        agent.tools = rename(agent.tools);
        agent.allowedTools = rename(agent.allowedTools);
        const rules = [];
        for (const [cap, s] of Object.entries(agent.toolsSettings ?? {})) rules.push({ capability: cap, match: s.allowedPaths ?? [], effect: 'allow' });
        rules.push({ capability: 'fs_read', effect: 'allow' }, { capability: 'fs_write', effect: 'allow' }, { capability: 'skill', effect: 'allow' });
        agent.permissions = { rules };
        agent.kiroUpgrade = { revision: 3, fingerprint: `sha256:${'0'.repeat(63)}1`, source: `sha256:${'0'.repeat(63)}2` };
        if (step.extraRule !== undefined) agent.permissions.rules.push(step.extraRule);
        writeFileSync(file, `${JSON.stringify(agent, null, 2)}\n`);
        break;
      }
      case 'garbage':
        // Lines that are not JSON, as a broken stream would send them.
        for (let n = 0; n < (step.lines ?? 1); n++) process.stdout.write(`not json ${n}\n`);
        break;
      case 'oversized': {
        // One tool call line longer than the parser's 1 MiB cap, with a path the guard would refuse if it could read it.
        const id = `call-${++counter}`;
        update({ sessionUpdate: 'tool_call', toolCallId: id, title: 'Write File', kind: 'edit', rawInput: { path: step.path ?? '/etc/hosts', text: 'x'.repeat(step.bytes ?? 1_200_000) } });
        last = { id, tool: 'fs_write' };
        break;
      }
      case 'no-input': {
        // A file tool call announced with no input, then completed: its arguments are never seen.
        const id = `call-${++counter}`;
        update({ sessionUpdate: 'tool_call', toolCallId: id, title: step.title ?? 'Write File', kind: 'edit' });
        emitUpdate(id, 'completed', { title: step.title ?? 'Write File' });
        last = { id, tool: 'fs_write' };
        break;
      }
      case 'orphan-update':
        // An update of a call id that was never announced, with no title.
        emitUpdate(`orphan-${++counter}`, 'in_progress', { title: null, rawInput: step.input ?? {} });
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

const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
/**
 * Does in the work folder what the file tool of a call would do (kiro-cli 3.3.0 `write`: `create`, `strReplace`,
 * `insert`; the older `Write File` and `Replace in File` shapes). Returns false when the call changes nothing.
 * `insertLine` is the line after which the text goes; none appends.
 */
export function applyEdit(input, cwd = process.cwd()) {
  if (!isRecord(input) || typeof input.path !== 'string') return false;
  const target = resolve(cwd, input.path);
  try {
    const command = input.command;
    if (command === 'create' || (command === undefined && typeof input.text === 'string')) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, String(input.content ?? input.text ?? ''));
      return true;
    }
    if (command === 'strReplace' || (command === undefined && typeof input.oldStr === 'string')) {
      const text = readFileSync(target, 'utf8');
      if (!text.includes(input.oldStr)) return false;
      const all = input.replaceAll === true || input.replace_all === true;
      writeFileSync(target, all ? text.split(input.oldStr).join(input.newStr) : text.replace(input.oldStr, () => input.newStr));
      return true;
    }
    if (command === 'insert') {
      const text = readFileSync(target, 'utf8');
      const content = String(input.content ?? '');
      if (input.insertLine === undefined) {
        writeFileSync(target, text + (text === '' || text.endsWith('\n') ? '' : '\n') + content);
        return true;
      }
      const lines = text.split('\n');
      lines.splice(input.insertLine, 0, ...content.replace(/\n$/, '').split('\n'));
      writeFileSync(target, lines.join('\n'));
      return true;
    }
  } catch {
    return false;
  }
  return false;
}
/**
 * Replays a recorded or schema-derived stream (`FAKE_KIRO_STREAM`, a `*.stream.jsonl` of tool calls and updates): its
 * lines go out as they are, the edit of each call is applied in the work folder, then the run ends like a normal one.
 */
async function runStream(file) {
  const applied = new Set();
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    if (raw.trim() === '') continue;
    process.stdout.write(`${raw}\n`);
    let u;
    try {
      u = JSON.parse(raw)?.data?.update ?? null;
    } catch {
      continue;
    }
    // The call carries its input, or its first update does.
    if (isRecord(u) && typeof u.toolCallId === 'string' && !applied.has(u.toolCallId) && applyEdit(u.rawInput)) applied.add(u.toolCallId);
  }
  emitCredits(0.6);
  update({ sessionUpdate: 'session_info_update', _meta: { kiro: { kind: 'turn_end', stopReason: 'end_turn' } } });
  out({ type: 'runFinished', data: { sessionId: 'session-1', status: 'success', stopReason: 'end_turn', finalText: 'Done.', finalTextTruncated: false } });
  process.exit(0);
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
  if (process.env.FAKE_KIRO_STREAM) return await runStream(process.env.FAKE_KIRO_STREAM);
  const fixture = findFixture(process.env.FAKE_KIRO_FIXTURE);
  if (!fixture) fail(2, `error: unknown fixture "${basename(process.env.FAKE_KIRO_FIXTURE ?? '')}"`);
  await run(JSON.parse(readFileSync(fixture, 'utf8')));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => fail(1, 'fake-kiro-fixer: internal error'));
}
