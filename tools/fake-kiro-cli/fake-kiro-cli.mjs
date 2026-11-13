#!/usr/bin/env node
// A stand-in for `kiro-cli` in tests: same command line, same stream-json output, no model and no
// Credits. The Hunt runner starts it through `KIRO_CLI_PATH` (usually a wrapper made by
// `wrapper.mjs`, because the Hunt environment is a fixed list and cannot carry a fixture name).
//
// Fixture (`FAKE_KIRO_FIXTURE`, a name in `fixtures/` or an absolute path):
//   <name>.script.json  script mode: starts the real Exorcist MCP server from the agent config and
//                       calls its tools as scripted; the ledger comes from that server.
//   <name>.stream.jsonl replay mode: writes the recorded stream; a sibling <name>.ledger.jsonl is
//                       copied to HUNT_LEDGER_PATH.
// `FAKE_KIRO_OBSERVE` (optional): a file where the fake writes what it saw (argv, the NAMES of the
// environment variables, the working directory, a hash of the agent file) so a test can check them.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { startMcpServer } from './mcp-stdio-client.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const TOOLS = ['query_metrics', 'search_errors', 'tail_logs', 'recent_deploys', 'diff_commit', 'submit_diagnosis'];
const FLAGS_WITH_VALUE = new Set(['--agent', '--model', '--output-format']);
const FLAGS = new Set(['--no-interactive', '--trust-workspace', '--require-mcp-startup']);
const out = (v) => process.stdout.write(`${typeof v === 'string' ? v : JSON.stringify(v)}\n`);
const fail = (code, message) => {
  process.stderr.write(`${message}\n`);
  process.exit(code);
};

/** Checks the command line like the real CLI would reject it. Exit 2 on any unknown or missing part. */
export function parseArgv(argv) {
  const args = [...argv];
  if (args.shift() !== 'chat') return { error: 'expected the chat command' };
  const seen = new Set();
  const values = {};
  const positional = [];
  let trust = null;
  while (args.length > 0) {
    const a = args.shift();
    if (a.startsWith('--trust-tools=')) {
      trust = a.slice('--trust-tools='.length);
    } else if (FLAGS.has(a)) {
      seen.add(a);
    } else if (FLAGS_WITH_VALUE.has(a)) {
      const v = args.shift();
      if (v === undefined || v.startsWith('--')) return { error: `${a} needs a value` };
      values[a] = v;
    } else if (a.startsWith('--')) {
      return { error: `unexpected argument '${a}'` };
    } else {
      positional.push(a);
    }
  }
  for (const f of FLAGS) if (!seen.has(f)) return { error: `missing ${f}` };
  if (values['--output-format'] !== 'stream-json') return { error: 'output format must be stream-json' };
  if (!values['--agent']) return { error: 'missing --agent' };
  if (!values['--model'] || values['--model'] === 'auto') return { error: 'a pinned --model is required' };
  const expected = TOOLS.map((t) => `@exorcist/${t}`).sort().join(',');
  if (trust === null || trust.split(',').sort().join(',') !== expected) return { error: 'unexpected --trust-tools' };
  if (positional.length !== 1 || positional[0] === '') return { error: 'expected exactly one prompt' };
  return { agent: values['--agent'], model: values['--model'], prompt: positional[0] };
}

const FIXTURES = join(here, 'fixtures');
function findFixture(name) {
  if (!name) return null;
  const base = isAbsolute(name) ? name : join(FIXTURES, name);
  const stem = base.replace(/\.(script\.json|stream\.jsonl)$/, '');
  if (existsSync(`${stem}.script.json`)) return { mode: 'script', path: `${stem}.script.json`, stem };
  if (existsSync(`${stem}.stream.jsonl`)) return { mode: 'replay', path: `${stem}.stream.jsonl`, stem };
  return null;
}

/** `$NOW-15m` becomes the ISO time 15 minutes ago, at second precision. */
function fill(value) {
  if (typeof value === 'string') {
    const m = /^\$NOW-(\d+)m$/.exec(value);
    return m ? new Date(Math.floor((Date.now() - Number(m[1]) * 60_000) / 1000) * 1000).toISOString().replace('.000Z', 'Z') : value;
  }
  if (Array.isArray(value)) return value.map(fill);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v)]));
  return value;
}

let counter = 0;
const callId = () => `call-${++counter}`;
const update = (u) => out({ type: 'sessionUpdate', data: { sessionId: 'session-1', update: u } });
const emitCall = (title, rawInput, meta) => {
  const id = callId();
  update({ sessionUpdate: 'tool_call', toolCallId: id, title, kind: 'other', rawInput, ...(meta ? { _meta: meta } : {}) });
  return id;
};
/** kiro-cli 3.3.0 sometimes calls an MCP tool through this generic wrapper (see the design, "The `Tool Call` wrapper"). */
const WRAPPER_META = { kiro: { toolOrigin: 'default' } };
const emitUpdate = (id, status, extra = {}) => update({ sessionUpdate: 'tool_call_update', toolCallId: id, status, ...extra });
const emitCredits = (usage) => update({ sessionUpdate: 'session_info_update', _meta: { kiro: { kind: 'session_usage', credits: [{ usage, unit: 'credit', unitPlural: 'credits' }] } } });

async function runScript(script, agent) {
  const server = agent?.mcpServers?.exorcist;
  if (!server?.command) fail(3, 'mcp server exorcist is not configured');
  out({ type: 'runStarted', data: { payloadSchema: 'acp', acpProtocolVersion: 1, engine: 'v3' } });
  let client = null;
  try {
    client = await startMcpServer(server, script.breakMcp === true ? ['LAB_READ_TOKEN'] : []);
  } catch {
    // `--require-mcp-startup`: a server that does not start ends the run with exit code 3.
    fail(3, 'mcp server failed to start');
  }
  const started = Date.now();
  let abort = false;
  const stop = () => {
    abort = true;
    client?.close();
    process.exit(143);
  };
  process.on('SIGTERM', stop);
  for (const step of script.steps ?? []) {
    if (abort) break;
    switch (step.kind) {
      case 'load': {
        // `shape` picks how the ids are written; kiro-cli 3.3.0 sends `id`, other builds may differ.
        const name = `tool::exorcist::${step.tool}`;
        const shapes = {
          id: { id: name },
          tool_id: { tool_id: name },
          tool_ids: { tool_ids: [name] },
          ids: { ids: [`@exorcist/${step.tool}`] },
          tools: { tools: [step.tool] },
          at_name: { id: `@exorcist/${step.tool}` },
        };
        const id = emitCall('Tool Load', shapes[step.shape ?? 'id'] ?? shapes.id);
        emitUpdate(id, 'completed');
        break;
      }
      case 'call': {
        const input = fill(step.input ?? {});
        const wrapped = step.wrap === true;
        const id = wrapped
          ? emitCall('Tool Call', { tool_id: `tool::exorcist::${step.tool}`, arguments: input }, WRAPPER_META)
          : emitCall(`@exorcist/${step.tool}`, input);
        // A wrapped call is announced without a title and gets it when it completes, like the real one.
        emitUpdate(id, 'in_progress', wrapped ? { title: null } : {});
        if (step.echo === true) {
          // The same call again, and updates that name the same tool: none is a new call.
          update({ sessionUpdate: 'tool_call', toolCallId: id, title: `@exorcist/${step.tool}`, kind: 'other', rawInput: input });
          emitUpdate(id, 'in_progress', { title: null });
          emitUpdate(id, 'in_progress', { title: `@exorcist/${step.tool}`, rawInput: input });
        }
        if (step.reuse !== undefined) {
          // A bypass attempt: an update of an accepted id that names another tool. The runner must stop the Hunt.
          emitUpdate(id, 'in_progress', { title: step.reuse.title, rawInput: fill(step.reuse.input ?? {}) });
        }
        let result;
        try {
          result = await client.callTool(step.tool, input);
        } catch {
          result = { text: 'mcp call failed', isError: true };
        }
        emitUpdate(id, result.isError ? 'failed' : 'completed', { title: wrapped ? 'Tool Call' : `@exorcist/${step.tool}`, rawOutput: { response: result.text, message: result.text } });
        break;
      }
      case 'foreign': {
        const id = emitCall(step.title, fill(step.input ?? {}));
        emitUpdate(id, 'in_progress');
        break;
      }
      case 'wrapper': {
        // A wrapped call with any `tool_id` and arguments, as written in the script (no tool is run).
        const id = emitCall('Tool Call', { tool_id: step.toolId, arguments: fill(step.input ?? {}) }, WRAPPER_META);
        emitUpdate(id, 'in_progress', { title: null });
        break;
      }
      case 'raw':
        process.stdout.write(`${step.text}\n`);
        break;
      case 'credits':
        emitCredits(step.usage);
        break;
      case 'message':
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: step.text } });
        break;
      case 'sleep':
        await sleep(step.ms);
        break;
      default:
        fail(2, `unknown script step ${String(step.kind)}`);
    }
  }
  client.close();
  if (script.endCredits !== false) emitCredits(script.finalCredits ?? 0.6);
  update({ sessionUpdate: 'session_info_update', _meta: { kiro: { kind: 'turn_completion', elapsedTime: Date.now() - started, status: 'success' } } });
  update({ sessionUpdate: 'session_info_update', _meta: { kiro: { kind: 'turn_end', stopReason: 'end_turn' } } });
  out({ type: 'runFinished', data: { sessionId: 'session-1', status: 'success', stopReason: 'end_turn', finalText: script.final ?? 'Done.', finalTextTruncated: false } });
  process.exit(script.exit ?? 0);
}

async function runReplay(fixture, delayMs) {
  const ledger = `${fixture.stem}.ledger.jsonl`;
  const target = process.env.HUNT_LEDGER_PATH;
  if (existsSync(ledger) && target) copyFileSync(ledger, target);
  for (const line of readFileSync(fixture.path, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    process.stdout.write(`${line}\n`);
    if (delayMs > 0) await sleep(Math.min(delayMs, 2000));
  }
  process.exit(0);
}

async function main() {
  const parsed = parseArgv(process.argv.slice(2));
  if (parsed.error) fail(2, `error: ${parsed.error}`);
  const agentPath = join(process.cwd(), '.kiro', 'agents', `${parsed.agent}.json`);
  if (process.env.FAKE_KIRO_OBSERVE) {
    const agentSha = existsSync(agentPath) ? createHash('sha256').update(readFileSync(agentPath)).digest('hex') : null;
    writeFileSync(
      process.env.FAKE_KIRO_OBSERVE,
      JSON.stringify({ argv: process.argv.slice(2), envNames: Object.keys(process.env).sort(), cwd: process.cwd(), agentSha }),
    );
  }
  if (!existsSync(agentPath)) fail(4, `agent "${parsed.agent}" not found`);
  let agent;
  try {
    agent = JSON.parse(readFileSync(agentPath, 'utf8'));
  } catch {
    fail(4, 'agent config is not valid JSON');
  }
  const fixture = findFixture(process.env.FAKE_KIRO_FIXTURE);
  if (!fixture) fail(2, `error: unknown fixture "${basename(process.env.FAKE_KIRO_FIXTURE ?? '')}"`);
  if (fixture.mode === 'replay') await runReplay(fixture, Number(process.env.FAKE_KIRO_LINE_DELAY_MS ?? 0));
  await runScript(JSON.parse(readFileSync(fixture.path, 'utf8')), agent);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => fail(1, 'fake-kiro-cli: internal error'));
}
