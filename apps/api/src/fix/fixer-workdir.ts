import { constants } from 'node:fs';
import { open, chmod, copyFile, cp, lstat, mkdir, readFile, readdir, realpath, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, parse } from 'node:path';
import { CUID_PATTERN, SERVICE_NAMES, type ServiceName } from '@haunted-ops/shared';
import { agentUnchanged, type AgentCheck } from './agent-check.js';
import { defaultFixerAgentSource, FIXER_AGENT } from './fix-env.js';

export const FIXER_STREAM_SUFFIX = '.fixer.stream.jsonl';
/**
 * The paths of the API user's home that are linked into the fixer's own `HOME`: the kiro-cli data folder, where it
 * keeps its login (macOS, then Linux). Not checked against a real kiro-cli in this task (no live run); the opt-in live
 * test (10.2) confirms it, and the list is the one place to change.
 */
export const KIRO_STATE_PATHS = ['Library/Application Support/kiro-cli', '.local/share/kiro-cli'] as const;
/** Fixer stream files are kept this long. */
export const FIXER_STREAM_MAX_AGE_MS = 7 * 24 * 3_600_000;

/** Why a fixer folder was refused. Never carries a path. */
export class FixerWorkdirError extends Error {
  constructor(readonly reason: 'inside_repository' | 'has_steering' | 'export_unsafe' | 'bad_agent' | 'bad_proposal_id') {
    super(`fixer working folder refused: ${reason}`);
    this.name = 'FixerWorkdirError';
  }
}

const AGENT_REL = join('.kiro', 'agents', `${FIXER_AGENT}.json`);
/** The most bytes and entries an export may have. */
export const MAX_EXPORT_BYTES = 8 * 1024 * 1024;
export const MAX_EXPORT_ENTRIES = 2000;

export interface FixerFolders {
  /** `<root>/fixer/<proposalId>` */
  base: string;
  /** The folder the fixer works in and the process starts in. */
  work: string;
  /** The pristine copy the result is compared with. */
  exportDir: string;
}

/** Top-level paths an export may hold for `service`: its code, and the shared package. */
export const exportPathsOf = (service: ServiceName): string[] => [`services/${service}`, 'packages/lab-common'];

interface TarEntry {
  path: string;
  type: 'file' | 'dir';
  data: Buffer;
}

const octal = (buf: Buffer): number => {
  const text = buf.toString('latin1').replace(/\0.*$/s, '').trim();
  return text === '' ? 0 : Number.parseInt(text, 8);
};
const cstr = (buf: Buffer): string => buf.toString('utf8').replace(/\0.*$/s, '');

/** `path=...` records of a pax extended header. */
function paxRecords(data: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space < 0) break;
    const len = Number.parseInt(data.toString('latin1', at, space), 10);
    if (!Number.isFinite(len) || len <= space - at + 1 || at + len > data.length) break;
    const rec = data.toString('utf8', space + 1, at + len - 1);
    const eq = rec.indexOf('=');
    if (eq > 0) out.set(rec.slice(0, eq), rec.slice(eq + 1));
    at += len;
  }
  return out;
}

/**
 * Reads a tar made by `git archive`: regular files and directories only. A symlink, hard link, device, FIFO, an
 * unknown entry type, an absolute or `..` path, a backslash, a NUL, a path outside `allowed`, too many entries or
 * too many bytes makes the export unsafe. The global pax header that `git archive` writes is skipped.
 */
export function readTar(tar: Buffer, allowed: readonly string[]): TarEntry[] {
  const entries: TarEntry[] = [];
  let at = 0;
  let pendingPath: string | null = null;
  let bytes = 0;
  const unsafe = (): never => {
    throw new FixerWorkdirError('export_unsafe');
  };
  while (at + 512 <= tar.length) {
    const header = tar.subarray(at, at + 512);
    if (header.every((b) => b === 0)) break;
    const size = octal(header.subarray(124, 136));
    const type = String.fromCharCode(header[156] === 0 ? 48 : (header[156] as number));
    const dataStart = at + 512;
    const dataEnd = dataStart + size;
    if (!Number.isSafeInteger(size) || size < 0 || dataEnd > tar.length) unsafe();
    const data = tar.subarray(dataStart, dataEnd);
    at = dataStart + Math.ceil(size / 512) * 512;
    if (type === 'g') continue;
    if (type === 'x') {
      pendingPath = paxRecords(data).get('path') ?? null;
      continue;
    }
    const prefix = cstr(header.subarray(345, 500));
    const name = pendingPath ?? (prefix === '' ? cstr(header.subarray(0, 100)) : `${prefix}/${cstr(header.subarray(0, 100))}`);
    pendingPath = null;
    if (type !== '0' && type !== '5') unsafe();
    const path = name.replace(/\/+$/, '');
    if (path === '' || path.startsWith('/') || path.includes('\\') || path.includes('\0') || path.split('/').some((s) => s === '..' || s === '.' || s === '')) unsafe();
    if (!allowed.some((a) => path === a || path.startsWith(`${a}/`) || a.startsWith(`${path}/`))) unsafe();
    entries.push({ path, type: type === '5' ? 'dir' : 'file', data: type === '5' ? Buffer.alloc(0) : Buffer.from(data) });
    bytes += size;
    if (entries.length > MAX_EXPORT_ENTRIES || bytes > MAX_EXPORT_BYTES) unsafe();
  }
  return entries;
}

/** Visits real files and folders below `dir`. A symlink is skipped: never followed, never visited. */
async function walk(dir: string, visit: (path: string, isDir: boolean) => Promise<void>): Promise<void> {
  for (const name of await readdir(dir)) {
    const p = join(dir, name);
    const s = await lstat(p);
    if (s.isSymbolicLink()) continue;
    if (s.isDirectory()) {
      await walk(p, visit);
      await visit(p, true);
    } else if (s.isFile()) await visit(p, false);
  }
}

/** Permission changes never follow links: the folder given must not be a link itself. */
async function assertNotLink(dir: string): Promise<void> {
  if ((await lstat(dir)).isSymbolicLink()) throw new Error('permission change refused: the folder is a link');
}

/** Files 0444 and folders 0555 below `dir`, `dir` included. Links are skipped; `dir` itself must not be a link. */
export async function makeReadOnly(dir: string): Promise<void> {
  await assertNotLink(dir);
  await walk(dir, (p, isDir) => chmod(p, isDir ? 0o555 : 0o444));
  await chmod(dir, 0o555);
}

/** The reverse of `makeReadOnly`, so the folder can be deleted. Links are skipped; `dir` itself must not be a link. */
export async function makeWritable(dir: string): Promise<void> {
  await assertNotLink(dir);
  await chmod(dir, 0o755).catch(() => undefined);
  const todo: string[] = [];
  await walk(dir, async (p, isDir) => void todo.push(isDir ? `d${p}` : `f${p}`)).catch(() => undefined);
  for (const t of todo) await chmod(t.slice(1), t[0] === 'd' ? 0o755 : 0o644).catch(() => undefined);
}

/** Unlinks every symlink below `dir` (never following one), so a later `rm` cannot reach a target. */
async function unlinkLinks(dir: string): Promise<void> {
  for (const name of await readdir(dir)) {
    const p = join(dir, name);
    const s = await lstat(p);
    if (s.isSymbolicLink()) await unlink(p);
    else if (s.isDirectory()) await unlinkLinks(p);
  }
}


/**
 * The folders of the fixer. Each run gets `<root>/fixer/<proposalId>/work` (where the process runs) and `.../export`
 * (the pristine copy). They are outside every git repository and hold no `.git` and no `.kiro/steering`, only the
 * files of one service, a read-only copy of `packages/lab-common` and the agent file. The API fills them from its
 * own clone with `git archive`, reading the tar itself; no command runs in them.
 */
export class FixerWorkdir {
  private realRoot = '';

  constructor(
    private readonly root: string,
    private readonly agentSource: string = defaultFixerAgentSource(),
  ) {}

  get path(): string {
    return this.realRoot === '' ? this.root : this.realRoot;
  }

  /** Makes the root folder (mode 0700) and refuses a place inside a repository or under steering. */
  async prepareRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    this.realRoot = await realpath(this.root);
    let at = this.realRoot;
    for (;;) {
      if (await stat(join(at, '.git')).then(() => true, () => false)) throw new FixerWorkdirError('inside_repository');
      if (await stat(join(at, '.kiro', 'steering')).then(() => true, () => false)) throw new FixerWorkdirError('has_steering');
      if (at === parse(at).root) break;
      at = dirname(at);
    }
    await chmod(this.realRoot, 0o700);
    await mkdir(join(this.realRoot, 'fixer'), { recursive: true, mode: 0o700 });
  }

  folders(proposalId: string): FixerFolders {
    if (!CUID_PATTERN.test(proposalId)) throw new FixerWorkdirError('bad_proposal_id');
    const base = join(this.path, 'fixer', proposalId);
    return { base, work: join(base, 'work'), exportDir: join(base, 'export') };
  }

  /** Path of the pid note of a fixer process, `<root>/<proposalId>.pid` (the reaper at start reads these). */
  pidPath(proposalId: string): string {
    if (!CUID_PATTERN.test(proposalId)) throw new FixerWorkdirError('bad_proposal_id');
    return join(this.path, `${proposalId}.pid`);
  }

  /** The folder of the fixer streams, `<root>/streams` (mode 0700). */
  get streamsDir(): string {
    return join(this.path, 'streams');
  }

  /** Path of the reduced stream of a fixer run, `<root>/streams/<proposalId>.fixer.stream.jsonl`. */
  streamPath(proposalId: string): string {
    if (!CUID_PATTERN.test(proposalId)) throw new FixerWorkdirError('bad_proposal_id');
    return join(this.streamsDir, `${proposalId}${FIXER_STREAM_SUFFIX}`);
  }

  /** Makes the streams folder and deletes stream files older than `maxAgeMs` (7 days by default). Returns how many. */
  async pruneStreams(now: Date, maxAgeMs: number = FIXER_STREAM_MAX_AGE_MS): Promise<number> {
    await mkdir(this.streamsDir, { recursive: true, mode: 0o700 });
    await chmod(this.streamsDir, 0o700);
    let removed = 0;
    for (const name of await readdir(this.streamsDir)) {
      if (!name.endsWith(FIXER_STREAM_SUFFIX)) continue;
      const p = join(this.streamsDir, name);
      const s = await lstat(p).catch(() => null);
      if (s === null || !s.isFile() || now.getTime() - s.mtimeMs <= maxAgeMs) continue;
      await rm(p, { force: true });
      removed += 1;
    }
    return removed;
  }

  /** The API's own bare copy of the Lab repo and the candidate clones live next to the fixer folders. */
  get mirrorPath(): string {
    return join(this.path, 'lab.git');
  }
  candidatePath(proposalId: string, name: string): string {
    if (!CUID_PATTERN.test(proposalId) || !/^[a-z-]{1,20}$/.test(name)) throw new FixerWorkdirError('bad_proposal_id');
    return join(this.path, 'candidates', `${proposalId}-${name}`);
  }

  /**
   * Fills a run's folders from the tar of `git archive` and returns them. `lab-common` is read-only in `work`.
   * Throws `export_unsafe` when the tar holds anything but plain files and folders of the allowed paths.
   */
  async create(proposalId: string, service: ServiceName, tar: Buffer): Promise<FixerFolders> {
    if (!(SERVICE_NAMES as readonly string[]).includes(service)) throw new FixerWorkdirError('export_unsafe');
    const f = this.folders(proposalId);
    // A folder of an earlier run of the same id may still have its read-only part.
    await makeWritable(f.base).catch(() => undefined);
    await rm(f.base, { recursive: true, force: true });
    await mkdir(f.exportDir, { recursive: true, mode: 0o700 });
    const entries = readTar(tar, exportPathsOf(service));
    for (const e of entries) {
      const target = join(f.exportDir, e.path);
      if (e.type === 'dir') await mkdir(target, { recursive: true, mode: 0o755 });
      else {
        await mkdir(dirname(target), { recursive: true, mode: 0o755 });
        await writeFile(target, e.data, { mode: 0o644 });
      }
    }
    await cp(f.exportDir, f.work, { recursive: true, verbatimSymlinks: true });
    // The export is what the patch is read against: read-only once filled (after the copy, which keeps modes).
    await makeReadOnly(f.exportDir);
    const common = join(f.work, 'packages', 'lab-common');
    if (await stat(common).then(() => true, () => false)) await makeReadOnly(common);
    if (!(await stat(this.agentSource).then(() => true, () => false))) throw new FixerWorkdirError('bad_agent');
    await mkdir(join(f.work, '.kiro', 'agents'), { recursive: true, mode: 0o700 });
    await copyFile(this.agentSource, join(f.work, AGENT_REL));
    await chmod(f.base, 0o700);
    return f;
  }

  /** The files of the work folder (relative, sorted), without the agent file. Used for the prompt. */
  async fileList(work: string): Promise<string[]> {
    const out: string[] = [];
    const visit = async (dir: string, rel: string): Promise<void> => {
      for (const name of (await readdir(dir)).sort()) {
        if (rel === '' && name === '.kiro') continue;
        const p = join(dir, name);
        const s = await lstat(p);
        if (s.isDirectory()) await visit(p, rel === '' ? name : `${rel}/${name}`);
        else if (s.isFile()) out.push(rel === '' ? name : `${rel}/${name}`);
      }
    };
    await visit(work, '');
    return out;
  }

  /**
   * Whether the agent copy is still the committed agent after the run. kiro-cli 3.3.0 migrates the file in place
   * (renamed tools, added allow rules, `kiroUpgrade`), so this is a semantic check (`agentUnchanged`), not a byte one.
   * A missing or unreadable copy is a change.
   */
  async agentCheck(work: string): Promise<AgentCheck> {
    let copy: string;
    let source: string;
    let handle;
    try {
      // The copy is opened without following a link, and must be a regular file with one link.
      handle = await open(join(work, AGENT_REL), constants.O_RDONLY | constants.O_NOFOLLOW);
      const s = await handle.stat();
      if (!s.isFile() || s.nlink !== 1 || s.size > 256 * 1024) return { ok: false, key: '(not a plain file)' };
      copy = (await handle.readFile()).toString('utf8');
      source = await readFile(this.agentSource, 'utf8');
    } catch {
      return { ok: false, key: '(missing)' };
    } finally {
      await handle?.close();
    }
    return agentUnchanged(source, copy);
  }

  /**
   * The fixer's own `HOME`: `<root>/home`, mode 0700, made empty for every run. kiro-cli keeps its login in its data
   * folder under the user's home; only that folder is linked in (`KIRO_STATE_PATHS`, when it exists in `parentHome`),
   * nothing else of the API user's home (no `.kiro` with global agents or steering, no `.ssh`, no `.aws`, no shell
   * profile). The links are outside the work folder, so the stream guard keeps the fixer's tools away from them.
   */
  async prepareHome(parentHome: string | undefined): Promise<string> {
    const home = join(this.path, 'home');
    // No `makeWritable` here: the links go first, then the rest; `chmod` runs on `home` only.
    const old = await lstat(home).catch(() => null);
    if (old?.isSymbolicLink() === true) await unlink(home);
    else if (old?.isDirectory() === true) {
      await chmod(home, 0o700).catch(() => undefined);
      await unlinkLinks(home).catch(() => undefined);
    }
    await rm(home, { recursive: true, force: true });
    await mkdir(home, { recursive: true, mode: 0o700 });
    await chmod(home, 0o700);
    if (parentHome !== undefined && parentHome !== '' && parentHome !== home) {
      for (const rel of KIRO_STATE_PATHS) {
        const from = join(parentHome, rel);
        if (!(await stat(from).then((s) => s.isDirectory(), () => false))) continue;
        await mkdir(dirname(join(home, rel)), { recursive: true, mode: 0o700 });
        await symlink(from, join(home, rel), 'dir');
      }
    }
    return home;
  }

  /** The bytes of the agent file each run's folder gets (the committed file, before kiro-cli migrates the copy). */
  async pristineAgent(): Promise<Buffer> {
    return readFile(this.agentSource);
  }

  /** True when `agentCheck` accepts the copy. */
  async agentIntact(work: string): Promise<boolean> {
    return (await this.agentCheck(work)).ok;
  }

  /** Deletes the folders of a run, whatever its result. */
  async remove(proposalId: string): Promise<void> {
    const f = this.folders(proposalId);
    await makeWritable(f.base).catch(() => undefined);
    await rm(f.base, { recursive: true, force: true });
  }
}
