import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AiFailReason, ProposalCheck, ServiceName } from '@haunted-ops/shared';

/** The most files and lines a patch may change. */
export const MAX_PATCH_FILES = 5;
export const MAX_PATCH_LINES = 60;
/** A file bigger than this is not text the fixer should write. */
export const MAX_PATCH_FILE_BYTES = 256 * 1024;

export interface PatchFile {
  path: string;
  content: string;
}

export type UnreadableWhy = 'link' | 'special' | 'hardlink' | 'binary' | 'utf8' | 'name' | 'big';

export interface Patch {
  /** Files that exist in the export and differ. */
  changed: PatchFile[];
  /** Files that are new. */
  added: PatchFile[];
  /** Files of the export that are gone. */
  deleted: string[];
  /** Entries that cannot be read as plain text: a link, a device, a binary file, bad UTF-8, a bad name. */
  unreadable: Array<{ path: string; why: UnreadableWhy }>;
}

const NAME = /^[A-Za-z0-9._@][A-Za-z0-9._/@-]{0,249}$/;
const AGENT_FILE = '.kiro/agents/exorcist-fixer.json';

const isPlainName = (p: string): boolean => NAME.test(p) && p.normalize('NFC') === p && !p.split('/').some((s) => s === '..' || s === '.' || s === '');

async function listTree(root: string): Promise<Array<{ path: string; kind: 'file' | 'dir' | 'link' | 'special'; nlink: number; size: number }>> {
  const out: Array<{ path: string; kind: 'file' | 'dir' | 'link' | 'special'; nlink: number; size: number }> = [];
  const visit = async (dir: string, rel: string): Promise<void> => {
    for (const name of (await readdir(dir)).sort()) {
      const path = rel === '' ? name : `${rel}/${name}`;
      const s = await lstat(join(dir, name));
      const kind = s.isSymbolicLink() ? 'link' : s.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'special';
      out.push({ path, kind, nlink: s.nlink, size: s.size });
      if (kind === 'dir') await visit(join(dir, name), path);
    }
  };
  await visit(root, '');
  return out;
}

/** Reads a file without ever following a link, as UTF-8, or says why it cannot be read. */
async function readText(file: string): Promise<{ ok: true; text: string } | { ok: false; why: UnreadableWhy }> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const buf = await handle.readFile();
    if (buf.length > MAX_PATCH_FILE_BYTES) return { ok: false, why: 'big' };
    if (buf.includes(0)) return { ok: false, why: 'binary' };
    try {
      return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(buf) };
    } catch {
      return { ok: false, why: 'utf8' };
    }
  } catch {
    return { ok: false, why: 'link' };
  } finally {
    await handle?.close();
  }
}

/**
 * The patch: what the work folder holds compared with the export, byte for byte. The tree is walked with `lstat`
 * and never followed through a link. The agent copy under `.kiro` is not part of it (the runner checks its hash);
 * anything else under `.kiro` is unreadable. A name that is not a plain relative path is unreadable too.
 */
export async function readPatch(exportDir: string, workDir: string): Promise<Patch> {
  const before = new Map((await listTree(exportDir)).map((e) => [e.path, e]));
  const after = await listTree(workDir);
  const patch: Patch = { changed: [], added: [], deleted: [], unreadable: [] };
  const seen = new Set<string>();
  for (const e of after) {
    if (e.path === '.kiro' || e.path === '.kiro/agents' || e.path === AGENT_FILE) continue;
    if (e.kind === 'dir') {
      if (e.path.startsWith('.kiro/')) patch.unreadable.push({ path: e.path, why: 'name' });
      continue;
    }
    seen.add(e.path);
    if (!isPlainName(e.path) || e.path.startsWith('.kiro/')) {
      patch.unreadable.push({ path: e.path, why: 'name' });
      continue;
    }
    if (e.kind === 'link') {
      patch.unreadable.push({ path: e.path, why: 'link' });
      continue;
    }
    if (e.kind === 'special') {
      patch.unreadable.push({ path: e.path, why: 'special' });
      continue;
    }
    if (e.nlink > 1) {
      patch.unreadable.push({ path: e.path, why: 'hardlink' });
      continue;
    }
    const old = before.get(e.path);
    if (old !== undefined && old.kind !== 'file') {
      patch.unreadable.push({ path: e.path, why: 'special' });
      continue;
    }
    const text = await readText(join(workDir, e.path));
    if (!text.ok) {
      patch.unreadable.push({ path: e.path, why: text.why });
      continue;
    }
    if (old === undefined) patch.added.push({ path: e.path, content: text.text });
    else {
      const prev = await readText(join(exportDir, e.path));
      if (!prev.ok || prev.text !== text.text) patch.changed.push({ path: e.path, content: text.text });
    }
  }
  for (const [path, e] of before) if (e.kind === 'file' && !seen.has(path)) patch.deleted.push(path);
  return patch;
}

export interface JudgeContext {
  service: ServiceName;
  /** `FIX_REQUIRE_TESTS`: a run with no test fails the check. */
  requireTests: boolean;
  /** The files the culprit commit changed (for the informational check). */
  culpritFiles: readonly string[];
}

export interface PatchSize {
  files: number;
  lines: number;
  binary?: boolean;
}

export interface TestsResult {
  /** The run exited 0. */
  ok: boolean;
  /** How many tests ran. */
  ran: number;
  timedOut: boolean;
}

/** What needs a clone and a process: asked for only when every check before it passed. */
export interface DynamicChecks {
  /** `binary`: git could not count a file (`-` in numstat: a binary file, or a `-diff` attribute), so its lines are unknown. */
  size(): Promise<PatchSize> | PatchSize;
  syntax(): Promise<boolean> | boolean;
  tests(): Promise<TestsResult> | TestsResult;
}

export interface Judgement {
  accepted: boolean;
  /** The checks that ran, in order, up to and including the first that failed. */
  checks: ProposalCheck[];
  /** Why the patch was not used; null when it was accepted. */
  aiFailReason: AiFailReason | null;
}

/**
 * The source files a patch may write: the lab services are TypeScript (`.ts`), the test lab is JavaScript. Anything
 * else (`.json`, `.md`, `.yaml`, a file with no extension) is not code the fixer has a reason to touch.
 */
export const CODE_EXT = /\.(js|mjs|cjs|ts|mts|cts)$/;
const CONFIG_EXT = /\.(json|ya?ml|toml|ini|env|sh|bash|zsh|ps1|bat|cmd|lock|lockb)$/i;
/** Compared in lower case: `PACKAGE.JSON` is `package.json` on a case-insensitive file system. */
const LOCKS = new Set(['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'npm-shrinkwrap.json', '.npmrc', '.nvmrc', '.env']);
const TEST_DIRS = new Set(['test', 'tests', '__tests__', 'spec', 'specs', '__mocks__', '__snapshots__', 'fixtures']);

/**
 * True for a file the fixer must never change or add: anything that is not a source file (`CODE_EXT`), any path with
 * a segment that starts with `.` (`.gitattributes`, `.gitignore`, `.npmrc`, `.env`, a dot folder), package files and
 * lockfiles in any case, configuration, scripts and tests.
 */
export function isForbiddenName(path: string): boolean {
  const parts = path.split('/');
  const base = parts.at(-1) ?? '';
  const lower = base.toLowerCase();
  if (!CODE_EXT.test(base)) return true;
  if (parts.some((p) => p.startsWith('.'))) return true;
  if (LOCKS.has(lower) || lower.startsWith('.env') || CONFIG_EXT.test(base)) return true;
  if (/\.(test|spec)\.[A-Za-z0-9]+$/i.test(base) || /^test[_-]/i.test(base)) return true;
  return parts.slice(0, -1).some((p) => TEST_DIRS.has(p.toLowerCase()));
}

/**
 * Judges a patch. The checks run in this order and the first one that fails ends the sequence:
 * `non_empty`, `scope` (every path is in the service), `forbidden_file` (nothing deleted, nothing unreadable, every
 * path under `src/`, a source file with no dot segment, no package file, configuration, script or test), `size` (at
 * most 5 files and 60 lines; a file git cannot count fails it with the reason `forbidden_file`),
 * `syntax` and `tests`. A patch is accepted if and only if every one of them passes. The informational check
 * `touches_culprit_files` is added to an accepted patch and never fails it.
 */
export async function judgePatch(patch: Patch, ctx: JudgeContext, dyn: DynamicChecks): Promise<Judgement> {
  const checks: ProposalCheck[] = [];
  const fail = (name: ProposalCheck['name'], reason: AiFailReason): Judgement => {
    checks.push({ name, ok: false });
    return { accepted: false, checks, aiFailReason: reason };
  };
  const pass = (name: ProposalCheck['name']): void => void checks.push({ name, ok: true });
  const all = [...patch.changed.map((f) => f.path), ...patch.added.map((f) => f.path), ...patch.deleted, ...patch.unreadable.map((u) => u.path)];
  if (all.length === 0) return fail('non_empty', 'scope');
  pass('non_empty');
  const service = `services/${ctx.service}/`;
  if (!all.every((p) => p.startsWith(service))) return fail('scope', 'scope');
  pass('scope');
  const src = `${service}src/`;
  const written = [...patch.changed, ...patch.added].map((f) => f.path);
  if (patch.unreadable.length > 0 || patch.deleted.length > 0 || !written.every((p) => p.startsWith(src) && !isForbiddenName(p))) return fail('forbidden_file', 'forbidden_file');
  pass('forbidden_file');
  const size = await dyn.size();
  // A `-` count is never read as 0: lines git will not count could be any number of lines.
  if (size.binary === true) return fail('size', 'forbidden_file');
  if (size.files > MAX_PATCH_FILES || size.lines > MAX_PATCH_LINES || size.files < 1) return fail('size', 'size');
  pass('size');
  if (!(await dyn.syntax())) return fail('syntax', 'tests_failed');
  pass('syntax');
  const tests = await dyn.tests();
  if (tests.timedOut) return fail('tests', 'timeout');
  if (!tests.ok || (tests.ran === 0 && ctx.requireTests)) return fail('tests', 'tests_failed');
  pass('tests');
  checks.push({ name: 'touches_culprit_files', ok: written.some((p) => ctx.culpritFiles.includes(p)) });
  return { accepted: true, checks, aiFailReason: null };
}

/** Whether every check that decides acceptance is ok in a judgement's list (the informational one is not counted). */
export const decidingChecks = (checks: readonly ProposalCheck[]): ProposalCheck[] => checks.filter((c) => c.name !== 'touches_culprit_files');
