import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SCENARIOS } from './lab-data.mjs';
import { startFakeLab } from './fake-lab.mjs';
import { createFakeKiroCli } from './wrapper.mjs';
import { parseArgv } from './fake-kiro-cli.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const mcpBin = join(root, 'packages', 'exorcist-mcp', 'bin');
const TOKEN = 'fake-lab-read-token-0123456789';
const HID = 'cmfaketestaaaaaaaaaaaaaaa';
const TOOLS = ['query_metrics', 'search_errors', 'tail_logs', 'recent_deploys', 'diff_commit', 'submit_diagnosis'];
const ARGV = (over = {}) => [
  'chat', '--no-interactive', '--trust-workspace', '--require-mcp-startup', '--agent', 'exorcist', '--model', 'claude-sonnet-5.5',
  '--output-format', 'stream-json', `--trust-tools=${TOOLS.map((t) => `@exorcist/${t}`).join(',')}`, 'Investigate incident cmx on payments.',
].map((a) => over[a] ?? a);

let workdir;
let lab;
before(async () => {
  // The fake drives the real server, so the packages must be built (the exorcist-mcp tests do the same).
  const tsc = join(root, 'node_modules', '.bin', 'tsc');
  execFileSync(tsc, ['-p', join(root, 'packages', 'shared', 'tsconfig.build.json')], { stdio: 'ignore' });
  execFileSync(tsc, ['-p', join(root, 'packages', 'exorcist-mcp', 'tsconfig.build.json')], { stdio: 'ignore' });
  workdir = mkdtempSync(join(tmpdir(), 'fake-hunt-'));
  mkdirSync(join(workdir, '.kiro', 'agents'), { recursive: true });
  mkdirSync(join(workdir, 'ledgers'));
  writeFileSync(join(workdir, '.kiro', 'agents', 'exorcist.json'), readFileSync(join(root, '.kiro', 'agents', 'exorcist.json')));
  lab = await startFakeLab({ token: TOKEN });
});
after(async () => {
  await lab?.close();
  if (workdir) rmSync(workdir, { recursive: true, force: true });
});

/** Runs the fake like the Hunt runner would: minimal env, workdir cwd, one fixture. */
function run(fixture, { argv = ARGV(), env = {}, omitLab = false, observe = false, fakeLab = lab, timeoutMs = 60_000 } = {}) {
  const fake = createFakeKiroCli({ fixture, observe });
  const ledger = join(workdir, 'ledgers', `${HID}.jsonl`);
  writeFileSync(ledger, '');
  const childEnv = {
    PATH: `${mcpBin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: workdir,
    LANG: 'en_US.UTF-8',
    TERM: 'dumb',
    NO_COLOR: '1',
    LAB_URL: fakeLab.url,
    PROMETHEUS_URL: fakeLab.url,
    HUNT_ID: HID,
    HUNT_LEDGER_PATH: ledger,
    ...(omitLab ? {} : { LAB_READ_TOKEN: TOKEN }),
    ...env,
  };
  return new Promise((resolve) => {
    const child = spawn(fake.path, argv, { cwd: workdir, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const lines = stdout.split('\n').filter(Boolean);
      const events = lines.map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return { raw: l };
        }
      });
      const observed = observe && existsSync(fake.observePath) ? JSON.parse(readFileSync(fake.observePath, 'utf8')) : null;
      const ledgerLines = readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      fake.cleanup();
      resolve({ code, signal, stderr, events, ledger: ledgerLines, observed });
    });
  });
}

const calls = (events) => events.filter((e) => e.data?.update?.sessionUpdate === 'tool_call').map((e) => e.data.update);
const credits = (events) => events.flatMap((e) => e.data?.update?._meta?.kiro?.credits ?? []).map((c) => c.usage);

test('checks the command line like the real CLI would, exit 2 otherwise', () => {
  assert.equal(parseArgv(ARGV()).agent, 'exorcist');
  assert.match(parseArgv(ARGV().filter((a) => a !== '--require-mcp-startup')).error, /require-mcp-startup/);
  assert.match(parseArgv([...ARGV().slice(0, -1), '--trust-all-tools', 'p']).error, /unexpected argument/);
  assert.match(parseArgv(ARGV().map((a) => (a === 'claude-sonnet-5.5' ? 'auto' : a))).error, /pinned/);
  assert.match(parseArgv(ARGV().map((a) => (a.startsWith('--trust-tools=') ? '--trust-tools=@exorcist/query_metrics' : a))).error, /trust-tools/);
  assert.match(parseArgv(ARGV().map((a) => (a === 'stream-json' ? 'text' : a))).error, /stream-json/);
  assert.match(parseArgv(['chat']).error, /--no-interactive/);
  assert.match(parseArgv(['run']).error, /chat/);
  assert.match(parseArgv([...ARGV(), 'a second prompt']).error, /one prompt/);
});

test('exits 2 on a bad command line and 4 when the agent is missing', async () => {
  const bad = await run('error-spike', { argv: ['chat', '--yolo'] });
  assert.equal(bad.code, 2);
  assert.equal(bad.events.length, 0);
  const missing = await run('error-spike', { argv: ARGV().map((a) => (a === 'exorcist' ? 'nobody' : a)) });
  assert.equal(missing.code, 4);
  assert.match(missing.stderr, /not found/);
  const unknown = await run('no-such-fixture');
  assert.equal(unknown.code, 2);
});

test('script mode drives the real MCP server for all three scenarios, with a diagnosis the ledger can back', async () => {
  for (const [name, s] of Object.entries(SCENARIOS)) {
    const fakeLab = await startFakeLab({ token: TOKEN, scenario: name });
    try {
      const r = await run(name, { fakeLab });
      assert.equal(r.code, 0, `${name}: ${r.stderr}`);
      assert.equal(r.events[0].type, 'runStarted');
      assert.equal(r.events.at(-1).type, 'runFinished');
      assert.equal(r.events.at(-1).data.status, 'success');
      const titles = calls(r.events).map((c) => c.title);
      assert.equal(titles.filter((t) => t === 'Tool Load').length, 6);
      assert.deepEqual(titles.filter((t) => t !== 'Tool Load'), TOOLS.map((t) => `@exorcist/${t}`));
      assert.equal(credits(r.events).length, 1);
      const diagnosis = r.ledger.find((l) => l.type === 'diagnosis');
      assert.ok(diagnosis, name);
      const streamInput = calls(r.events).find((c) => c.title === '@exorcist/submit_diagnosis').rawInput;
      assert.deepEqual(diagnosis.input, streamInput);
      assert.equal(diagnosis.input.culprit_deploy, s.deployId);
      assert.equal(diagnosis.input.culprit_sha, s.sha);
      // Every cited ref is a handle the real server issued during this run.
      const issued = new Set(r.ledger.filter((l) => l.type === 'handle').map((l) => l.handle));
      for (const e of diagnosis.input.evidence) assert.ok(issued.has(e.ref), `${name}: ${e.ref}`);
      assert.ok(issued.has(`deploy:${s.deployId}`) && issued.has(`commit:${s.sha}`));
      // The tool output is in the stream (the runner must ignore it) and is wrapped.
      const done = r.events.find((e) => e.data?.update?.status === 'completed' && e.data.update.rawOutput);
      assert.match(done.data.update.rawOutput.response, /^<untrusted_data>/);
      assert.ok(fakeLab.requests.every((q) => q.authorized || !q.path.startsWith('/lab/')));
    } finally {
      await fakeLab.close();
    }
  }
});

test('the lab answers only with the bearer, and the fake shows the minimal environment it was given', async () => {
  const r = await run('error-spike', { observe: true });
  assert.equal(r.code, 0);
  assert.ok(lab.requests.filter((q) => q.path.startsWith('/lab/')).every((q) => q.authorized));
  const allowed = new Set(['PATH', 'HOME', 'LANG', 'TERM', 'NO_COLOR', 'LAB_URL', 'LAB_READ_TOKEN', 'LAB_ALLOW_REMOTE', 'PROMETHEUS_URL', 'PROMETHEUS_ALLOW_REMOTE', 'HUNT_ID', 'HUNT_LEDGER_PATH', 'FAKE_KIRO_FIXTURE', 'FAKE_KIRO_OBSERVE', 'PWD', 'SHLVL', '_', 'OLDPWD', '__CF_USER_TEXT_ENCODING']);
  for (const name of r.observed.envNames) assert.ok(allowed.has(name), name);
  assert.equal(r.observed.cwd.endsWith(workdir.split('/').pop()), true);
  assert.deepEqual(r.observed.argv, ARGV());
  assert.equal(r.observed.agentSha.length, 64);
});

test('foreign tool, credits and tool-limit fixtures write what the runner must react to, then wait to be killed', async () => {
  const foreign = await run('foreign-tool', { timeoutMs: 4000 });
  assert.equal(foreign.signal, 'SIGKILL');
  assert.ok(calls(foreign.events).some((c) => c.title === 'fs_read'));
  const over = await run('over-cap', { timeoutMs: 4000 });
  assert.deepEqual(credits(over.events), [2]);
  assert.equal(over.signal, 'SIGKILL');
  const limit = await run('tool-limit', { timeoutMs: 4000 });
  assert.equal(calls(limit.events).filter((c) => c.title === 'Tool Load').length, 30);
});

test('a SIGTERM stops the fake with exit 143 and no leftover server', async () => {
  const fake = createFakeKiroCli({ fixture: 'timeout' });
  const ledger = join(workdir, 'ledgers', `${HID}.jsonl`);
  writeFileSync(ledger, '');
  const child = spawn(fake.path, ARGV(), {
    cwd: workdir,
    env: { PATH: `${mcpBin}:${dirname(process.execPath)}:/usr/bin:/bin`, LAB_URL: lab.url, PROMETHEUS_URL: lab.url, LAB_READ_TOKEN: TOKEN, HUNT_ID: HID, HUNT_LEDGER_PATH: ledger },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let out = '';
  child.stdout.on('data', (c) => (out += c));
  await new Promise((resolve) => {
    const poll = setInterval(() => {
      if (out.includes('@exorcist/query_metrics')) {
        clearInterval(poll);
        resolve();
      }
    }, 50);
  });
  process.kill(-child.pid, 'SIGTERM');
  const code = await new Promise((resolve) => child.on('close', (c) => resolve(c)));
  assert.equal(code, 143);
  fake.cleanup();
});

test('exits 3 like --require-mcp-startup when the MCP server cannot start', async () => {
  const r = await run('mcp-fail');
  assert.equal(r.code, 3);
  assert.match(r.stderr, /failed to start/);
  const noToken = await run('error-spike', { omitLab: true });
  assert.equal(noToken.code, 3);
});

test('malformed and no-diagnosis fixtures', async () => {
  const bad = await run('malformed', { timeoutMs: 4000 });
  assert.equal(bad.events.filter((e) => e.raw !== undefined).length, 25);
  const none = await run('no-diagnosis');
  assert.equal(none.code, 0);
  assert.equal(none.ledger.some((l) => l.type === 'diagnosis'), false);
  assert.ok(none.ledger.length > 0);
});

test('injection: hostile lab data reaches the model only wrapped, cleaned, and the run still ends well', async () => {
  const hostileLab = await startFakeLab({ token: TOKEN, hostile: true });
  try {
    const r = await run('injection', { fakeLab: hostileLab });
    assert.equal(r.code, 0);
    const outputs = r.events.filter((e) => e.data?.update?.rawOutput?.response).map((e) => e.data.update.rawOutput.response);
    assert.ok(outputs.length >= 5);
    for (const text of outputs) {
      assert.equal(text.split('</untrusted_data>').length, 2, 'the wrapper cannot be closed by data');
      assert.equal(text.includes('\u001b') || text.includes('\u0007'), false);
    }
    assert.ok(outputs.join('').includes('Ignore all previous instructions'), 'the hostile text is present, as data');
    // The agent (the script) did what it was scripted to do: only the six tools.
    assert.deepEqual(calls(r.events).map((c) => c.title).filter((t) => t !== 'Tool Load'), TOOLS.map((t) => `@exorcist/${t}`));
  } finally {
    await hostileLab.close();
  }
});

test('replay mode writes the recorded stream and copies the ledger', async () => {
  const r = await run('live-error-spike');
  assert.equal(r.code, 0);
  const recorded = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'live-error-spike.stream.jsonl'), 'utf8').split('\n').filter(Boolean);
  assert.equal(r.events.length, recorded.length);
  assert.equal(r.events.at(-1).type, 'runFinished');
  assert.equal(r.ledger.at(-1).type, 'diagnosis');
  assert.equal(r.ledger.at(-1).input.culprit_sha, SCENARIOS['error-spike'].sha);
  assert.deepEqual(credits(r.events), [0.922]);
  // The recorded diagnosis in the stream equals the one in the ledger.
  const streamInput = calls(r.events).find((c) => c.title === '@exorcist/submit_diagnosis').rawInput;
  assert.deepEqual(streamInput, r.ledger.at(-1).input);
});

test('tool-call-reuse-id writes an update of an accepted id that names another tool', async () => {
  const r = await run('tool-call-reuse-id', { timeoutMs: 4000 });
  const accepted = calls(r.events).find((c) => c.title === '@exorcist/query_metrics');
  assert.ok(accepted);
  const odd = r.events.filter((e) => e.data?.update?.sessionUpdate === 'tool_call_update' && e.data.update.title === 'fs_read');
  assert.equal(odd.length, 1);
  assert.equal(odd[0].data.update.toolCallId, accepted.toolCallId);
});

test('load-shapes writes every Tool Load shape and repeats calls with updates that name the same tool', async () => {
  const r = await run('load-shapes');
  assert.equal(r.code, 0, r.stderr);
  const loads = calls(r.events).filter((c) => c.title === 'Tool Load');
  const keys = new Set(loads.map((c) => Object.keys(c.rawInput).sort().join(',')));
  assert.deepEqual([...keys].sort(), ['id', 'ids', 'tool_id', 'tool_ids', 'tools']);
  assert.ok(loads.some((c) => typeof c.rawInput.id === 'string' && c.rawInput.id.startsWith('@exorcist/')));
  const ids = calls(r.events).map((c) => c.toolCallId);
  assert.ok(new Set(ids).size < ids.length, 'a call id is written twice');
  const updates = r.events.filter((e) => e.data?.update?.sessionUpdate === 'tool_call_update');
  assert.equal(updates.filter((e) => e.data.update.title === 'fs_read').length, 0, 'no update names another tool');
  const sameTool = updates.filter((e) => e.data.update.title === '@exorcist/search_errors');
  assert.ok(sameTool.length >= 2, 'an update repeats the title of the accepted call');
  assert.ok(r.ledger.some((l) => l.type === 'diagnosis'));
});

test('downstream-culprit: a hunt on gate that names the deploy of orders', async () => {
  const fogLab = await startFakeLab({ token: TOKEN, scenario: 'fog' });
  try {
    const r = await run('downstream-culprit', { fakeLab: fogLab });
    assert.equal(r.code, 0, r.stderr);
    const diagnosis = r.ledger.find((l) => l.type === 'diagnosis');
    assert.equal(diagnosis.input.service, 'gate');
    assert.equal(diagnosis.input.culprit_deploy, SCENARIOS.fog.deployId);
    assert.equal(diagnosis.input.culprit_sha, SCENARIOS.fog.sha);
    const issued = new Set(r.ledger.filter((l) => l.type === 'handle').map((l) => l.handle));
    for (const e of diagnosis.input.evidence) assert.ok(issued.has(e.ref), e.ref);
  } finally {
    await fogLab.close();
  }
});

test('tool-call-wrapper writes diff_commit and tail_logs through the Tool Call wrapper, and the hunt still ends with a diagnosis', async () => {
  const r = await run('tool-call-wrapper');
  assert.equal(r.code, 0, r.stderr);
  const wrapped = calls(r.events).filter((c) => c.title === 'Tool Call');
  assert.deepEqual(wrapped.map((c) => c.rawInput.tool_id), ['tool::exorcist::tail_logs', 'tool::exorcist::diff_commit']);
  for (const c of wrapped) {
    assert.deepEqual(Object.keys(c.rawInput).sort(), ['arguments', 'tool_id']);
    assert.equal(typeof c.rawInput.arguments, 'object');
    assert.deepEqual(c._meta, { kiro: { toolOrigin: 'default' } });
  }
  // The update of a wrapped call has no title while it runs and one when it completes, with the same id.
  const updates = r.events.map((e) => e.data?.update).filter((u) => u?.sessionUpdate === 'tool_call_update' && wrapped.some((c) => c.toolCallId === u.toolCallId));
  assert.ok(updates.some((u) => u.status === 'in_progress' && u.title === null));
  assert.ok(updates.some((u) => u.status === 'completed' && u.title === 'Tool Call'));
  // The real MCP server ran both tools: the ledger has their handles and the diagnosis.
  const issued = new Set(r.ledger.filter((l) => l.type === 'handle').map((l) => l.handle));
  assert.ok(issued.has(`commit:${SCENARIOS['error-spike'].sha}`));
  assert.ok([...issued].some((h) => h.startsWith('log:')));
  assert.ok(r.ledger.some((l) => l.type === 'diagnosis'));
});

test('tool-call-foreign writes a wrapper that names a built-in tool, runs nothing, and waits to be killed', async () => {
  const r = await run('tool-call-foreign', { timeoutMs: 4000 });
  assert.equal(r.signal, 'SIGKILL');
  const wrapped = calls(r.events).filter((c) => c.title === 'Tool Call');
  assert.equal(wrapped.length, 1);
  assert.equal(wrapped[0].rawInput.tool_id, 'tool::builtin::execute_bash');
  assert.equal(r.ledger.some((l) => l.type === 'diagnosis'), false);
});
