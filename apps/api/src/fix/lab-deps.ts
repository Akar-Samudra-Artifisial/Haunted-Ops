import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { FULL_SHA_PATTERN } from '@haunted-ops/shared';
import type { GitClient } from './git-client.js';

/**
 * The dependency tree of the lab, for the test run of a candidate (fix-proposal-flow task 14).
 *
 * The lab services test with vitest, and a candidate clone has no `node_modules`. The API installs the lab workspace
 * once, from the manifests of a lab commit (`pnpm-lock.yaml`, `pnpm-workspace.yaml` and every `package.json`), into
 * `FIX_WORKDIR/deps/<hash>/` with `pnpm install --frozen-lockfile --ignore-scripts`, an environment of names it picks
 * and a timeout. `<hash>` is the first 16 hex characters of the SHA-256 of the lockfile, so the tree is reused while
 * the lockfile is unchanged. A candidate clone gets links to it for the length of one test run (`linkDeps`), and the
 * test run may only read it. The fixer never sees it: its folder holds the files of one service and nothing else.
 */

export const DEPS_INSTALL_TIMEOUT_MS = 300_000;
/** The first bytes of a child's stderr kept for the log. */
export const DIAGNOSTIC_BYTES = 2048;
const MAX_MANIFESTS = 60;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_LOCK_BYTES = 8 * 1024 * 1024;
const HASH_DIR = /^[0-9a-f]{16}$/;
const READY = '.ready';

/** Why linking the tree into a clone was refused. */
export class LabDepsError extends Error {
  constructor(readonly code: 'clone_has_node_modules' | 'deps_missing') {
    super(code);
    this.name = 'LabDepsError';
  }
}

/** The manifest files of a lab tree to install from: the lockfile, the workspace file and every `package.json`. */
export function manifestPaths(files: readonly string[]): string[] {
  const out = files.filter((f) => {
    const parts = f.split('/');
    if (parts.some((p) => p === 'node_modules' || p.startsWith('.') || p === '')) return false;
    if (f === 'pnpm-lock.yaml' || f === 'pnpm-workspace.yaml') return true;
    return parts.length <= 4 && parts.at(-1) === 'package.json' && /^[A-Za-z0-9._@/-]+$/.test(f);
  });
  if (!out.includes('pnpm-lock.yaml') || !out.includes('package.json')) return [];
  return out.length > MAX_MANIFESTS ? [] : out.sort();
}

/** The fixed argument vector of the install. Scripts never run; the lockfile must match. */
export function buildInstallArgv(): string[] {
  return ['install', '--frozen-lockfile', '--ignore-scripts', '--prefer-offline', '--reporter=silent'];
}

/**
 * The environment of the install: exactly these names, no token. `HOME` is a temporary, empty folder (so no
 * `.npmrc` of the API user, with its registry tokens, is read); the pnpm store is named with `npm_config_store_dir`
 * (the API user's store, found once with `pnpm store path`, so `--prefer-offline` still finds the packages).
 * `npm_config_manage_package_manager_versions=false` keeps pnpm from fetching another pnpm for `packageManager`.
 */
export function buildInstallEnv(pnpmPath: string, parentEnv: Readonly<Record<string, string | undefined>>, o: { home: string; storeDir?: string | null } = { home: '/nonexistent' }): Record<string, string> {
  const path = [...new Set([dirname(process.execPath), dirname(pnpmPath), '/usr/bin', '/bin'])].join(':');
  const lang = parentEnv.LANG !== undefined && /^[A-Za-z0-9_.@-]{1,40}$/.test(parentEnv.LANG) ? parentEnv.LANG : 'en_US.UTF-8';
  const env: Record<string, string> = {
    PATH: path,
    HOME: o.home,
    LANG: lang,
    CI: 'true',
    npm_config_manage_package_manager_versions: 'false',
    npm_config_update_notifier: 'false',
  };
  if (o.storeDir != null && isAbsolute(o.storeDir)) env.npm_config_store_dir = o.storeDir;
  return env;
}

/** The pnpm store of the API user (`pnpm store path`, with only `PATH` and its `HOME`), or null. */
export async function findStoreDir(pnpmPath: string, parentEnv: Readonly<Record<string, string | undefined>>, cwd: string): Promise<string | null> {
  if (parentEnv.HOME === undefined || !isAbsolute(parentEnv.HOME)) return null;
  const run = await runBounded(pnpmPath, ['store', 'path'], {
    cwd,
    env: { PATH: [...new Set([dirname(process.execPath), dirname(pnpmPath), '/usr/bin', '/bin'])].join(':'), HOME: parentEnv.HOME, npm_config_manage_package_manager_versions: 'false' },
    timeoutMs: 20_000,
  });
  const line = run.stdout.trim().split('\n').at(-1) ?? '';
  return run.code === 0 && isAbsolute(line) && !/[\0\n]/.test(line) ? line : null;
}

/**
 * The first 2 KiB of a child's stderr, for one log line: ANSI codes and control characters removed, every absolute
 * path replaced by `[path]`. Never put into a pull request, an event or a public answer.
 */
export function cleanDiagnostic(text: string, max: number = DIAGNOSTIC_BYTES): string {
  return (
    Buffer.from(text, 'utf8')
      .subarray(0, max)
      .toString('utf8')
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/(?:file:\/\/)?(?<![A-Za-z0-9._-])\/(?:[^\s'"`:()[\]{}<>,]+)/g, '[path]')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, ' ')
      .trim()
  );
}

export interface ChildRun {
  code: number | null;
  timedOut: boolean;
  /** The first 2 KiB of stderr, raw. */
  stderr: string;
  stdout: string;
}

/** Runs one child in its own process group, with a timeout that kills the group, and bounded output. */
export function runBounded(file: string, argv: readonly string[], o: { cwd: string; env: Record<string, string>; timeoutMs: number; maxStdout?: number }): Promise<ChildRun> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const maxStdout = o.maxStdout ?? 64 * 1024;
    const child = spawn(file, [...argv], { cwd: o.cwd, env: o.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true });
    const killGroup = (signal: NodeJS.Signals): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal);
      } catch {
        // Already gone.
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), 2000).unref();
    }, o.timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (c: string) => {
      if (stdout.length < maxStdout) stdout += c.slice(0, maxStdout - stdout.length);
    });
    child.stderr?.on('data', (c: string) => {
      if (stderr.length < DIAGNOSTIC_BYTES) stderr += c.slice(0, DIAGNOSTIC_BYTES - stderr.length);
    });
    const done = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killGroup('SIGKILL');
      resolve({ code, timedOut, stderr, stdout });
    };
    child.on('error', () => done(null));
    child.on('close', (code) => done(code));
  });
}

export interface LabDepsOptions {
  /** `FIX_WORKDIR/deps`. */
  root: string;
  pnpmPath: string | null;
  parentEnv: Readonly<Record<string, string | undefined>>;
  git: Pick<GitClient, 'listFiles' | 'readBlob'>;
  log: (level: 'info' | 'warn', msg: string, fields?: Record<string, unknown>) => void;
  timeoutMs?: number;
  /** Test seam: the install. */
  install?: (cwd: string, pnpmPath: string, env: Record<string, string>, timeoutMs: number) => Promise<ChildRun>;
}

const exists = (p: string): Promise<boolean> => lstat(p).then(() => true, () => false);

export class LabDeps {
  private readonly inflight = new Map<string, Promise<string | null>>();
  /** The API user's pnpm store, found once (`undefined`: not looked up yet). */
  private storeDir: string | null | undefined;
  constructor(private readonly o: LabDepsOptions) {}

  /** The hash of the lockfile at `sha`, or null when the commit has none. */
  async lockHash(mirror: string, sha: string): Promise<string | null> {
    if (!FULL_SHA_PATTERN.test(sha)) return null;
    const lock = await this.o.git.readBlob(mirror, sha, 'pnpm-lock.yaml', MAX_LOCK_BYTES).catch(() => null);
    return lock === null ? null : createHash('sha256').update(lock).digest('hex').slice(0, 16);
  }

  /**
   * The real path of the installed tree for the lockfile of `sha`, installing it when it is missing. Null when it
   * cannot be had (no pnpm, no lockfile, the install failed); the reason is logged once per attempt.
   */
  async ensure(mirror: string, sha: string): Promise<string | null> {
    const hash = await this.lockHash(mirror, sha);
    if (hash === null) {
      this.o.log('warn', 'lab deps unavailable', { code: 'no_lockfile' });
      return null;
    }
    const dir = join(this.o.root, hash);
    if (await exists(join(dir, READY))) return realpath(dir);
    const running = this.inflight.get(hash);
    if (running !== undefined) return running;
    const p = this.prepare(mirror, sha, hash).finally(() => this.inflight.delete(hash));
    this.inflight.set(hash, p);
    return p;
  }

  private async prepare(mirror: string, sha: string, hash: string): Promise<string | null> {
    if (this.o.pnpmPath === null) {
      this.o.log('warn', 'lab deps unavailable', { code: 'no_pnpm' });
      return null;
    }
    const started = Date.now();
    await mkdir(this.o.root, { recursive: true, mode: 0o700 });
    const tmp = join(this.o.root, `.tmp-${hash}-${randomBytes(4).toString('hex')}`);
    try {
      const files = manifestPaths(await this.o.git.listFiles(mirror, sha));
      if (files.length === 0) {
        this.o.log('warn', 'lab deps unavailable', { code: 'no_manifests' });
        return null;
      }
      for (const f of files) {
        const data = await this.o.git.readBlob(mirror, sha, f, MAX_MANIFEST_BYTES);
        if (data === null) {
          this.o.log('warn', 'lab deps unavailable', { code: 'manifest_unreadable' });
          return null;
        }
        await mkdir(dirname(join(tmp, f)), { recursive: true, mode: 0o755 });
        await writeFile(join(tmp, f), data, { mode: 0o644 });
      }
      // A temporary, empty HOME for the install (no `.npmrc` of the API user), and the user's store named explicitly.
      const home = join(this.o.root, '.home');
      await rm(home, { recursive: true, force: true });
      await mkdir(home, { recursive: true, mode: 0o700 });
      if (this.storeDir === undefined) this.storeDir = await findStoreDir(this.o.pnpmPath, this.o.parentEnv, this.o.root).catch(() => null);
      const env = buildInstallEnv(this.o.pnpmPath, this.o.parentEnv, { home, storeDir: this.storeDir });
      const timeoutMs = this.o.timeoutMs ?? DEPS_INSTALL_TIMEOUT_MS;
      const run = await (this.o.install ?? ((cwd, pnpm, e, t) => runBounded(pnpm, buildInstallArgv(), { cwd, env: e, timeoutMs: t })))(tmp, this.o.pnpmPath, env, timeoutMs);
      if (run.timedOut || run.code !== 0 || !(await exists(join(tmp, 'node_modules')))) {
        this.o.log('warn', 'lab deps failed', { code: run.timedOut ? 'install_timeout' : 'install_failed', exitCode: run.code, stderr: cleanDiagnostic(run.stderr) });
        return null;
      }
      const dir = join(this.o.root, hash);
      await rm(dir, { recursive: true, force: true });
      await rename(tmp, dir);
      await writeFile(join(dir, READY), `${hash}\n`, { mode: 0o644 });
      await this.pruneExcept(hash);
      this.o.log('info', 'lab deps ready', { hash, files: files.length, durationMs: Date.now() - started });
      return realpath(dir);
    } catch (err) {
      this.o.log('warn', 'lab deps failed', { code: 'prepare_error', error: err instanceof Error ? err.name : 'unknown' });
      return null;
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Removes trees of other lockfiles and leftover temporary folders. */
  private async pruneExcept(hash: string): Promise<void> {
    for (const name of await readdir(this.o.root).catch(() => [] as string[])) {
      if (name === hash) continue;
      if (HASH_DIR.test(name) || (name.startsWith('.tmp-') && !name.startsWith(`.tmp-${hash}-`))) await rm(join(this.o.root, name), { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/** The workspace package folders of an installed tree that have their own `node_modules` (relative, sorted). */
async function packageDirsWithModules(deps: string): Promise<string[]> {
  const out: string[] = [];
  const visit = async (rel: string, depth: number): Promise<void> => {
    if (depth > 3) return;
    for (const name of (await readdir(join(deps, rel))).sort()) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const r = rel === '' ? name : `${rel}/${name}`;
      const s = await lstat(join(deps, r));
      if (!s.isDirectory()) continue;
      if ((await exists(join(deps, r, 'package.json'))) && (await exists(join(deps, r, 'node_modules')))) out.push(r);
      await visit(r, depth + 1);
    }
  };
  await visit('', 0);
  return out;
}

const inside = (root: string, p: string): boolean => {
  const rel = relative(root, p);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};

/**
 * Gives a clone the tree for one test run: `<clone>/node_modules` links to the tree's root `node_modules`, and each
 * workspace package of the clone gets a `node_modules` folder of links: a dependency installed in the tree links to its
 * real folder there, a workspace dependency links to the package of the clone itself (so a test reads the code it is
 * testing, never the manifests-only copy in the tree). Returns what it made, for `unlinkDeps`. A clone that already
 * has a `node_modules` is refused.
 */
export async function linkDeps(deps: string, clone: string): Promise<string[]> {
  const depsReal = await realpath(deps).catch(() => null);
  if (depsReal === null || !(await exists(join(depsReal, 'node_modules')))) throw new LabDepsError('deps_missing');
  const modulesReal = await realpath(join(depsReal, 'node_modules'));
  const made: string[] = [];
  try {
    const rootLink = join(clone, 'node_modules');
    if (await exists(rootLink)) throw new LabDepsError('clone_has_node_modules');
    await symlink(modulesReal, rootLink, 'dir');
    made.push(rootLink);
    for (const rel of await packageDirsWithModules(depsReal)) {
      if (!(await stat(join(clone, rel)).then((s) => s.isDirectory(), () => false))) continue;
      const target = join(clone, rel, 'node_modules');
      if (await exists(target)) throw new LabDepsError('clone_has_node_modules');
      await mkdir(target, { mode: 0o755 });
      made.push(target);
      const source = join(depsReal, rel, 'node_modules');
      const entries: Array<[string, string]> = [];
      for (const name of await readdir(source)) {
        if (name.startsWith('.')) continue;
        if (name.startsWith('@')) {
          const scoped = await readdir(join(source, name)).catch(() => [] as string[]);
          if (scoped.length > 0) await mkdir(join(target, name), { mode: 0o755 });
          for (const inner of scoped) entries.push([join(source, name, inner), join(target, name, inner)]);
        } else entries.push([join(source, name), join(target, name)]);
      }
      for (const [from, to] of entries) {
        const real = await realpath(from).catch(() => null);
        if (real === null) continue;
        if (real.startsWith(modulesReal + sep)) await symlink(real, to, 'dir');
        else if (inside(depsReal, real)) {
          const own = join(clone, relative(depsReal, real));
          if (await exists(own)) await symlink(own, to, 'dir');
        }
      }
    }
    return made;
  } catch (err) {
    await unlinkDeps(made);
    throw err;
  }
}

/** Removes what `linkDeps` made (links and folders of links only; nothing they point to). */
export async function unlinkDeps(made: readonly string[]): Promise<void> {
  for (const p of [...made].reverse()) await rm(p, { recursive: true, force: true }).catch(() => undefined);
}
