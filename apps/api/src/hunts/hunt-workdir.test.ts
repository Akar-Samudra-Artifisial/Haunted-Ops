import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HuntWorkdir, WORKDIR_MARKER, WorkdirError, defaultAgentSource } from './hunt-workdir.js';

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'hunt-workdir-'));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

let n = 0;
const fresh = (): string => join(root, `w${++n}`);
const agent = (): string => join(root, 'agent.json');
const refusal = async (w: HuntWorkdir): Promise<string> => {
  try {
    await w.prepare();
  } catch (err) {
    if (err instanceof WorkdirError) return err.reason;
    throw err;
  }
  return 'ok';
};

describe('HuntWorkdir', () => {
  it('makes a private folder with only the agent copy and a ledgers folder', async () => {
    writeFileSync(agent(), '{"name":"exorcist"}\n');
    const dir = fresh();
    const w = new HuntWorkdir(dir, agent());
    await w.prepare();
    expect(readdirSync(w.path).sort()).toEqual(['.haunted-ops-workdir', '.kiro', 'ledgers']);
    expect(readdirSync(join(w.path, '.kiro'))).toEqual(['agents']);
    expect(readdirSync(join(w.path, '.kiro', 'agents'))).toEqual(['exorcist.json']);
    expect(statSync(w.path).mode & 0o777).toBe(0o700);
    expect(await w.agentIsIntact()).toBe(true);
  });

  it('copies the committed agent config byte for byte', async () => {
    const dir = fresh();
    const w = new HuntWorkdir(dir);
    await w.prepare();
    expect(readFileSync(join(w.path, '.kiro', 'agents', 'exorcist.json'))).toEqual(readFileSync(defaultAgentSource()));
    expect(readFileSync(defaultAgentSource(), 'utf8')).not.toContain('fs_read');
  });

  it('notices when kiro-cli rewrites the copy, and prepares it again', async () => {
    const w = new HuntWorkdir(fresh(), agent());
    await w.prepare();
    writeFileSync(join(w.path, '.kiro', 'agents', 'exorcist.json'), '{"changed":true}');
    expect(await w.agentIsIntact()).toBe(false);
    await w.prepare();
    expect(await w.agentIsIntact()).toBe(true);
  });

  it('refuses a folder inside a git repository or under a steering folder', async () => {
    const repo = join(root, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    expect(await refusal(new HuntWorkdir(join(repo, 'a', 'b'), agent()))).toBe('inside_repository');
    const steered = join(root, 'steered');
    mkdirSync(join(steered, '.kiro', 'steering'), { recursive: true });
    expect(await refusal(new HuntWorkdir(join(steered, 'x'), agent()))).toBe('has_steering');
    // A `.git` file (a worktree or submodule) counts too.
    const wt = join(root, 'wt');
    mkdirSync(wt);
    writeFileSync(join(wt, '.git'), 'gitdir: elsewhere\n');
    expect(await refusal(new HuntWorkdir(join(wt, 'x'), agent()))).toBe('inside_repository');
  });

  it('refuses to clean a folder it did not make, and cleans one it did', async () => {
    const foreign = fresh();
    mkdirSync(foreign);
    writeFileSync(join(foreign, 'precious.txt'), 'keep me');
    expect(await refusal(new HuntWorkdir(foreign, agent()))).toBe('not_ours');
    expect(readFileSync(join(foreign, 'precious.txt'), 'utf8')).toBe('keep me');
    expect(existsSync(join(foreign, WORKDIR_MARKER))).toBe(false);

    const ours = new HuntWorkdir(fresh(), agent());
    await ours.prepare();
    writeFileSync(join(ours.path, 'stray.txt'), 'x');
    mkdirSync(join(ours.path, 'old'));
    mkdirSync(join(ours.path, '.kiro', 'steering'), { recursive: true });
    writeFileSync(join(ours.path, '.kiro', 'agents', 'other.json'), '{}');
    writeFileSync(join(ours.path, 'ledgers', 'cmoldaaaaaaaaaaaaaaaaaaaa.jsonl'), 'old');
    await ours.prepare();
    expect(readdirSync(ours.path).sort()).toEqual(['.haunted-ops-workdir', '.kiro', 'ledgers']);
    expect(readdirSync(join(ours.path, '.kiro')).sort()).toEqual(['agents']);
    expect(readdirSync(join(ours.path, '.kiro', 'agents'))).toEqual(['exorcist.json']);
    expect(readdirSync(join(ours.path, 'ledgers'))).toEqual([]);
  });

  it('refuses when the committed agent config is missing', async () => {
    expect(await refusal(new HuntWorkdir(fresh(), join(root, 'no-such-agent.json')))).toBe('bad_agent');
  });

  it('makes private ledger files, reads and removes them, and takes only cuid hunt ids', async () => {
    const w = new HuntWorkdir(fresh(), agent());
    await w.prepare();
    const id = 'cmledgertestaaaaaaaaaaaaa';
    const path = await w.createLedger(id);
    expect(path).toBe(join(w.path, 'ledgers', `${id}.jsonl`));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    writeFileSync(path, '{"type":"handle"}\n');
    expect(await w.readLedger(id)).toBe('{"type":"handle"}\n');
    await w.removeLedger(id);
    expect(await w.readLedger(id)).toBe('');
    for (const bad of ['../x', 'x/y', '', 'UPPERCASEUPPERCASEUPPERC', 'short', 'cm id with space aaaaaaaa']) expect(() => w.ledgerPath(bad)).toThrow(WorkdirError);
  });
});

describe('HuntWorkdir: pid notes and leftover processes', () => {
  const ID_A = 'cmpidtestaaaaaaaaaaaaaaaa';
  const ID_B = 'cmpidtestbbbbbbbbbbbbbbbb';
  const quick = { sleep: () => Promise.resolve() };

  it('writes a private note with the pid and the process group, and removes it', async () => {
    const w = new HuntWorkdir(fresh(), agent());
    await w.prepare();
    await w.writePid(ID_A, 4321);
    expect(JSON.parse(readFileSync(w.pidPath(ID_A), 'utf8'))).toEqual({ pid: 4321, pgid: 4321 });
    expect(statSync(w.pidPath(ID_A)).mode & 0o777).toBe(0o600);
    await w.removePid(ID_A);
    expect(existsSync(w.pidPath(ID_A))).toBe(false);
    await w.removePid(ID_A);
    expect(() => w.pidPath('../x')).toThrow(WorkdirError);
  });

  it('kills the group of a note whose process still runs kiro-cli, then SIGKILLs a survivor, and deletes the notes', async () => {
    const dir = fresh();
    mkdirSync(dir, { recursive: true });
    const signals: Array<[number, string]> = [];
    const w = new HuntWorkdir(dir, agent(), {
      inspect: async (pid) => (pid === 4321 ? { pgid: 4321, command: '/opt/kiro/kiro-cli chat --no-interactive' } : null),
      killGroup: (pgid, signal) => void signals.push([pgid, signal]),
      ...quick,
    });
    await w.writePid(ID_A, 4321);
    await w.writePid(ID_B, 5555);
    expect(await w.reapOrphans()).toBe(1);
    // The group ignored the SIGTERM (it is still there), so it gets the SIGKILL; the other pid is gone.
    expect(signals).toEqual([[4321, 'SIGTERM'], [4321, 'SIGKILL']]);
    expect(readdirSync(dir).filter((n) => n.endsWith('.pid'))).toEqual([]);
  });

  it('never kills a pid that is not a kiro-cli process, has another group, or is a bad note', async () => {
    const dir = fresh();
    mkdirSync(dir, { recursive: true });
    const signals: Array<[number, string]> = [];
    const seen = new Map<number, { pgid: number; command: string }>([
      [4001, { pgid: 4001, command: '/bin/sleep 300' }],
      [4002, { pgid: 1, command: '/opt/kiro/kiro-cli chat' }],
      [4003, { pgid: 4003, command: 'node server.js' }],
    ]);
    const w = new HuntWorkdir(dir, agent(), { inspect: async (pid) => seen.get(pid) ?? null, killGroup: (pgid, signal) => void signals.push([pgid, signal]), ...quick });
    const ids = ['cmpidtestc1cccccccccccccc', 'cmpidtestc2cccccccccccccc', 'cmpidtestc3cccccccccccccc', 'cmpidtestc4cccccccccccccc', 'cmpidtestc5cccccccccccccc', 'cmpidtestc6cccccccccccccc'];
    writeFileSync(join(dir, `${ids[0]}.pid`), JSON.stringify({ pid: 4001, pgid: 4001 }));
    writeFileSync(join(dir, `${ids[1]}.pid`), JSON.stringify({ pid: 4002, pgid: 4002 }));
    writeFileSync(join(dir, `${ids[2]}.pid`), JSON.stringify({ pid: 4003, pgid: 4003 }));
    writeFileSync(join(dir, `${ids[3]}.pid`), '{torn');
    writeFileSync(join(dir, `${ids[4]}.pid`), JSON.stringify({ pid: 1, pgid: 1 }));
    writeFileSync(join(dir, `${ids[5]}.pid`), JSON.stringify({ pid: process.pid, pgid: process.pid }));
    expect(await w.reapOrphans()).toBe(0);
    expect(signals).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('does nothing when the folder does not exist', async () => {
    expect(await new HuntWorkdir(join(root, 'never-made'), agent(), quick).reapOrphans()).toBe(0);
  });

  it('kills a real leftover kiro-cli process group and leaves another process alone', async () => {
    const dir = fresh();
    mkdirSync(dir, { recursive: true });
    const orphan = spawn(process.execPath, ['-e', 'setTimeout(()=>{},300000)', 'kiro-cli-orphan'], { detached: true, stdio: 'ignore' });
    const bystander = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' });
    orphan.unref();
    bystander.unref();
    try {
      const w = new HuntWorkdir(dir, agent(), quick);
      await w.writePid(ID_A, orphan.pid as number);
      await w.writePid(ID_B, bystander.pid as number);
      // Wait until `ps` can see both command lines.
      await new Promise((r) => setTimeout(r, 300));
      expect(await w.reapOrphans()).toBe(1);
      await new Promise((r) => setTimeout(r, 300));
      expect(alive(orphan.pid as number)).toBe(false);
      expect(alive(bystander.pid as number)).toBe(true);
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      for (const p of [orphan, bystander]) {
        try {
          process.kill(-(p.pid as number), 'SIGKILL');
        } catch {
          // Already gone.
        }
      }
    }
  });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  // A killed child that nobody waits for stays a zombie until its parent (init) collects it; `ps` tells.
  const state = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
  return state !== '' && !state.startsWith('Z');
}
