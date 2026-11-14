import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startFakeGithub, type FakeGithub } from '../../../../tools/fake-kiro-cli/fake-github.mjs';
import { GITHUB_API, GithubClient, GithubError } from './github-client.js';
import { DUMMY_GITHUB_TOKEN } from '../../test/support/fix.js';

const REPO = 'Akar-Samudra-Artifisial/Haunted-Lab';
const HUNT = 'cmhuntaaaaaaaaaaaaaaaaaaa';
const INCIDENT = `incident/${HUNT}`;
const FIX = `exorcist/${HUNT}`;
const SHA = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const LABELS = [
  { name: 'exorcist', color: '5b3fa0', description: 'Written by the Exorcist' },
  { name: 'ai_patch', color: '7a4fd0', description: 'An AI patch' },
  { name: 'revert', color: 'a05f3f', description: 'A revert' },
];

describe('GithubClient (fake GitHub server)', () => {
  let fake: FakeGithub;
  let waits: number[];
  const make = (over: Partial<ConstructorParameters<typeof GithubClient>[0]> = {}): GithubClient =>
    new GithubClient({ token: DUMMY_GITHUB_TOKEN, repo: REPO, baseUrl: fake.url, sleep: async (ms) => void waits.push(ms), ...over });

  beforeAll(async () => {
    fake = await startFakeGithub({ repo: REPO, token: DUMMY_GITHUB_TOKEN, expires: new Date(Date.now() + 10.5 * 86_400_000) });
  });
  afterAll(async () => {
    await fake.close();
  });
  beforeEach(() => {
    waits = [];
    fake.refs.clear();
    fake.pulls.length = 0;
    fake.labels.clear();
    fake.requests.length = 0;
  });

  it('reads the repository, the push right and the days left on the token', async () => {
    const info = await make().getRepo();
    expect(info.canPush).toBe(true);
    expect(info.tokenDaysLeft).toBe(10);
    const noPush = await startFakeGithub({ repo: REPO, token: DUMMY_GITHUB_TOKEN, canPush: false });
    expect((await make({ baseUrl: noPush.url }).getRepo()).canPush).toBe(false);
    await noPush.close();
  });

  it('answers a bad token with a fixed code and keeps nothing of the answer', async () => {
    const err = await make({ token: 'github_pat_WRONGwrongWRONGwrong0123456789' }).getRepo().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GithubError);
    expect(err).toMatchObject({ code: 'github_unauthorized', status: 401, message: 'github_unauthorized' });
    expect(JSON.stringify(err)).not.toContain('Bad credentials');
    expect(JSON.stringify(err)).not.toContain('WRONG');
  });

  it('creates the labels that are missing and none that exist', async () => {
    const c = make();
    await c.ensureLabels(LABELS);
    expect([...fake.labels.keys()]).toEqual(['exorcist', 'ai_patch', 'revert']);
    fake.requests.length = 0;
    await c.ensureLabels(LABELS);
    expect(fake.requests.filter((r) => r.method === 'POST')).toHaveLength(0);
  });

  it('reads the head of a proposal branch, null when it does not exist, and refuses any other name', async () => {
    const c = make();
    fake.refs.set(INCIDENT, SHA);
    expect(await c.branchHead(INCIDENT)).toBe(SHA);
    expect(await c.branchHead(FIX)).toBeNull();
    for (const bad of ['main', 'scenario/error-spike', 'incident/../main']) await expect(c.branchHead(bad), bad).rejects.toMatchObject({ code: 'github_bad_response' });
  });

  it('asks whether a branch exists, and refuses any other name before a request', async () => {
    const c = make();
    fake.refs.set(INCIDENT, SHA);
    expect(await c.branchExists(INCIDENT)).toBe(true);
    expect(await c.branchExists(FIX)).toBe(false);
    fake.requests.length = 0;
    for (const bad of ['main', 'scenario/error-spike', '../x', `incident/${HUNT}/x`, 'incident/short']) await expect(c.branchExists(bad)).rejects.toMatchObject({ code: 'github_bad_response' });
    expect(fake.requests).toHaveLength(0);
  });

  it('opens a pull request, adds the labels, and validates what comes back', async () => {
    const c = make();
    await c.ensureLabels(LABELS);
    fake.refs.set(INCIDENT, SHA);
    fake.refs.set(FIX, SHA2);
    const pr = await c.createPull({ title: 'Exorcist: restore the guard', head: FIX, base: INCIDENT, body: 'AI generated, review before merging' });
    expect(pr).toEqual({ number: 1, htmlUrl: `https://github.com/${REPO}/pull/1` });
    await c.addLabels(1, ['exorcist', 'ai_patch']);
    expect(fake.pulls[0]).toMatchObject({ head: FIX, base: INCIDENT, labels: ['exorcist', 'ai_patch'], state: 'open', headSha: SHA2 });
    // A second pull request for the same head, a missing branch and unknown labels are refused with fixed codes.
    await expect(c.createPull({ title: 'again', head: FIX, base: INCIDENT, body: '' })).rejects.toMatchObject({ code: 'github_unprocessable' });
    await expect(c.createPull({ title: 'x', head: 'main', base: INCIDENT, body: '' })).rejects.toMatchObject({ code: 'github_bad_response' });
    await expect(c.addLabels(1, ['nope'])).rejects.toMatchObject({ code: 'github_unprocessable' });
  });

  it('polls a pull request with its ETag and reads the merge', async () => {
    const c = make();
    fake.refs.set(INCIDENT, SHA);
    fake.refs.set(FIX, SHA2);
    await c.createPull({ title: 'Exorcist: x', head: FIX, base: INCIDENT, body: 'b' });
    const first = await c.getPull(1, null);
    expect(first).toMatchObject({ kind: 'ok', pull: { number: 1, state: 'open', merged: false, mergeCommitSha: null, mergedBy: null, headSha: SHA2, headRef: FIX, baseRef: INCIDENT } });
    const etag = first.kind === 'ok' ? first.etag : null;
    expect(etag).toMatch(/^W\/"/);
    expect(await c.getPull(1, etag)).toEqual({ kind: 'not_modified' });
    fake.merge(1, { mergeSha: 'c'.repeat(40), by: 'octocat' });
    const merged = await c.getPull(1, etag);
    expect(merged).toMatchObject({ kind: 'ok', pull: { state: 'closed', merged: true, mergeCommitSha: 'c'.repeat(40), mergedBy: 'octocat' } });
    expect(await c.getPull(99, null).catch((e: unknown) => (e as GithubError).code)).toBe('github_not_found');
  });

  it('reads a pull request that was closed without a merge, and one whose head moved', async () => {
    const c = make();
    fake.refs.set(INCIDENT, SHA);
    fake.refs.set(FIX, SHA2);
    await c.createPull({ title: 'Exorcist: x', head: FIX, base: INCIDENT, body: 'b' });
    fake.setHead(1, 'd'.repeat(40));
    expect(await c.getPull(1, null)).toMatchObject({ kind: 'ok', pull: { headSha: 'd'.repeat(40), merged: false } });
    fake.closeUnmerged(1);
    expect(await c.getPull(1, null)).toMatchObject({ kind: 'ok', pull: { state: 'closed', merged: false } });
  });

  it('waits for a rate limit with a bound and retries, and gives up with a fixed code', async () => {
    fake.rateLimit(2, 3);
    expect((await make().getRepo()).canPush).toBe(true);
    expect(waits).toEqual([3000, 3000]);
    waits.length = 0;
    fake.rateLimit(9, 1000);
    await expect(make().getRepo()).rejects.toMatchObject({ code: 'github_rate_limited', status: 429 });
    // The wait never goes over the bound, and the retries are bounded.
    expect(waits).toHaveLength(3);
    expect(Math.max(...waits)).toBeLessThanOrEqual(60_000);
    fake.rateLimit(0);
    waits.length = 0;
    fake.rateLimit(1);
    await make().getRepo();
    expect(waits).toEqual([1000]);
  });

  it('does not count a 304 as a retry or a failure', async () => {
    const c = make();
    fake.refs.set(INCIDENT, SHA);
    fake.refs.set(FIX, SHA2);
    await c.createPull({ title: 'Exorcist: x', head: FIX, base: INCIDENT, body: 'b' });
    const first = await c.getPull(1, null);
    const etag = first.kind === 'ok' ? first.etag : null;
    waits.length = 0;
    for (let i = 0; i < 5; i++) expect(await c.getPull(1, etag)).toEqual({ kind: 'not_modified' });
    expect(waits).toEqual([]);
  });

  it('retries a 5xx a bounded number of times, then answers github_unavailable', async () => {
    fake.failNext(503);
    expect((await make().getRepo()).canPush).toBe(true);
    fake.failNext(503, 503, 503);
    await expect(make().getRepo()).rejects.toMatchObject({ code: 'github_unavailable', status: 503 });
    fake.failNext(404);
    await expect(make().getRepo()).rejects.toMatchObject({ code: 'github_not_found' });
    fake.failNext(403);
    await expect(make().getRepo()).rejects.toMatchObject({ code: 'github_forbidden' });
    fake.failNext(418);
    await expect(make().getRepo()).rejects.toMatchObject({ code: 'github_bad_response' });
  });

  it('lists open pull requests and proposal branches, reads a commit date and deletes one branch', async () => {
    const c = make();
    fake.refs.set(INCIDENT, SHA);
    fake.refs.set(FIX, SHA2);
    fake.refs.set('main', 'e'.repeat(40));
    fake.refs.set('scenario/error-spike', 'f'.repeat(40));
    await c.createPull({ title: 'Exorcist: x', head: FIX, base: INCIDENT, body: 'b' });
    expect(await c.listOpenPullRefs()).toEqual([{ head: FIX, base: INCIDENT }]);
    expect((await c.listProposalBranches()).map((b) => b.name).sort()).toEqual([FIX, INCIDENT]);
    fake.commitDates.set(SHA, '2026-11-01T10:00:00Z');
    expect((await c.commitDate(SHA)).toISOString()).toBe('2026-11-01T10:00:00.000Z');
    await c.deleteBranch(FIX);
    expect(fake.refs.has(FIX)).toBe(false);
    // Deleting what is already gone is not an error; a name outside the two forms never leaves the client.
    await c.deleteBranch(FIX);
    fake.requests.length = 0;
    for (const bad of ['main', 'scenario/error-spike', 'incident/x']) await expect(c.deleteBranch(bad)).rejects.toMatchObject({ code: 'github_bad_response' });
    expect(fake.requests).toHaveLength(0);
    expect(fake.refs.has('main')).toBe(true);
  });

  it('calls only the endpoints it needs: no merge, review, comment or update of a pull request', async () => {
    const c = make();
    await c.getRepo();
    await c.ensureLabels(LABELS);
    fake.refs.set(INCIDENT, SHA);
    fake.refs.set(FIX, SHA2);
    await c.branchExists(FIX);
    await c.createPull({ title: 'Exorcist: x', head: FIX, base: INCIDENT, body: 'b' });
    await c.addLabels(1, ['exorcist']);
    await c.getPull(1, null);
    await c.listOpenPullRefs();
    await c.listProposalBranches();
    await c.deleteBranch(FIX);
    const allowed = [
      /^GET \/repos\/[^/]+\/[^/]+$/,
      /^(GET|POST) \/repos\/[^/]+\/[^/]+\/labels(\/[^/]+)?$/,
      /^GET \/repos\/[^/]+\/[^/]+\/git\/(ref|matching-refs)\/heads\//,
      /^POST \/repos\/[^/]+\/[^/]+\/pulls$/,
      /^POST \/repos\/[^/]+\/[^/]+\/issues\/\d+\/labels$/,
      /^GET \/repos\/[^/]+\/[^/]+\/pulls(\/\d+)?(\?.*)?$/,
      /^GET \/repos\/[^/]+\/[^/]+\/commits\/[0-9a-f]{40}$/,
      /^DELETE \/repos\/[^/]+\/[^/]+\/git\/refs\/heads\/(incident|exorcist)\/[a-z0-9]+$/,
    ];
    for (const r of fake.requests) expect(allowed.some((re) => re.test(`${r.method} ${r.path.split('?')[0]}${r.path.includes('?') && r.method === 'GET' ? '?x' : ''}`.replace('?x', r.path.includes('?') ? `?${r.path.split('?')[1]}` : ''))), `${r.method} ${r.path}`).toBe(true);
    expect(fake.requests.every((r) => r.authorized)).toBe(true);
    expect(fake.requests.some((r) => /merge|reviews|comments/.test(r.path) || r.method === 'PUT' || r.method === 'PATCH')).toBe(false);
  });
});

describe('GithubClient (the real host, with an injected fetch)', () => {
  const answer = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
    new Response(body === null ? null : JSON.stringify(body), { status, headers });

  it('sends to https://api.github.com only, with no redirect, a timeout and the headers GitHub asks for', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn: typeof fetch = async (url, init) => {
      seen.push({ url: String(url), init: init ?? {} });
      return answer({ permissions: { push: true } });
    };
    const c = new GithubClient({ token: DUMMY_GITHUB_TOKEN, repo: REPO, fetch: fetchFn });
    await c.getRepo();
    expect(GITHUB_API).toBe('https://api.github.com');
    expect(seen[0]?.url).toBe(`https://api.github.com/repos/${REPO}`);
    const init = seen[0]?.init as RequestInit & { headers: Record<string, string> };
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.headers).toMatchObject({ Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'haunted-ops', Authorization: `Bearer ${DUMMY_GITHUB_TOKEN}` });
  });

  it('turns a network error, a redirect and a body over the cap into fixed codes without the token', async () => {
    const down: typeof fetch = async () => {
      throw new TypeError(`fetch failed for ${DUMMY_GITHUB_TOKEN}`);
    };
    const err = await new GithubClient({ token: DUMMY_GITHUB_TOKEN, repo: REPO, fetch: down, sleep: async () => undefined }).getRepo().catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'github_unavailable', message: 'github_unavailable' });
    expect(JSON.stringify(err)).not.toContain(DUMMY_GITHUB_TOKEN);
    expect(String((err as Error).stack ?? '').includes(DUMMY_GITHUB_TOKEN)).toBe(false);
    const big: typeof fetch = async () => answer({ pad: 'x'.repeat(5000), permissions: { push: true } });
    await expect(new GithubClient({ token: DUMMY_GITHUB_TOKEN, repo: REPO, fetch: big, maxBodyBytes: 1000 }).getRepo()).rejects.toMatchObject({ code: 'github_bad_response' });
    const junk: typeof fetch = async () => new Response('not json', { status: 200 });
    await expect(new GithubClient({ token: DUMMY_GITHUB_TOKEN, repo: REPO, fetch: junk }).getRepo()).rejects.toMatchObject({ code: 'github_bad_response' });
    const wrongShape: typeof fetch = async () => answer({ permissions: { push: 'yes' } });
    await expect(new GithubClient({ token: DUMMY_GITHUB_TOKEN, repo: REPO, fetch: wrongShape }).getRepo()).rejects.toMatchObject({ code: 'github_bad_response' });
  });

  it('does not accept a pull request whose URL, head or merge data are wrong', async () => {
    const pull = (over: Record<string, unknown>) => ({
      number: 3,
      html_url: `https://github.com/${REPO}/pull/3`,
      state: 'closed',
      merged: true,
      merge_commit_sha: 'c'.repeat(40),
      merged_by: { login: 'octocat' },
      head: { ref: FIX, sha: SHA },
      base: { ref: INCIDENT },
      ...over,
    });
    const ask = (body: unknown) => new GithubClient({ token: DUMMY_GITHUB_TOKEN, repo: REPO, fetch: async () => answer(body) }).getPull(3, null);
    expect(await ask(pull({}))).toMatchObject({ kind: 'ok' });
    // GitHub may not say who merged: `merged_by: null` is a merge with no login, not a bad answer.
    expect(await ask(pull({ merged_by: null }))).toMatchObject({ kind: 'ok', pull: { merged: true, mergedBy: null, mergeCommitSha: 'c'.repeat(40) } });
    for (const bad of [
      pull({ html_url: 'https://evil.example/o/r/pull/3' }),
      pull({ html_url: `https://github.com/${REPO}/pull/4` }),
      pull({ merged_by: { login: '<b>x</b>' } }),
      pull({ merged_by: { login: null } }),
      pull({ merged_by: 'octocat' }),
      pull({ merge_commit_sha: 'xyz' }),
      pull({ head: { ref: FIX, sha: 'short' } }),
      pull({ state: 'merged' }),
      pull({ number: '3' }),
    ]) {
      await expect(ask(bad)).rejects.toMatchObject({ code: 'github_bad_response' });
    }
  });
});
