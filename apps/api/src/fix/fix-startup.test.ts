import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixBranch, incidentBranch } from '@haunted-ops/shared';
import { startFakeGithub, type FakeGithub } from '../../../../tools/fake-kiro-cli/fake-github.mjs';
import { FixConfigError } from './fix-config.js';
import { checkFixStartup, gitAtLeast, PROPOSAL_LABELS } from './fix-startup.js';
import { publishBranches } from './branch-publisher.js';
import { GitClient, GitError, defaultGitExec, type GitExec } from './git-client.js';
import { GithubClient } from './github-client.js';
import { ProposalError, failReasonOf } from './proposal-error.js';
import { DUMMY_GITHUB_TOKEN } from '../../test/support/fix.js';
import { deleteRefIn, makeLabRepo, syncRefsFrom, type LabRepo } from '../../test/support/lab-repo.js';

const REPO = 'Akar-Samudra-Artifisial/Haunted-Lab';
const HUNT = 'cmhuntaaaaaaaaaaaaaaaaaaa';

describe('checkFixStartup', () => {
  let fake: FakeGithub;
  beforeAll(async () => {
    fake = await startFakeGithub({ repo: REPO, token: DUMMY_GITHUB_TOKEN, expires: new Date(Date.now() + 40 * 86_400_000) });
  });
  afterAll(async () => {
    await fake.close();
  });
  const gh = (over: Partial<ConstructorParameters<typeof GithubClient>[0]> = {}) => new GithubClient({ token: DUMMY_GITHUB_TOKEN, repo: REPO, baseUrl: fake.url, sleep: async () => undefined, ...over });
  const logs: string[] = [];
  const log = (level: string, msg: string, fields?: Record<string, unknown>): void => void logs.push(JSON.stringify({ level, msg, ...fields }));
  const names = async (run: () => Promise<void>): Promise<readonly string[]> => {
    try {
      await run();
    } catch (err) {
      if (err instanceof FixConfigError) return err.variables;
      throw err;
    }
    return [];
  };

  it('makes a call only when the fix flow is on', async () => {
    fake.requests.length = 0;
    await checkFixStartup({ enabled: false }, { github: gh(), gitVersion: async () => '2.43.0', log });
    expect(fake.requests).toHaveLength(0);
  });

  it('checks the repository, creates the three labels and logs the days left without the token', async () => {
    logs.length = 0;
    await checkFixStartup({ enabled: true }, { github: gh(), gitVersion: async () => '2.43.0', log });
    expect([...fake.labels.keys()]).toEqual(PROPOSAL_LABELS.map((l) => l.name));
    const text = logs.join('\n');
    expect(text).toContain('"tokenDaysLeft":39');
    expect(text).not.toContain(DUMMY_GITHUB_TOKEN);
  });

  it('names GITHUB_TOKEN for a bad token or a token that cannot push, LAB_GITHUB_REPO for an unknown repository, FIX_ENABLED for old git', async () => {
    const deps = (github: GithubClient, gitVersion = '2.43.0') => ({ github, gitVersion: async () => gitVersion, log });
    expect(await names(() => checkFixStartup({ enabled: true }, deps(gh({ token: 'github_pat_WRONGwrongWRONGwrong0123456789' }))))).toEqual(['GITHUB_TOKEN']);
    const noPush = await startFakeGithub({ repo: REPO, token: DUMMY_GITHUB_TOKEN, canPush: false });
    expect(await names(() => checkFixStartup({ enabled: true }, deps(gh({ baseUrl: noPush.url }))))).toEqual(['GITHUB_TOKEN']);
    await noPush.close();
    expect(await names(() => checkFixStartup({ enabled: true }, deps(gh({ repo: 'someone/else' }))))).toEqual(['LAB_GITHUB_REPO']);
    expect(await names(() => checkFixStartup({ enabled: true }, deps(gh(), '2.30.9')))).toEqual(['FIX_ENABLED']);
    expect(await names(() => checkFixStartup({ enabled: true }, deps(gh(), '')))).toEqual(['FIX_ENABLED']);
    fake.failNext(503, 503, 503);
    expect(await names(() => checkFixStartup({ enabled: true }, deps(gh())))).toEqual(['LAB_GITHUB_REPO']);
  });

  it('reads git versions', () => {
    for (const [v, ok] of [['2.31.0', true], ['2.43.1', true], ['3.0.0', true], ['2.30.2', false], ['1.9.9', false], ['', false], ['x', false]] as const) expect(gitAtLeast(v, 2, 31), v).toBe(ok);
  });
});

describe('publishBranches (a local bare repository behind the fake GitHub)', () => {
  let lab: LabRepo;
  let fake: FakeGithub;
  let tmp: string;
  let git: GitClient;
  let gh: GithubClient;
  let dir: string;
  let fixSha: string;
  const pushes: string[][] = [];

  beforeAll(async () => {
    lab = makeLabRepo();
    tmp = mkdtempSync(join(tmpdir(), 'publish-'));
    fake = await startFakeGithub({ repo: REPO, token: DUMMY_GITHUB_TOKEN, syncRefs: syncRefsFrom(lab.remote), onDeleteRef: deleteRefIn(lab.remote) });
    const exec: GitExec = (file, args, opts) => {
      if (args.includes('push')) pushes.push([...args]);
      return defaultGitExec(file, args, opts);
    };
    git = new GitClient({ gitPath: '/usr/bin/git', repo: REPO, token: DUMMY_GITHUB_TOKEN, exec, remoteUrl: () => `file://${lab.remote}`, allowFileProtocol: true, home: tmp });
    gh = new GithubClient({ token: DUMMY_GITHUB_TOKEN, repo: REPO, baseUrl: fake.url, sleep: async () => undefined });
    const mirror = join(tmp, 'mirror.git');
    await git.ensureMirror(mirror);
    dir = join(tmp, 'candidate');
    await git.cloneAt(mirror, dir, lab.base);
    execFileSync('/usr/bin/git', ['-C', dir, 'revert', '--no-edit', lab.culprit], { env: { PATH: '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.invalid', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@example.invalid' } });
    fixSha = await git.revParse(dir, 'HEAD');
  });
  afterAll(async () => {
    await fake.close();
    lab.cleanup();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('pushes the incident branch at the deployed commit and the fix branch, and nothing else', async () => {
    const out = await publishBranches({ git, github: gh }, { huntId: HUNT, dir, baseSha: lab.base, fixSha });
    expect(out).toEqual({ baseBranch: incidentBranch(HUNT), branch: fixBranch(HUNT) });
    const refs = execFileSync('git', ['-C', lab.remote, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'], { encoding: 'utf8' }).trim().split('\n');
    expect(refs).toEqual([
      `refs/heads/exorcist/${HUNT} ${fixSha}`,
      `refs/heads/incident/${HUNT} ${lab.base}`,
      `refs/heads/main ${lab.main}`,
      `refs/heads/scenario/error-spike ${lab.culprit}`,
      `refs/heads/scenario/other ${lab.other}`,
    ]);
    expect(pushes).toHaveLength(2);
    for (const p of pushes) expect(p.join(' ')).not.toMatch(/--force|--delete|\+refs|refs\/heads\/(main|scenario)/);
  });

  it('treats branches already at the commits it would push as done: a retry after the push went through', async () => {
    const before = pushes.length;
    await expect(publishBranches({ git, github: gh }, { huntId: HUNT, dir, baseSha: lab.base, fixSha })).resolves.toEqual({ baseBranch: incidentBranch(HUNT), branch: fixBranch(HUNT) });
    expect(pushes).toHaveLength(before);
    expect(execFileSync('git', ['-C', lab.remote, 'rev-parse', `refs/heads/exorcist/${HUNT}`], { encoding: 'utf8' }).trim()).toBe(fixSha);
  });

  it('replaces a leftover branch of this Hunt (no open pull request), and pushes only what is missing', async () => {
    // A partial push of an earlier attempt: the incident branch is at D, the fix branch is at another commit.
    const other = 'cmhuntbbbbbbbbbbbbbbbbbbb';
    execFileSync('git', ['-C', lab.remote, 'update-ref', `refs/heads/incident/${other}`, lab.base]);
    execFileSync('git', ['-C', lab.remote, 'update-ref', `refs/heads/exorcist/${other}`, lab.main]);
    const before = pushes.length;
    await publishBranches({ git, github: gh }, { huntId: other, dir, baseSha: lab.base, fixSha });
    expect(execFileSync('git', ['-C', lab.remote, 'rev-parse', `refs/heads/exorcist/${other}`], { encoding: 'utf8' }).trim()).toBe(fixSha);
    // One push: the fix branch. The incident branch was already right.
    expect(pushes.slice(before).map((p) => p.at(-1))).toEqual([`${fixSha}:refs/heads/exorcist/${other}`]);
    expect(fake.requests.some((r) => r.method === 'DELETE' && r.path.endsWith(`/git/refs/heads/exorcist/${other}`))).toBe(true);
    expect(fake.requests.some((r) => r.method === 'DELETE' && /heads\/(main|scenario)/.test(r.path))).toBe(false);
  });

  it('refuses (branch_exists) and changes nothing when an open pull request uses the leftover branch', async () => {
    const third = 'cmhuntccccccccccccccccccc';
    execFileSync('git', ['-C', lab.remote, 'update-ref', `refs/heads/incident/${third}`, lab.main]);
    execFileSync('git', ['-C', lab.remote, 'update-ref', `refs/heads/exorcist/${third}`, lab.main]);
    await gh.createPull({ title: 'open', head: `exorcist/${third}`, base: `incident/${third}`, body: 'x' });
    const before = { pushes: pushes.length, deletes: fake.requests.filter((r) => r.method === 'DELETE').length };
    await expect(publishBranches({ git, github: gh }, { huntId: third, dir, baseSha: lab.base, fixSha })).rejects.toMatchObject({ reason: 'branch_exists' });
    expect({ pushes: pushes.length, deletes: fake.requests.filter((r) => r.method === 'DELETE').length }).toEqual(before);
    expect(execFileSync('git', ['-C', lab.remote, 'rev-parse', `refs/heads/incident/${third}`], { encoding: 'utf8' }).trim()).toBe(lab.main);
  });

  it('refuses a hunt id that is not a CUID before it asks GitHub or starts git', async () => {
    const before = { requests: fake.requests.length, pushes: pushes.length };
    for (const bad of ['main', '../x', 'scenario/error-spike', 'cmhunt id']) await expect(publishBranches({ git, github: gh }, { huntId: bad, dir, baseSha: lab.base, fixSha })).rejects.toThrow();
    expect({ requests: fake.requests.length, pushes: pushes.length }).toEqual(before);
  });

  it('maps a rejected push and the errors of GitHub to fixed reasons', () => {
    expect(failReasonOf(new GitError('push_rejected', 1))).toBe('push_rejected');
    expect(failReasonOf(new GitError('fetch_failed', 128))).toBe('github_unavailable');
    expect(failReasonOf(new GitError('git_failed', 1))).toBe('internal');
    expect(failReasonOf(new ProposalError('head_changed'))).toBe('head_changed');
    expect(failReasonOf(new Error(`boom ${DUMMY_GITHUB_TOKEN}`))).toBe('internal');
  });
});

// Feature: fix-proposal-flow, Property 3 (git and GitHub part)
describe('Property 3: the token is only in the environment of git push and git fetch', () => {
  it('holds for any hunt id, sha and error text that git or GitHub could produce', async () => {
    const calls: Array<{ args: string[]; env: Record<string, string> }> = [];
    const noise = fc.string({ maxLength: 40 });
    await fc.assert(
      fc.asyncProperty(fc.stringMatching(/^[a-z0-9]{25}$/), fc.stringMatching(/^[0-9a-f]{40}$/), noise, async (id, sha, text) => {
        calls.length = 0;
        const exec: GitExec = async (_f, args, opts) => {
          calls.push({ args: [...args], env: { ...opts.env } });
          // git prints the header it was given when it fails: the error must not carry it.
          if (args.includes('push')) throw new GitError('git_failed', 1);
          return { stdout: Buffer.from(`${text} ${DUMMY_GITHUB_TOKEN}`) };
        };
        const client = new GitClient({ gitPath: '/usr/bin/git', repo: REPO, token: DUMMY_GITHUB_TOKEN, exec, home: '/tmp/h' });
        const err = await client.push('/tmp/x', 'exorcist', id, sha).catch((e: unknown) => e);
        await client.fetchBase('/tmp/m').catch(() => undefined);
        await client.revParse('/tmp/m', 'main').catch(() => undefined);
        expect(err).toMatchObject({ code: 'push_rejected' });
        expect(JSON.stringify(err)).not.toContain(DUMMY_GITHUB_TOKEN);
        const b64 = Buffer.from(`x-access-token:${DUMMY_GITHUB_TOKEN}`).toString('base64');
        for (const c of calls) {
          expect(c.args.join(' ')).not.toContain(DUMMY_GITHUB_TOKEN);
          expect(c.args.join(' ')).not.toContain(b64);
          const carries = Object.values(c.env).some((v) => v.includes(b64) || v.includes(DUMMY_GITHUB_TOKEN));
          expect(carries).toBe(c.args.includes('push') || c.args.includes('fetch'));
          if (carries) expect(c.env.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraheader');
        }
      }),
      { numRuns: 100 },
    );
  });
});
