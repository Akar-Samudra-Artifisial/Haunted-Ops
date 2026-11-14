import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { FULL_SHA_PATTERN, fixBranch, incidentBranch } from '@haunted-ops/shared';

/** Fixed codes: nothing of what git printed is kept (it can name hosts, paths and headers). */
export type GitErrorCode = 'git_failed' | 'git_timeout' | 'push_rejected' | 'fetch_failed' | 'bad_argument';

export class GitError extends Error {
  constructor(
    readonly code: GitErrorCode,
    /** The exit code of the process, when it ran. */
    readonly exitCode: number | null = null,
  ) {
    super(code);
    this.name = 'GitError';
  }
}

export interface GitExecOptions {
  cwd?: string;
  env: Record<string, string>;
  timeoutMs: number;
  maxBuffer: number;
}
/** Runs a program with an argument array and no shell. Tests inject one that records argv and environment. */
export type GitExec = (file: string, args: readonly string[], opts: GitExecOptions) => Promise<{ stdout: Buffer }>;

export const defaultGitExec: GitExec = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], { cwd: opts.cwd, env: opts.env, timeout: opts.timeoutMs, maxBuffer: opts.maxBuffer, encoding: 'buffer', shell: false, windowsHide: true }, (err, stdout) => {
      if (err === null) return resolve({ stdout });
      const e = err as NodeJS.ErrnoException & { killed?: boolean };
      const exit = typeof e.code === 'number' ? e.code : null;
      reject(new GitError(e.killed === true ? 'git_timeout' : 'git_failed', exit));
    });
  });

/** The header a token travels in: `http.extraHeader` for `https://github.com/` only, set through `GIT_CONFIG_*`. */
export function authEnv(token: string): Record<string, string> {
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}` };
}

export const FIX_AUTHOR_NAME = 'Exorcist';
export const FIX_AUTHOR_EMAIL = 'exorcist@users.noreply.github.com';

/** Pathspecs and names passed to git: plain relative paths, never an option. */
const PATH_PATTERN = /^[A-Za-z0-9._@][A-Za-z0-9._/@-]{0,199}$/;
const isSafePath = (p: string): boolean => PATH_PATTERN.test(p) && !p.split('/').includes('..') && !p.includes('//');
const assertSha = (sha: string): void => {
  if (!FULL_SHA_PATTERN.test(sha)) throw new GitError('bad_argument');
};

/**
 * Counts `git diff --numstat -z` records (`added\tdeleted\tpath\0`). A `-` count (a binary file, or a path with a
 * `-diff` attribute) is never read as 0: it sets `binary`, and the caller refuses the change.
 */
export function countNumstat(out: string): { files: number; lines: number; paths: string[]; binary: boolean } {
  let lines = 0;
  let binary = false;
  const paths: string[] = [];
  for (const rec of out.split('\0')) {
    if (rec === '') continue;
    const [a, d, ...rest] = rec.split('\t');
    if (a === '-' || d === '-') binary = true;
    else lines += Number(a) + Number(d);
    paths.push(rest.join('\t'));
  }
  return { files: paths.length, lines, paths, binary };
}

export interface GitClientOptions {
  gitPath: string;
  /** `owner/name` of the Lab repo. */
  repo: string;
  /** The GitHub token. Reaches only `push` and `fetch` calls, in `GIT_CONFIG_*`. Null: no authentication. */
  token: string | null;
  exec?: GitExec;
  /** The remote URL. Default `https://github.com/<repo>.git`. Tests point it at a local bare repository. */
  remoteUrl?: (repo: string) => string;
  /** Tests only: allow a `file://` remote. */
  allowFileProtocol?: boolean;
  /** A throwaway `HOME`, so no user configuration is read. */
  home: string;
  /** Sets the date of commits (tests use a fixed one). */
  commitDate?: () => Date;
  timeoutMs?: number;
}

const BIG = 64 * 1024 * 1024;

/**
 * Every git call of the fix flow. Arrays only, no shell, `GIT_CONFIG_GLOBAL=/dev/null`, no hooks, no credential
 * helper. The token is in the environment of `push` and `fetch` only. Refs that are created or pushed are built
 * here from a valid hunt id and nowhere else; nothing is ever forced or deleted.
 */
export class GitClient {
  private readonly exec: GitExec;
  private readonly timeoutMs: number;

  constructor(private readonly o: GitClientOptions) {
    this.exec = o.exec ?? defaultGitExec;
    this.timeoutMs = o.timeoutMs ?? 120_000;
  }

  /** The remote URL, passed as an argument and never stored in a repository configuration. */
  get url(): string {
    return (this.o.remoteUrl ?? ((repo: string) => `https://github.com/${repo}.git`))(this.o.repo);
  }

  private env(auth: boolean): Record<string, string> {
    const env: Record<string, string> = {
      PATH: [dirname(this.o.gitPath), '/usr/bin', '/bin'].join(':'),
      HOME: this.o.home,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: 'true',
      LC_ALL: 'C',
    };
    const date = this.o.commitDate?.().toISOString();
    if (date !== undefined) Object.assign(env, { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
    if (auth && this.o.token !== null) Object.assign(env, authEnv(this.o.token));
    return env;
  }

  private baseArgs(local = false): string[] {
    const file = local || this.o.allowFileProtocol === true ? 'always' : 'never';
    return ['-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', '-c', `protocol.file.allow=${file}`, '-c', 'core.fsmonitor=false', '-c', 'gc.auto=0'];
  }

  private async run(args: readonly string[], o: { cwd?: string; auth?: boolean; local?: boolean; maxBuffer?: number } = {}): Promise<Buffer> {
    const { stdout } = await this.exec(this.o.gitPath, [...this.baseArgs(o.local), ...args], {
      cwd: o.cwd,
      env: this.env(o.auth === true),
      timeoutMs: this.timeoutMs,
      maxBuffer: o.maxBuffer ?? BIG,
    });
    return stdout;
  }

  private async text(args: readonly string[], o: Parameters<GitClient['run']>[1] = {}): Promise<string> {
    return (await this.run(args, o)).toString('utf8');
  }

  /** The API's own bare copy of the Lab repo: `main` and the scenario branches only, no remote in its configuration. */
  async ensureMirror(dir: string): Promise<void> {
    if (!existsSync(`${dir}/HEAD`)) await this.run(['init', '--bare', '--quiet', dir]);
    await this.fetchBase(dir);
  }

  async fetchBase(dir: string): Promise<void> {
    try {
      await this.run(['-C', dir, 'fetch', '--quiet', '--prune', this.url, '+refs/heads/main:refs/heads/main', '+refs/heads/scenario/*:refs/heads/scenario/*'], { auth: true });
    } catch (err) {
      throw err instanceof GitError && err.code === 'git_timeout' ? err : new GitError('fetch_failed', err instanceof GitError ? err.exitCode : null);
    }
  }

  /** Fetches `incident/<huntId>` into `refs/proposal/incident/<huntId>` and returns its head. */
  async fetchIncidentBranch(dir: string, huntId: string): Promise<string> {
    const branch = incidentBranch(huntId);
    const local = `refs/proposal/${branch}`;
    try {
      await this.run(['-C', dir, 'fetch', '--quiet', this.url, `+refs/heads/${branch}:${local}`], { auth: true });
    } catch (err) {
      throw err instanceof GitError && err.code === 'git_timeout' ? err : new GitError('fetch_failed', err instanceof GitError ? err.exitCode : null);
    }
    return this.revParse(dir, local);
  }

  /** `git --version` without the words: `2.43.0`. */
  async version(): Promise<string> {
    const out = (await this.text(['--version'])).trim();
    return /\d+\.\d+(\.\d+)?/.exec(out)?.[0] ?? '';
  }

  async revParse(dir: string, rev: string): Promise<string> {
    if (!/^[A-Za-z0-9._/-]{1,200}$/.test(rev) || rev.startsWith('-')) throw new GitError('bad_argument');
    const out = (await this.text(['-C', dir, 'rev-parse', '--verify', '--quiet', `${rev}^{commit}`])).trim();
    if (!FULL_SHA_PATTERN.test(out)) throw new GitError('git_failed');
    return out;
  }

  async hasCommit(dir: string, sha: string): Promise<boolean> {
    assertSha(sha);
    try {
      await this.run(['-C', dir, 'cat-file', '-e', `${sha}^{commit}`]);
      return true;
    } catch (err) {
      if (err instanceof GitError && err.code === 'git_failed') return false;
      throw err;
    }
  }

  async parents(dir: string, sha: string): Promise<string[]> {
    assertSha(sha);
    const out = (await this.text(['-C', dir, 'rev-list', '--parents', '-n', '1', sha])).trim().split(' ');
    return out.slice(1);
  }

  async isAncestor(dir: string, ancestor: string, descendant: string): Promise<boolean> {
    assertSha(ancestor);
    assertSha(descendant);
    try {
      await this.run(['-C', dir, 'merge-base', '--is-ancestor', ancestor, descendant]);
      return true;
    } catch (err) {
      if (err instanceof GitError && err.code === 'git_failed' && err.exitCode === 1) return false;
      throw err;
    }
  }

  /** True when `sha` is on `main` or on a scenario branch of the mirror (the base of every Incident branch). */
  async descendsFromBase(dir: string, sha: string): Promise<boolean> {
    assertSha(sha);
    if (!(await this.hasCommit(dir, sha))) return false;
    const heads = (await this.text(['-C', dir, 'for-each-ref', '--format=%(objectname)', 'refs/heads/main', 'refs/heads/scenario/'])).split('\n').filter((l) => FULL_SHA_PATTERN.test(l));
    for (const head of heads) if (await this.isAncestor(dir, sha, head)) return true;
    return false;
  }

  /** The diff of one commit limited to `pathspec`, cut at `capBytes` (a marker says so). */
  async showDiff(dir: string, sha: string, pathspec: string, capBytes: number): Promise<string> {
    assertSha(sha);
    if (!isSafePath(pathspec)) throw new GitError('bad_argument');
    const buf = await this.run(['-C', dir, 'show', '--no-color', '--no-ext-diff', '--format=', sha, '--', pathspec], { maxBuffer: Math.max(capBytes * 4, 1 << 20) });
    return buf.length <= capBytes ? buf.toString('utf8') : `${buf.subarray(0, capBytes).toString('utf8')}\n[diff cut at ${capBytes} bytes]\n`;
  }

  /** The names of the files a commit changed (files only, relative, as git prints them). */
  async changedFiles(dir: string, sha: string): Promise<string[]> {
    assertSha(sha);
    const out = await this.text(['-C', dir, 'diff-tree', '--no-commit-id', '--name-only', '-r', '--root', '-z', sha]);
    return out.split('\0').filter((n) => n !== '');
  }

  /** `git archive` of paths at a commit, as a tar buffer. */
  async archive(dir: string, sha: string, paths: readonly string[]): Promise<Buffer> {
    assertSha(sha);
    if (paths.length === 0 || !paths.every(isSafePath)) throw new GitError('bad_argument');
    return this.run(['-C', dir, 'archive', '--format=tar', sha, '--', ...paths], { maxBuffer: BIG });
  }

  /** A fresh working clone at `sha` (full copy, no shared objects, no remote that matters). */
  async cloneAt(mirror: string, dest: string, sha: string): Promise<void> {
    assertSha(sha);
    await this.run(['clone', '--quiet', '--no-hardlinks', '--no-checkout', mirror, dest], { local: true });
    await this.run(['-C', dest, 'checkout', '--quiet', '--detach', sha]);
    // The clone must not know a remote it could push to.
    await this.run(['-C', dest, 'remote', 'remove', 'origin']);
  }

  /** Stages everything and returns the lines and files changed against HEAD (`git diff --cached --numstat`). */
  async stageAndCount(dir: string): Promise<{ files: number; lines: number; paths: string[]; binary: boolean; tree: string }> {
    await this.run(['-C', dir, 'add', '-A']);
    const out = await this.text(['-C', dir, 'diff', '--cached', '--numstat', '--no-renames', '-z']);
    const counted = countNumstat(out);
    return { ...counted, tree: await this.writeTree(dir) };
  }

  /** The tree of the index (`git write-tree`): what a commit made now would hold. */
  async writeTree(dir: string): Promise<string> {
    const out = (await this.text(['-C', dir, 'write-tree'])).trim();
    if (!FULL_SHA_PATTERN.test(out)) throw new GitError('git_failed');
    return out;
  }

  /** Stages the working tree again and returns its tree: equal to the tested tree when nothing moved since. */
  async stagedTree(dir: string): Promise<string> {
    await this.run(['-C', dir, 'add', '-A']);
    return this.writeTree(dir);
  }

  /** The tree of a commit (`<sha>^{tree}`). */
  async treeOf(dir: string, sha: string): Promise<string> {
    assertSha(sha);
    const out = (await this.text(['-C', dir, 'rev-parse', '--verify', '--quiet', `${sha}^{tree}`])).trim();
    if (!FULL_SHA_PATTERN.test(out)) throw new GitError('git_failed');
    return out;
  }

  /** Fetches `exorcist/<huntId>` into `refs/proposal/exorcist/<huntId>` and returns its head. */
  async fetchFixBranch(dir: string, huntId: string): Promise<string> {
    const branch = fixBranch(huntId);
    const local = `refs/proposal/${branch}`;
    try {
      await this.run(['-C', dir, 'fetch', '--quiet', this.url, `+refs/heads/${branch}:${local}`], { auth: true });
    } catch (err) {
      throw err instanceof GitError && err.code === 'git_timeout' ? err : new GitError('fetch_failed', err instanceof GitError ? err.exitCode : null);
    }
    return this.revParse(dir, local);
  }

  private identity(): string[] {
    return ['-c', `user.name=${FIX_AUTHOR_NAME}`, '-c', `user.email=${FIX_AUTHOR_EMAIL}`, '-c', 'commit.gpgsign=false'];
  }

  /** Commits what is staged with the fixed identity and returns the new commit. */
  async commit(dir: string, message: string): Promise<string> {
    await this.run([...this.identity(), '-C', dir, 'commit', '--quiet', '--no-verify', '--allow-empty-message', '-m', message]);
    return this.revParse(dir, 'HEAD');
  }

  /** Replaces the message of HEAD (the revert gets the same message as every fix commit). */
  async amendMessage(dir: string, message: string): Promise<string> {
    await this.run([...this.identity(), '-C', dir, 'commit', '--quiet', '--no-verify', '--amend', '--allow-empty', '-m', message]);
    return this.revParse(dir, 'HEAD');
  }

  /** `git revert --no-edit <sha>`: false when it does not apply cleanly (the revert is aborted). */
  async revert(dir: string, sha: string): Promise<boolean> {
    assertSha(sha);
    try {
      await this.run([...this.identity(), '-C', dir, 'revert', '--no-edit', sha]);
      return true;
    } catch (err) {
      if (!(err instanceof GitError) || err.code === 'git_timeout') throw err;
      await this.run(['-C', dir, 'revert', '--abort']).catch(() => undefined);
      return false;
    }
  }

  async diffNames(dir: string, from: string, to: string): Promise<string[]> {
    assertSha(from);
    assertSha(to);
    return (await this.text(['-C', dir, 'diff', '--name-only', '--no-renames', '-z', from, to])).split('\0').filter((n) => n !== '');
  }

  async numstat(dir: string, from: string, to: string): Promise<{ files: number; lines: number; binary: boolean }> {
    assertSha(from);
    assertSha(to);
    const { files, lines, binary } = countNumstat(await this.text(['-C', dir, 'diff', '--numstat', '--no-renames', '-z', from, to]));
    return { files, lines, binary };
  }

  /**
   * Pushes `sha` to `incident/<huntId>` or `exorcist/<huntId>` of the remote. The branch name is built here from a valid
   * hunt id; there is no force, no `+`, no delete. Throws `push_rejected` when the remote refuses (for example a branch
   * that already exists with other history).
   */
  async push(dir: string, kind: 'incident' | 'exorcist', huntId: string, sha: string): Promise<void> {
    assertSha(sha);
    const branch = kind === 'incident' ? incidentBranch(huntId) : fixBranch(huntId);
    try {
      await this.run(['-C', dir, 'push', '--quiet', this.url, `${sha}:refs/heads/${branch}`], { auth: true });
    } catch (err) {
      throw err instanceof GitError && err.code === 'git_timeout' ? err : new GitError('push_rejected', err instanceof GitError ? err.exitCode : null);
    }
  }
}
