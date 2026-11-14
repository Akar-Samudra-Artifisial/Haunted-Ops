import { createHash } from 'node:crypto';
import { chmod, copyFile, cp, lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, parse } from 'node:path';
import { CUID_PATTERN, SERVICE_NAMES, type ServiceName } from '@haunted-ops/shared';
import { defaultFixerAgentSource, FIXER_AGENT } from './fix-env.js';

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

async function walk(dir: string, visit: (path: string, isDir: boolean) => Promise<void>): Promise<void> {
  for (const name of await readdir(dir)) {
    const p = join(dir, name);
    const s = await lstat(p);
    if (s.isDirectory()) {
      await walk(p, visit);
      await visit(p, true);
    } else await visit(p, false);
  }
}

/** Files 0444 and folders 0555 below `dir`, `dir` included. */
export async function makeReadOnly(dir: string): Promise<void> {
  await walk(dir, (p, isDir) => chmod(p, isDir ? 0o555 : 0o444));
  await chmod(dir, 0o555);
}

/** The reverse of `makeReadOnly`, so the folder can be deleted. */
export async function makeWritable(dir: string): Promise<void> {
  await chmod(dir, 0o755).catch(() => undefined);
  const todo: string[] = [];
  await walk(dir, async (p, isDir) => void todo.push(isDir ? `d${p}` : `f${p}`)).catch(() => undefined);
  for (const t of todo) await chmod(t.slice(1), t[0] === 'd' ? 0o755 : 0o644).catch(() => undefined);
}

const sha256 = async (p: string): Promise<string> => createHash('sha256').update(await readFile(p)).digest('hex');

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

  /** True when the agent copy is still byte-equal to the committed file (the run may have rewritten it). */
  async agentIntact(work: string): Promise<boolean> {
    try {
      return (await sha256(join(work, AGENT_REL))) === (await sha256(this.agentSource));
    } catch {
      return false;
    }
  }

  /** Deletes the folders of a run, whatever its result. */
  async remove(proposalId: string): Promise<void> {
    const f = this.folders(proposalId);
    await makeWritable(f.base).catch(() => undefined);
    await rm(f.base, { recursive: true, force: true });
  }
}
