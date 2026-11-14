import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GitClient } from './git-client.js';
import { attemptRevert, judgeRevert, revertFileProblems } from './revert.js';
import { HEALTHY_CHARGE, gitIn, makeLabRepo, type LabRepo } from '../../test/support/lab-repo.js';

describe('the revert fallback (local repositories)', () => {
  let lab: LabRepo;
  let tmp: string;
  let mirror: string;
  let git: GitClient;
  let n = 0;
  let conflictBase: string;
  let mergeCommit: string;

  const sync = async (): Promise<void> => {
    execFileSync('git', ['-C', lab.work, 'push', '--quiet', lab.remote, '--all'], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null' } });
    await git.ensureMirror(mirror);
  };

  beforeAll(async () => {
    lab = makeLabRepo();
    tmp = mkdtempSync(join(tmpdir(), 'revert-'));
    git = new GitClient({ gitPath: '/usr/bin/git', repo: 'o/n', token: null, remoteUrl: () => `file://${lab.remote}`, allowFileProtocol: true, home: tmp });
    mirror = join(tmp, 'm.git');
    // A scenario head that changed the same lines after the culprit: reverting the culprit there conflicts.
    gitIn(lab.work, ['checkout', '--quiet', '-b', 'scenario/conflict', lab.culprit]);
    writeFileSync(join(lab.work, 'services/payments/src/charge.js'), 'export const changed = true;\n');
    gitIn(lab.work, ['add', '-A']);
    gitIn(lab.work, ['commit', '--quiet', '-m', 'rewrite charge']);
    conflictBase = gitIn(lab.work, ['rev-parse', 'HEAD']);
    // A merge commit as the culprit.
    gitIn(lab.work, ['checkout', '--quiet', '-b', 'scenario/merge', lab.main]);
    gitIn(lab.work, ['merge', '--quiet', '--no-ff', '--no-edit', 'scenario/other']);
    mergeCommit = gitIn(lab.work, ['rev-parse', 'HEAD']);
    await sync();
  });
  afterAll(() => {
    lab.cleanup();
    rmSync(tmp, { recursive: true, force: true });
  });

  const clone = async (at: string): Promise<string> => {
    const dir = join(tmp, `c${++n}`);
    await git.cloneAt(mirror, dir, at);
    return dir;
  };
  const run = async (dir: string, base: string, culprit: string) => attemptRevert(git, { mirror, clone: dir, base, culprit, message: 'Exorcist: revert\n\nHunt: x' });

  it('reverts the culprit commit on top of the deployed commit, and says which files it changed', async () => {
    const dir = await clone(lab.base);
    const out = await run(dir, lab.base, lab.culprit);
    expect(out).toMatchObject({ ok: true, files: ['services/payments/src/charge.js'] });
    expect(readFileSync(join(dir, 'services/payments/src/charge.js'), 'utf8')).toBe(HEALTHY_CHARGE);
    const message = execFileSync('git', ['-C', dir, 'log', '-1', '--format=%s|%an'], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();
    expect(message).toBe('Exorcist: revert|Exorcist');
  });

  it('is unavailable for a culprit that is not an ancestor, is unknown or is a merge commit', async () => {
    for (const culprit of [lab.other, 'f'.repeat(40), mergeCommit]) {
      const base = culprit === mergeCommit ? mergeCommit : lab.base;
      const dir = await clone(base);
      expect(await run(dir, base, culprit), culprit).toEqual({ ok: false, reason: 'revert_unavailable' });
    }
  });

  it('is a conflict when the culprit does not revert cleanly, and leaves the clone clean', async () => {
    const dir = await clone(conflictBase);
    expect(await run(dir, conflictBase, lab.culprit)).toEqual({ ok: false, reason: 'revert_conflict' });
    expect(execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim()).toBe('');
  });

  it('finds files of a revert that are not plain text, and forgives a deleted file', async () => {
    const dir = await clone(lab.base);
    mkdirSync(join(dir, 'services/payments/src'), { recursive: true });
    writeFileSync(join(dir, 'services/payments/src/ok.js'), 'x');
    writeFileSync(join(dir, 'services/payments/src/bin.js'), Buffer.from([0x61, 0, 0x62]));
    writeFileSync(join(dir, 'services/payments/src/bad.js'), Buffer.from([0xff, 0xfe]));
    symlinkSync('/etc/hosts', join(dir, 'services/payments/src/link.js'));
    mkdirSync(dirname(join(dir, 'services/payments/src/sub/x.js')), { recursive: true });
    expect(await revertFileProblems(dir, ['services/payments/src/ok.js', 'services/payments/src/gone.js'])).toEqual([]);
    expect((await revertFileProblems(dir, ['services/payments/src/bin.js', 'services/payments/src/bad.js', 'services/payments/src/link.js', 'services/payments/src/sub'])).sort()).toEqual(
      ['services/payments/src/bad.js', 'services/payments/src/bin.js', 'services/payments/src/link.js', 'services/payments/src/sub'].sort(),
    );
  });

  describe('judgeRevert', () => {
    const ok = { problems: () => [] as string[], tests: () => ({ ok: true, ran: 2, timedOut: false }) };
    const files = ['services/payments/package.json', 'services/payments/src/charge.js', 'services/payments/config/app.yaml'];

    it('takes any file of the service (no src limit, no size limit) when the tests pass', async () => {
      expect(await judgeRevert({ service: 'payments', files, requireTests: true }, ok)).toEqual({
        accepted: true,
        checks: [{ name: 'scope', ok: true }, { name: 'forbidden_file', ok: true }, { name: 'tests', ok: true }],
      });
    });

    it('refuses a file outside the service, a file that is not text, and failing or missing tests', async () => {
      expect((await judgeRevert({ service: 'payments', files: [...files, 'services/orders/src/a.js'], requireTests: true }, ok)).checks).toEqual([{ name: 'scope', ok: false }]);
      expect((await judgeRevert({ service: 'payments', files: [], requireTests: true }, ok)).accepted).toBe(false);
      expect((await judgeRevert({ service: 'payments', files, requireTests: true }, { ...ok, problems: () => ['x'] })).checks).toEqual([{ name: 'scope', ok: true }, { name: 'forbidden_file', ok: false }]);
      expect((await judgeRevert({ service: 'payments', files, requireTests: true }, { ...ok, tests: () => ({ ok: false, ran: 2, timedOut: false }) })).accepted).toBe(false);
      expect((await judgeRevert({ service: 'payments', files, requireTests: true }, { ...ok, tests: () => ({ ok: true, ran: 0, timedOut: false }) })).accepted).toBe(false);
      expect((await judgeRevert({ service: 'payments', files, requireTests: false }, { ...ok, tests: () => ({ ok: true, ran: 0, timedOut: false }) })).accepted).toBe(true);
      expect((await judgeRevert({ service: 'payments', files, requireTests: true }, { ...ok, tests: () => ({ ok: true, ran: 2, timedOut: true }) })).accepted).toBe(false);
    });
  });
});
