import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixBranch, incidentBranch } from '@haunted-ops/shared';
import { GitClient, GitError, authEnv, defaultGitExec, type GitExec } from './git-client.js';
import { judgePatch, type Patch } from './patch-checks.js';
import { DUMMY_GITHUB_TOKEN } from '../../test/support/fix.js';
import { BROKEN_CHARGE, HEALTHY_CHARGE, makeLabRepo, type LabRepo } from '../../test/support/lab-repo.js';

const HUNT = 'cmhuntaaaaaaaaaaaaaaaaaaa';
const git = '/usr/bin/git';

interface Call {
  args: string[];
  env: Record<string, string>;
}

function recording(): { exec: GitExec; calls: Call[] } {
  const calls: Call[] = [];
  const exec: GitExec = (file, args, opts) => {
    calls.push({ args: [...args], env: { ...opts.env } });
    return defaultGitExec(file, args, opts);
  };
  return { exec, calls };
}

describe('GitClient (local repositories, fixed authors and dates)', () => {
  let lab: LabRepo;
  let tmp: string;
  let seen: ReturnType<typeof recording>;
  let client: GitClient;
  let mirror: string;

  beforeAll(async () => {
    lab = makeLabRepo();
    tmp = mkdtempSync(join(tmpdir(), 'git-client-'));
    seen = recording();
    client = new GitClient({
      gitPath: git,
      repo: 'owner/name',
      token: DUMMY_GITHUB_TOKEN,
      exec: seen.exec,
      remoteUrl: () => `file://${lab.remote}`,
      allowFileProtocol: true,
      home: tmp,
      commitDate: () => new Date('2026-11-14T10:00:00.000Z'),
    });
    mirror = join(tmp, 'mirror.git');
    await client.ensureMirror(mirror);
  });
  afterAll(() => {
    lab.cleanup();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('makes a bare mirror of main and the scenario branches only, with no remote in its configuration', () => {
    const refs = execFileSync(git, ['-C', mirror, 'for-each-ref', '--format=%(refname) %(objectname)'], { encoding: 'utf8' }).trim().split('\n');
    expect(refs).toEqual([`refs/heads/main ${lab.main}`, `refs/heads/scenario/error-spike ${lab.culprit}`, `refs/heads/scenario/other ${lab.other}`]);
    const config = readFileSync(join(mirror, 'config'), 'utf8');
    expect(config).not.toContain('[remote');
    expect(config).not.toContain('file://');
  });

  it('runs every call with an array, no hooks, no global configuration and no credential helper', () => {
    expect(seen.calls.length).toBeGreaterThan(0);
    for (const c of seen.calls) {
      const joined = c.args.join(' ');
      expect(c.env).toBeDefined();
      expect(joined).toContain('core.hooksPath=/dev/null');
      expect(joined).toContain('credential.helper=');
      expect(c.env.GIT_CONFIG_GLOBAL).toBe('/dev/null');
      expect(c.env.GIT_CONFIG_NOSYSTEM).toBe('1');
      expect(c.env.GIT_TERMINAL_PROMPT).toBe('0');
      expect(c.env.HOME).toBe(tmp);
      expect(Object.keys(c.env).sort()).toEqual(expect.arrayContaining(['PATH', 'HOME', 'LC_ALL']));
      // The token is never in an argument, whatever the call.
      expect(joined).not.toContain(DUMMY_GITHUB_TOKEN);
      expect(joined).not.toContain(Buffer.from(`x-access-token:${DUMMY_GITHUB_TOKEN}`).toString('base64'));
    }
  });

  it('gives the token only to fetch and push, as GIT_CONFIG_* for https://github.com/', async () => {
    seen.calls.length = 0;
    await client.fetchBase(mirror);
    const fetchCall = seen.calls.find((c) => c.args.includes('fetch'));
    expect(fetchCall?.env).toMatchObject({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader' });
    expect(fetchCall?.env.GIT_CONFIG_VALUE_0).toBe(authEnv(DUMMY_GITHUB_TOKEN).GIT_CONFIG_VALUE_0);
    // Local operations have none of it.
    seen.calls.length = 0;
    await client.revParse(mirror, 'main');
    await client.showDiff(mirror, lab.culprit, 'services/payments', 10_000);
    for (const c of seen.calls) expect(Object.keys(c.env).filter((k) => k.startsWith('GIT_CONFIG_') && k !== 'GIT_CONFIG_GLOBAL' && k !== 'GIT_CONFIG_NOSYSTEM')).toEqual([]);
    expect(authEnv('x').GIT_CONFIG_VALUE_0?.startsWith('AUTHORIZATION: basic ')).toBe(true);
  });

  it('reads commits: parents, ancestry, the base check, the diff of a commit and the files it changed', async () => {
    expect(await client.revParse(mirror, 'scenario/error-spike')).toBe(lab.culprit);
    expect(await client.hasCommit(mirror, lab.culprit)).toBe(true);
    expect(await client.hasCommit(mirror, 'f'.repeat(40))).toBe(false);
    expect(await client.parents(mirror, lab.culprit)).toEqual([lab.main]);
    expect(await client.isAncestor(mirror, lab.main, lab.culprit)).toBe(true);
    expect(await client.isAncestor(mirror, lab.culprit, lab.main)).toBe(false);
    expect(await client.descendsFromBase(mirror, lab.culprit)).toBe(true);
    expect(await client.descendsFromBase(mirror, 'e'.repeat(40))).toBe(false);
    expect(await client.changedFiles(mirror, lab.culprit)).toEqual(['services/payments/src/charge.js']);
    const diff = await client.showDiff(mirror, lab.culprit, 'services/payments', 10_000);
    expect(diff).toContain('-  if (!order');
    const cut = await client.showDiff(mirror, lab.culprit, 'services/payments', 40);
    expect(cut).toContain('[diff cut at 40 bytes]');
  });

  it('exports the paths of a commit with git archive', async () => {
    const tar = await client.archive(mirror, lab.base, ['services/payments', 'packages/lab-common']);
    const dir = mkdtempSync(join(tmp, 'untar-'));
    execFileSync('tar', ['-x', '-C', dir], { input: tar });
    expect(readFileSync(join(dir, 'services/payments/src/charge.js'), 'utf8')).toBe(BROKEN_CHARGE);
    expect(existsSync(join(dir, 'services/orders'))).toBe(false);
    expect(existsSync(join(dir, '.git'))).toBe(false);
    await expect(client.archive(mirror, lab.base, ['../etc'])).rejects.toBeInstanceOf(GitError);
    await expect(client.archive(mirror, lab.base, ['-x'])).rejects.toBeInstanceOf(GitError);
    await expect(client.archive(mirror, lab.base, [])).rejects.toBeInstanceOf(GitError);
  });

  it('makes a fresh clone at a commit with no remote, stages a change, counts it and commits with the fixed identity and date', async () => {
    const dest = join(tmp, 'candidate');
    await client.cloneAt(mirror, dest, lab.base);
    expect(execFileSync(git, ['-C', dest, 'remote'], { encoding: 'utf8' }).trim()).toBe('');
    expect(execFileSync(git, ['-C', dest, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(lab.base);
    writeFileSync(join(dest, 'services/payments/src/charge.js'), HEALTHY_CHARGE);
    writeFileSync(join(dest, 'services/payments/src/extra.js'), 'export const x = 1;\n');
    const count = await client.stageAndCount(dest);
    expect(count.files).toBe(2);
    // The guard line comes back (+1) and the new file has one line (+1).
    expect(count.lines).toBe(2);
    expect(count.paths.sort()).toEqual(['services/payments/src/charge.js', 'services/payments/src/extra.js']);
    const fix = await client.commit(dest, 'Fix charge\n\nHunt: x');
    const info = execFileSync(git, ['-C', dest, 'log', '-1', '--format=%an|%ae|%cn|%ce|%at|%ct|%P'], { encoding: 'utf8' }).trim();
    const t = Date.parse('2026-11-14T10:00:00.000Z') / 1000;
    expect(info).toBe(`Exorcist|exorcist@users.noreply.github.com|Exorcist|exorcist@users.noreply.github.com|${t}|${t}|${lab.base}`);
    expect(await client.numstat(dest, lab.base, fix)).toEqual({ files: 2, lines: count.lines, binary: false });
    expect(count.binary).toBe(false);
    // The tree that was counted is the tree that was committed.
    expect(await client.treeOf(dest, fix)).toBe(count.tree);
    expect(await client.diffNames(dest, lab.base, fix)).toEqual(['services/payments/src/charge.js', 'services/payments/src/extra.js']);
  });

  it('never counts a `-` numstat as 0 lines: a `-diff` attribute makes the change binary, and the patch is refused', async () => {
    const dest = join(tmp, 'minus-diff');
    await client.cloneAt(mirror, dest, lab.base);
    // The fixer writes `src/.gitattributes` with `* -diff` and a 200-line change: git then prints `-` for every count.
    writeFileSync(join(dest, 'services/payments/src/.gitattributes'), '* -diff\n');
    writeFileSync(join(dest, 'services/payments/src/charge.js'), Array.from({ length: 200 }, (_, i) => `export const l${i} = ${i};\n`).join(''));
    const count = await client.stageAndCount(dest);
    expect(count.binary).toBe(true);
    expect(count.lines).toBe(0);
    const patch: Patch = {
      changed: [{ path: 'services/payments/src/charge.js', content: 'x' }],
      added: [{ path: 'services/payments/src/.gitattributes', content: '* -diff\n' }],
      deleted: [],
      unreadable: [],
    };
    const ok = { syntax: () => true, tests: () => ({ ok: true, ran: 3, timedOut: false }) };
    const ctx = { service: 'payments' as const, requireTests: true, culpritFiles: [] };
    // Refused for its name, before anything is counted...
    expect(await judgePatch(patch, ctx, { ...ok, size: () => count })).toMatchObject({ accepted: false, aiFailReason: 'forbidden_file' });
    // ...and the count alone refuses it too: the same `-` counts with a plain name (a `-diff` the repository set).
    const plain: Patch = { ...patch, added: [] };
    const judged = await judgePatch(plain, ctx, { ...ok, size: () => count });
    expect(judged).toMatchObject({ accepted: false, aiFailReason: 'forbidden_file' });
    expect(judged.checks.at(-1)).toEqual({ name: 'size', ok: false });
  });

  it('pushes the two proposal branches without force, and refuses a second push over other history', async () => {
    const dest = join(tmp, 'pushing');
    await client.cloneAt(mirror, dest, lab.base);
    await client.push(dest, 'incident', HUNT, lab.base);
    writeFileSync(join(dest, 'services/payments/src/charge.js'), HEALTHY_CHARGE);
    await client.stageAndCount(dest);
    const fix = await client.commit(dest, 'Fix');
    await client.push(dest, 'exorcist', HUNT, fix);
    const refs = execFileSync(git, ['-C', lab.remote, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/incident', 'refs/heads/exorcist'], { encoding: 'utf8' }).trim().split('\n');
    expect(refs).toEqual([`refs/heads/exorcist/${HUNT} ${fix}`, `refs/heads/incident/${HUNT} ${lab.base}`]);
    // A different history for the same branch is not a fast-forward: refused, never forced.
    const other = join(tmp, 'pushing-other');
    await client.cloneAt(mirror, other, lab.base);
    writeFileSync(join(other, 'services/payments/src/other.js'), 'export const y = 2;\n');
    await client.stageAndCount(other);
    const diverged = await client.commit(other, 'Other');
    await expect(client.push(other, 'exorcist', HUNT, diverged)).rejects.toMatchObject({ code: 'push_rejected' });
    expect(execFileSync(git, ['-C', lab.remote, 'rev-parse', `refs/heads/exorcist/${HUNT}`], { encoding: 'utf8' }).trim()).toBe(fix);
    // The pushed incident branch can be fetched back (the merge step reads it this way).
    expect(await client.fetchIncidentBranch(mirror, HUNT)).toBe(lab.base);
    // The remote never got `main` or a scenario branch from a push.
    expect(execFileSync(git, ['-C', lab.remote, 'rev-parse', 'refs/heads/main'], { encoding: 'utf8' }).trim()).toBe(lab.main);
  });

  it('reverts a commit, and says so when it does not apply', async () => {
    const clean = join(tmp, 'revert-clean');
    await client.cloneAt(mirror, clean, lab.base);
    expect(await client.revert(clean, lab.culprit)).toBe(true);
    expect(readFileSync(join(clean, 'services/payments/src/charge.js'), 'utf8')).toBe(HEALTHY_CHARGE);
    const conflict = join(tmp, 'revert-conflict');
    await client.cloneAt(mirror, conflict, lab.base);
    writeFileSync(join(conflict, 'services/payments/src/charge.js'), 'export const changed = true;\n');
    execFileSync(git, ['-C', conflict, 'add', '-A']);
    await client.commit(conflict, 'Change');
    expect(await client.revert(conflict, lab.culprit)).toBe(false);
    // The failed revert was aborted: the tree is clean and no revert is in progress.
    expect(existsSync(join(conflict, '.git/REVERT_HEAD'))).toBe(false);
    expect(execFileSync(git, ['-C', conflict, 'status', '--porcelain'], { encoding: 'utf8' }).trim()).toBe('');
  });

  it('refuses a bad argument before it starts any process', async () => {
    const before = seen.calls.length;
    await expect(client.push(tmp, 'exorcist', 'main', lab.base)).rejects.toThrow();
    await expect(client.push(tmp, 'incident', HUNT, 'HEAD')).rejects.toBeInstanceOf(GitError);
    await expect(client.fetchIncidentBranch(mirror, '../x')).rejects.toThrow();
    await expect(client.showDiff(mirror, lab.base, '-p', 100)).rejects.toBeInstanceOf(GitError);
    await expect(client.revParse(mirror, '--all')).rejects.toBeInstanceOf(GitError);
    await expect(client.isAncestor(mirror, 'main', lab.base)).rejects.toBeInstanceOf(GitError);
    expect(seen.calls.length).toBe(before);
  });

  it('has fixed codes for failures and keeps no git output', async () => {
    const err = await client.revParse(mirror, 'no-such-branch').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    expect(String((err as Error).message)).toBe('git_failed');
    expect(JSON.stringify(err)).not.toContain('fatal');
    const bad = new GitClient({ gitPath: '/nonexistent/git', repo: 'o/n', token: null, home: tmp });
    await expect(bad.revParse(mirror, 'main')).rejects.toMatchObject({ code: 'git_failed' });
  });
});

describe('the refs a push can name', () => {
  // Feature: fix-proposal-flow, Property 2 (git part): only incident/<cuid> and exorcist/<cuid> reach a push.
  it('builds a push destination only from a valid CUID, and starts no process for anything else', async () => {
    const calls: Call[] = [];
    const exec: GitExec = async (_f, args, opts) => {
      calls.push({ args: [...args], env: opts.env });
      return { stdout: Buffer.alloc(0) };
    };
    const client = new GitClient({ gitPath: git, repo: 'o/n', token: DUMMY_GITHUB_TOKEN, exec, home: '/tmp/h' });
    const sha = 'a'.repeat(40);
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 40 }), fc.constantFrom('incident' as const, 'exorcist' as const), async (id, kind) => {
        calls.length = 0;
        const valid = /^[a-z0-9]{20,32}$/.test(id);
        const run = client.push('/tmp/x', kind, id, sha);
        if (!valid) {
          await expect(run).rejects.toThrow();
          expect(calls).toHaveLength(0);
          return;
        }
        await run;
        expect(calls).toHaveLength(1);
        const dest = calls[0]?.args.at(-1);
        expect(dest).toBe(`${sha}:refs/heads/${kind === 'incident' ? incidentBranch(id) : fixBranch(id)}`);
        expect(calls[0]?.args.join(' ')).not.toMatch(/--force|--delete|\+refs|:refs\/heads\/(main|scenario)/);
        expect(calls[0]?.args.join(' ')).not.toContain(DUMMY_GITHUB_TOKEN);
      }),
      { numRuns: 200 },
    );
  });
});
