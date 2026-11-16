import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFakeKiroFixer, type FixerObserved } from '../../../../tools/fake-kiro-cli/fixer-wrapper.mjs';
import { FIX_ENV_NAMES, fixerPrompt } from './fix-env.js';
import { FixerWorkdir, exportPathsOf, type FixerFolders } from './fixer-workdir.js';
import { haltText, startFixer, type FixerRunResult } from './fixer-process.js';
import { GitClient } from './git-client.js';
import { DUMMY_GITHUB_TOKEN } from '../../test/support/fix.js';
import { HEALTHY_CHARGE, makeLabRepo, type LabRepo } from '../../test/support/lab-repo.js';

const CFG = { model: 'claude-sonnet-5.5', creditCap: 1.5, timeoutMs: 20_000, maxToolCalls: 30 };
const ID = 'cmprop0000000000000000002';

describe('the fixer process, with the fake kiro-cli fixer', () => {
  let lab: LabRepo;
  let tmp: string;
  let wd: FixerWorkdir;
  let tar: Buffer;
  const cleanups: Array<() => void> = [];

  beforeAll(async () => {
    lab = makeLabRepo();
    tmp = mkdtempSync(join(tmpdir(), 'fixer-process-'));
    wd = new FixerWorkdir(join(tmp, 'fix'));
    await wd.prepareRoot();
    const git = new GitClient({ gitPath: '/usr/bin/git', repo: 'o/n', token: null, remoteUrl: () => `file://${lab.remote}`, allowFileProtocol: true, home: tmp });
    await git.ensureMirror(join(tmp, 'm.git'));
    tar = await git.archive(join(tmp, 'm.git'), lab.base, exportPathsOf('payments'));
  });
  afterAll(async () => {
    await wd.remove(ID);
    for (const c of cleanups) c();
    lab.cleanup();
    rmSync(tmp, { recursive: true, force: true });
  });

  async function run(fixture: string, over: Partial<typeof CFG> = {}, extra: { pids?: Array<[string, string, number | null]>; stream?: string } = {}): Promise<{ result: FixerRunResult; f: FixerFolders; observed: FixerObserved }> {
    const fake = createFakeKiroFixer({ fixture, observe: true });
    cleanups.push(fake.cleanup);
    const f = await wd.create(ID, 'payments', tar);
    const files = await wd.fileList(f.work);
    const handle = startFixer({
      proposalId: ID,
      folder: f.work,
      prompt: fixerPrompt({ service: 'payments', deployId: 'd-7', sha: lab.culprit, summary: 'The guard was removed.', fixHint: 'Restore it.', files, diff: '-  if (!order) return 0;\n' }),
      cfg: { ...CFG, ...over },
      kiroCliPath: fake.path,
      parentEnv: { HOME: tmp, LANG: 'en_US.UTF-8', GITHUB_TOKEN: DUMMY_GITHUB_TOKEN, CHAOS_TOKEN: 'secret-chaos-token-0123456789' },
      pids: extra.pids === undefined ? undefined : { write: async (id, pid) => void extra.pids?.push(['write', id, pid]), remove: async (id) => void extra.pids?.push(['remove', id, null]) },
      stream: extra.stream === undefined ? undefined : { path: extra.stream, secrets: [DUMMY_GITHUB_TOKEN] },
    });
    const result = await handle.result;
    const observed = existsSync(fake.observePath) ? (JSON.parse(readFileSync(fake.observePath, 'utf8')) as FixerObserved) : ({ argv: [], envNames: [], cwd: '', agentSha: null, files: [], hasGit: false } as FixerObserved);
    return { result, f, observed };
  }
  const written = (f: FixerFolders): string => readFileSync(join(f.work, 'services/payments/src/charge.js'), 'utf8');

  it('runs a good fix: the file is changed in the folder, the run finished, the Credits are the report', async () => {
    const { result, f, observed } = await run('fixer-good');
    expect(result).toMatchObject({ started: true, finished: true, aiFailReason: null, stopDetail: null, halt: null, credits: 0.6, creditsEstimated: false, toolCalls: 2, writes: 1 });
    expect(written(f)).toBe(HEALTHY_CHARGE);
    // The export is untouched, and the process saw a folder with no .git, the agent copy and the allowed environment only.
    expect(readFileSync(join(f.exportDir, 'services/payments/src/charge.js'), 'utf8')).not.toBe(HEALTHY_CHARGE);
    expect(observed.hasGit).toBe(false);
    expect(observed.cwd.endsWith(`/fixer/${ID}/work`) || observed.cwd.endsWith(`fixer/${ID}/work`)).toBe(true);
    expect(observed.envNames.filter((n) => (FIX_ENV_NAMES as readonly string[]).includes(n)).sort()).toEqual([...FIX_ENV_NAMES].sort());
    expect(observed.envNames).not.toContain('GITHUB_TOKEN');
    expect(observed.envNames).not.toContain('CHAOS_TOKEN');
    expect(observed.argv).toContain('--trust-tools=fs_read,fs_write');
    expect(observed.argv).not.toContain('--require-mcp-startup');
    expect(observed.agentSha).not.toBeNull();
    expect(await wd.agentIntact(f.work)).toBe(true);
    await wd.remove(ID);
  });

  it('accepts the Tool Call wrapper and updates with title null (the shapes of kiro-cli 3.3.0)', async () => {
    const { result, f } = await run('fixer-wrapped');
    expect(result).toMatchObject({ started: true, finished: true, aiFailReason: null, toolCalls: 2 });
    expect(written(f)).toBe(HEALTHY_CHARGE);
    await wd.remove(ID);
  });

  it('stops at a foreign tool call and names it, and a stopped run is charged the cap when no report came', async () => {
    const { result } = await run('fixer-foreign-tool');
    expect(result).toMatchObject({ started: true, finished: false, aiFailReason: 'agent_failed', credits: 1.5, creditsEstimated: true, toolCalls: 1, halt: { code: 'foreign_tool' } });
    expect(result.stopDetail).toMatch(/^execute_bash kind=other keys=\[/);
    await wd.remove(ID);
  });

  it('stops when a path leaves the folder, relative or absolute', async () => {
    for (const fixture of ['fixer-path-escape', 'fixer-path-absolute']) {
      const { result, f } = await run(fixture);
      expect(result, fixture).toMatchObject({ finished: false, aiFailReason: 'agent_failed', creditsEstimated: true });
      expect(result.stopDetail).toContain('path outside the folder');
      expect(result.halt?.code, fixture).toBe('path_outside');
      // The key set is named, never the path.
      expect(result.halt?.detail).toMatch(/keys=\[command,file_text,path\]/);
      expect(result.halt?.detail).not.toContain('/etc');
      // The fake only announces the escaping call; nothing was written outside the folder.
      expect(existsSync(join(tmp, 'escape.txt')), fixture).toBe(false);
      expect(existsSync(join(f.base, '..', '..', 'escape.txt')), fixture).toBe(false);
      await wd.remove(ID);
    }
  });

  it('refuses an update that gives an accepted call id the input of another tool (its title is not what decides)', async () => {
    const { result, f } = await run('fixer-reuse-id');
    expect(result).toMatchObject({ finished: false, aiFailReason: 'agent_failed', halt: { code: 'unknown_args' } });
    expect(result.stopDetail).toBe('fs_read arguments not understood: unknown key command kind=none keys=[command]');
    expect(f.work).toContain(ID);
    await wd.remove(ID);
  });

  it('ends a run that is too long as a timeout, group killed, charged the cap', async () => {
    const { result } = await run('fixer-timeout', { timeoutMs: 1200 });
    expect(result).toMatchObject({ started: true, finished: false, aiFailReason: 'timeout', stopDetail: 'timeout', credits: 1.5, creditsEstimated: true, halt: { code: 'timeout' } });
    await wd.remove(ID);
  }, 15_000);

  it('stops when the Credits reach the cap, and when there are too many tool calls', async () => {
    const over = await run('fixer-over-cap');
    expect(over.result).toMatchObject({ finished: false, aiFailReason: 'agent_failed', stopDetail: 'credit cap', credits: 2, creditsEstimated: false, halt: { code: 'credit_cap' } });
    await wd.remove(ID);
    const many = await run('fixer-tool-limit', { maxToolCalls: 30 });
    expect(many.result).toMatchObject({ finished: false, aiFailReason: 'agent_failed', stopDetail: 'tool call limit', toolCalls: 31, halt: { code: 'tool_limit' } });
    await wd.remove(ID);
  });

  it('charges the cap to a finished run that sent no Credits report, and counts a failed exit as agent_failed', async () => {
    const noReport = await run('fixer-no-credits');
    expect(noReport.result).toMatchObject({ finished: true, aiFailReason: null, credits: 1.5, creditsEstimated: true });
    await wd.remove(ID);
    const failed = await run('fixer-fail-exit');
    expect(failed.result).toMatchObject({ finished: false, aiFailReason: 'agent_failed', stopDetail: 'exit 1', creditsEstimated: true, halt: { code: 'exit_code', detail: 'exit 1' } });
    await wd.remove(ID);
  });

  it('charges nothing for a process that never started', async () => {
    const f = await wd.create(ID, 'payments', tar);
    const handle = startFixer({ proposalId: ID, folder: f.work, prompt: 'x', cfg: CFG, kiroCliPath: join(tmp, 'no-such-kiro-cli'), parentEnv: {} });
    expect(await handle.result).toMatchObject({ started: false, finished: false, aiFailReason: 'agent_failed', credits: 0, creditsEstimated: false, toolCalls: 0, halt: { code: 'not_started' } });
    await wd.remove(ID);
  });

  it('writes the pid note when the process starts and removes it when it ends', async () => {
    const pids: Array<[string, string, number | null]> = [];
    await run('fixer-good', {}, { pids });
    expect(pids.map((p) => p[0])).toEqual(['write', 'remove']);
    expect(pids[0]?.[1]).toBe(ID);
    expect(typeof pids[0]?.[2]).toBe('number');
    await wd.remove(ID);
  });

  it('stops a running fixer on request (the Kill switch)', async () => {
    const fake = createFakeKiroFixer({ fixture: 'fixer-timeout' });
    cleanups.push(fake.cleanup);
    const f = await wd.create(ID, 'payments', tar);
    const handle = startFixer({ proposalId: ID, folder: f.work, prompt: 'x', cfg: { ...CFG, timeoutMs: 60_000 }, kiroCliPath: fake.path, parentEnv: { HOME: tmp } });
    await new Promise((r) => setTimeout(r, 400));
    handle.stop('disabled');
    expect(await handle.result).toMatchObject({ finished: false, aiFailReason: 'agent_failed', stopDetail: 'disabled', creditsEstimated: true, halt: { code: 'stopped', detail: 'disabled' } });
    await wd.remove(ID);
  }, 15_000);
  it('stops a stream with too many malformed lines (stream_malformed)', async () => {
    const { result } = await run('fixer-malformed');
    expect(result).toMatchObject({ finished: false, aiFailReason: 'agent_failed', halt: { code: 'stream_malformed' } });
    await wd.remove(ID);
  });
  it('stops at one oversized line (a Write File with an absolute path hidden past the 1 MiB cap)', async () => {
    const { result } = await run('fixer-oversized');
    expect(result).toMatchObject({ finished: false, aiFailReason: 'agent_failed', halt: { code: 'stream_malformed' } });
    await wd.remove(ID);
  });

  it('stops a file tool call that completes with arguments never seen (unjudged_input)', async () => {
    const { result } = await run('fixer-no-input');
    expect(result).toMatchObject({ finished: false, aiFailReason: 'agent_failed', halt: { code: 'unjudged_input' } });
    expect(result.halt?.detail).toMatch(/^fs_write ran \(completed\) with arguments never seen kind=none keys=none$/);
    await wd.remove(ID);
  });

  it('stops a file tool call whose arguments it does not know (unknown_args), and names the keys only', async () => {
    const { result } = await run('fixer-unknown-args');
    expect(result).toMatchObject({ finished: false, aiFailReason: 'agent_failed', halt: { code: 'unknown_args' } });
    expect(result.halt?.detail).toContain('fs_write arguments not understood');
    expect(result.halt?.detail).toContain('keys=[command,mode,path]');
    expect(result.halt?.detail).not.toContain('charge.js');
    await wd.remove(ID);
  });
  it('finishes a fix whose titles start with `Running: ` and whose inputs carry the purpose key, and keeps that text out of the stream file', async () => {
    const path = join(tmp, 'running.fixer.stream.jsonl');
    const { result, f } = await run('fixer-running-title', {}, { stream: path });
    expect(result).toMatchObject({ started: true, finished: true, aiFailReason: null, halt: null, toolCalls: 2, writes: 1 });
    expect(written(f)).toBe(HEALTHY_CHARGE);
    expect(readFileSync(path, 'utf8')).toContain('Running: Editing charge.js');
    expect(readFileSync(path, 'utf8')).not.toContain('__tool_use_purpose');
    await wd.remove(ID);
  });
  it('stops a `Running: ` call that names an MCP server, as foreign_tool', async () => {
    const { result } = await run('fixer-running-wrong-server');
    expect(result).toMatchObject({ finished: false, aiFailReason: 'agent_failed', halt: { code: 'foreign_tool' } });
    expect(result.halt?.detail).toMatch(/^mcpServerName=other /);
    await wd.remove(ID);
  });
  it('stops at an update of a call that was never announced (unknown_update)', async () => {
    const { result } = await run('fixer-orphan-update');
    expect(result).toMatchObject({ finished: false, aiFailReason: 'agent_failed', halt: { code: 'unknown_update' } });
    await wd.remove(ID);
  });
  it('counts a finished run with no fs_write call (the runner names it no_write)', async () => {
    const { result } = await run('fixer-no-change');
    expect(result).toMatchObject({ finished: true, halt: null, writes: 0 });
    await wd.remove(ID);
  });
  it('keeps the reduced stream of the run in a 0600 file, with no agent text and no secret', async () => {
    const path = join(tmp, 'streams-test', `${ID}.fixer.stream.jsonl`);
    mkdirSync(dirname(path), { recursive: true });
    await run('fixer-foreign-tool', {}, { stream: path });
    const text = readFileSync(path, 'utf8');
    const lines = text.trim().split('\n').map((l) => JSON.parse(l) as { type: string; data: { update?: { sessionUpdate?: string; title?: string } } });
    expect(lines.some((l) => l.data.update?.sessionUpdate === 'tool_call' && l.data.update.title === 'execute_bash')).toBe(true);
    expect(text).not.toContain('agent_message_chunk');
    expect(text).not.toContain(DUMMY_GITHUB_TOKEN);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    await wd.remove(ID);
  });
  it('writes every halt as one bounded line', () => {
    expect(haltText({ code: 'exit_code', detail: 'exit 1' })).toBe('exit_code: exit 1');
    expect(haltText({ code: 'foreign_tool', detail: `x\u0007${'y'.repeat(400)}` })).toHaveLength(300);
    expect(haltText({ code: 'foreign_tool', detail: 'a\nb' })).toBe('foreign_tool: a b');
  });
});
