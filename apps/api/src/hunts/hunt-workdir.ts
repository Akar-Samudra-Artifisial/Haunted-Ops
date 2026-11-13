import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CUID_PATTERN } from '@haunted-ops/shared';

/** Why a Hunt working directory was refused. Never carries a path. */
export class WorkdirError extends Error {
  constructor(readonly reason: 'inside_repository' | 'has_steering' | 'not_ours' | 'bad_agent' | 'bad_hunt_id') {
    super(`hunt working directory refused: ${reason}`);
    this.name = 'WorkdirError';
  }
}

/** The file that marks a folder as made by this module: only then may it be cleaned. */
export const WORKDIR_MARKER = '.haunted-ops-workdir';
const AGENT_REL = join('.kiro', 'agents', 'exorcist.json');
const KEEP = new Set(['.kiro', 'ledgers', WORKDIR_MARKER]);
/** The reduced stream of a Hunt, kept for a while so a failed live run can become a fixture. */
const STREAM_FILE = /^[a-z0-9]{20,32}\.stream\.jsonl$/;
/** How many stream files are kept. */
export const KEEP_STREAMS = 20;

/** The note of a running Hunt process: `{ pid, pgid }`, deleted when the Hunt ends. */
const PID_FILE = /^[a-z0-9]{20,32}\.pid$/;
/** Only a process whose command line has this in it is ever killed as a leftover. */
const KIRO_COMMAND = /kiro-cli/;
/** Time between the SIGTERM and the SIGKILL of a leftover group. */
export const REAP_GRACE_MS = 2000;

/** What a process id is now: its process group and its command line, or null when no such process runs. */
export type ProcessInspector = (pid: number) => Promise<{ pgid: number; command: string } | null>;

/** `ps -o pgid=,command= -p <pid>`, run with an argument array (no shell). */
export const psInspect: ProcessInspector = (pid) =>
  new Promise((resolve) => {
    execFile('ps', ['-o', 'pgid=,command=', '-p', String(pid)], { timeout: 5000 }, (err, stdout) => {
      const m = err ? null : /^\s*(\d+)\s+(.+)$/m.exec(stdout);
      resolve(m === null ? null : { pgid: Number(m[1]), command: m[2] as string });
    });
  });

/** Hooks of `reapOrphans`, so tests need no real leftover. */
export interface ReapHooks {
  inspect?: ProcessInspector;
  /** Sends a signal to a whole process group. */
  killGroup?: (pgid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
}

const exists = async (p: string): Promise<boolean> => stat(p).then(() => true, () => false);
const sha256 = async (p: string): Promise<string> => createHash('sha256').update(await readFile(p)).digest('hex');

/** The committed agent config, found from this file (`src/hunts` and `dist/hunts` are the same depth). */
export function defaultAgentSource(): string {
  return fileURLToPath(new URL('../../../../.kiro/agents/exorcist.json', import.meta.url));
}

/**
 * The working directory of Hunts: outside every git repository and every `.kiro/steering` folder,
 * holding only a byte-equal copy of the committed agent config and the Hunt ledgers. So the agent
 * sees no project steering, hooks or files, and a project cannot leak into a Hunt.
 */
export class HuntWorkdir {
  private root = '';

  constructor(
    private readonly dir: string,
    private readonly agentSource: string = defaultAgentSource(),
    private readonly hooks: ReapHooks = {},
  ) {}

  get path(): string {
    return this.root === '' ? this.dir : this.root;
  }

  /**
   * Makes the folder ready. It refuses a folder inside a git repository or under a steering folder,
   * and refuses to touch a folder that has files and was not made by this module. Throws `WorkdirError`.
   */
  async prepare(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    this.root = await realpath(this.dir);
    const marker = join(this.root, WORKDIR_MARKER);
    const ours = await exists(marker);
    await this.refuseProjectFolders(ours);
    const entries = await readdir(this.root);
    if (!ours) {
      if (entries.length > 0) throw new WorkdirError('not_ours');
      await writeFile(marker, 'made by haunted-ops; only the agent copy and the ledgers live here\n', { mode: 0o600 });
    }
    for (const name of entries) if (!KEEP.has(name) && !STREAM_FILE.test(name)) await rm(join(this.root, name), { recursive: true, force: true });
    // Only the agent copy under .kiro; nothing else of a former run.
    const kiro = join(this.root, '.kiro');
    await rm(kiro, { recursive: true, force: true });
    await mkdir(join(kiro, 'agents'), { recursive: true, mode: 0o700 });
    if (!(await exists(this.agentSource))) throw new WorkdirError('bad_agent');
    await copyFile(this.agentSource, join(this.root, AGENT_REL));
    // Ledgers of a run that crashed are gone: a new run never reads an old one.
    await rm(join(this.root, 'ledgers'), { recursive: true, force: true });
    await mkdir(join(this.root, 'ledgers'), { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700);
  }

  /**
   * Every folder above the working directory must be free of a git repository and of steering. The
   * working directory itself is checked too unless it is ours: a folder we made is cleaned, so
   * anything someone put in it is removed before a Hunt.
   */
  private async refuseProjectFolders(ours: boolean): Promise<void> {
    let at = ours ? dirname(this.root) : this.root;
    for (;;) {
      if (await exists(join(at, '.git'))) throw new WorkdirError('inside_repository');
      if (await exists(join(at, '.kiro', 'steering'))) throw new WorkdirError('has_steering');
      if (at === parse(at).root) break;
      at = dirname(at);
    }
  }

  /** Path of the ledger of a Hunt (the id is a cuid, so it is a safe file name). */
  ledgerPath(huntId: string): string {
    if (!CUID_PATTERN.test(huntId)) throw new WorkdirError('bad_hunt_id');
    return join(this.path, 'ledgers', `${huntId}.jsonl`);
  }

  /** Path of the reduced stream of a Hunt, `<workdir>/<huntId>.stream.jsonl`. */
  streamPath(huntId: string): string {
    if (!CUID_PATTERN.test(huntId)) throw new WorkdirError('bad_hunt_id');
    return join(this.path, `${huntId}.stream.jsonl`);
  }

  /** Deletes the oldest stream files so that at most `keep` remain. Never throws on a file that vanished. */
  async pruneStreams(keep: number = KEEP_STREAMS): Promise<void> {
    const names = (await readdir(this.path).catch(() => [] as string[])).filter((n) => STREAM_FILE.test(n));
    const dated = await Promise.all(names.map(async (n) => ({ n, t: (await stat(join(this.path, n)).catch(() => null))?.mtimeMs ?? 0 })));
    dated.sort((a, b) => b.t - a.t || (a.n < b.n ? 1 : -1));
    for (const old of dated.slice(Math.max(0, keep))) await rm(join(this.path, old.n), { force: true });
  }

  /** Path of the note of the process of a Hunt, `<workdir>/<huntId>.pid`. */
  pidPath(huntId: string): string {
    if (!CUID_PATTERN.test(huntId)) throw new WorkdirError('bad_hunt_id');
    return join(this.path, `${huntId}.pid`);
  }

  /** Notes the process of a Hunt (it is its own process group leader) so a crash of the API cannot leave it behind. */
  async writePid(huntId: string, pid: number): Promise<void> {
    await writeFile(this.pidPath(huntId), `${JSON.stringify({ pid, pgid: pid })}\n`, { mode: 0o600 });
  }

  async removePid(huntId: string): Promise<void> {
    await rm(this.pidPath(huntId), { force: true });
  }

  /**
   * Kills the process groups that an earlier API process left behind, found by the `*.pid` notes, then
   * deletes the notes. A group is killed (SIGTERM, then SIGKILL after 2 s) only when the note names a
   * process that still runs, whose process group is the one noted and whose command line has `kiro-cli`
   * in it; a pid that is gone or was reused by anything else is left alone. Returns how many it killed.
   */
  async reapOrphans(): Promise<number> {
    const inspect = this.hooks.inspect ?? psInspect;
    const killGroup =
      this.hooks.killGroup ??
      ((pgid: number, signal: NodeJS.Signals): void => {
        try {
          process.kill(-pgid, signal);
        } catch {
          // Already gone.
        }
      });
    const sleep = this.hooks.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)));
    const root = await realpath(this.dir).catch(() => null);
    if (root === null) return 0;
    const names = (await readdir(root).catch(() => [] as string[])).filter((n) => PID_FILE.test(n));
    const killed: Array<{ pid: number; pgid: number }> = [];
    for (const name of names) {
      const file = join(root, name);
      try {
        const note = JSON.parse(await readFile(file, 'utf8')) as { pid?: unknown; pgid?: unknown };
        const { pid, pgid } = note;
        if (typeof pid === 'number' && typeof pgid === 'number' && Number.isInteger(pid) && Number.isInteger(pgid) && pid > 1 && pgid > 1 && pgid !== process.pid) {
          const now = await inspect(pid);
          if (now !== null && now.pgid === pgid && KIRO_COMMAND.test(now.command)) {
            killGroup(pgid, 'SIGTERM');
            killed.push({ pid, pgid });
          }
        }
      } catch {
        // A note that cannot be read names nothing to kill.
      }
      await rm(file, { force: true });
    }
    if (killed.length > 0) {
      await sleep(REAP_GRACE_MS);
      for (const k of killed) {
        const still = await inspect(k.pid);
        if (still !== null && still.pgid === k.pgid && KIRO_COMMAND.test(still.command)) killGroup(k.pgid, 'SIGKILL');
      }
    }
    return killed.length;
  }

  /** Creates the empty ledger file (mode 0600) the MCP server appends to. */
  async createLedger(huntId: string): Promise<string> {
    const path = this.ledgerPath(huntId);
    await writeFile(path, '', { mode: 0o600, flag: 'w' });
    return path;
  }

  async readLedger(huntId: string): Promise<string> {
    return readFile(this.ledgerPath(huntId), 'utf8').catch(() => '');
  }

  async removeLedger(huntId: string): Promise<void> {
    await rm(this.ledgerPath(huntId), { force: true });
  }

  /** True when the agent copy is still byte-equal to the committed file (kiro-cli may rewrite it). */
  async agentIsIntact(): Promise<boolean> {
    try {
      return (await sha256(join(this.path, AGENT_REL))) === (await sha256(this.agentSource));
    } catch {
      return false;
    }
  }
}
