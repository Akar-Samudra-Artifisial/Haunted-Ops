import { FULL_SHA_PATTERN, GITHUB_LOGIN_PATTERN, PROPOSAL_BRANCH_PATTERN } from '@haunted-ops/shared';

/** Fixed codes. The message of GitHub (it can echo a header or a body) is never kept. */
export type GithubErrorCode =
  | 'github_unauthorized'
  | 'github_forbidden'
  | 'github_rate_limited'
  | 'github_not_found'
  | 'github_unprocessable'
  | 'github_unavailable'
  | 'github_bad_response';

export class GithubError extends Error {
  constructor(
    readonly code: GithubErrorCode,
    readonly status: number | null = null,
  ) {
    super(code);
    this.name = 'GithubError';
  }
}

/** The only host the client talks to. */
export const GITHUB_API = 'https://api.github.com';
export const GITHUB_API_VERSION = '2022-11-28';

export interface GithubClientOptions {
  token: string;
  /** `owner/name`. */
  repo: string;
  fetch?: typeof fetch;
  /** Tests point this at the fake GitHub server. Production code never passes it. */
  baseUrl?: string;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  /** The most bytes of a body that are read. */
  maxBodyBytes?: number;
  /** Retries after a rate limit or a 5xx. */
  maxRetries?: number;
  /** The longest wait before a retry. */
  maxWaitMs?: number;
}

interface Answer {
  status: number;
  etag: string | null;
  data: unknown;
  headers: Headers;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 500): string | null => (typeof v === 'string' && v.length <= max ? v : null);

export interface PullInfo {
  number: number;
  htmlUrl: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeCommitSha: string | null;
  mergedBy: string | null;
  headSha: string;
  headRef: string;
  baseRef: string;
}

export interface RepoInfo {
  canPush: boolean;
  /** Days left before the token expires, when GitHub says. */
  tokenDaysLeft: number | null;
}

export type PullAnswer = { kind: 'not_modified' } | { kind: 'ok'; etag: string | null; pull: PullInfo };

const sleepDefault = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * `fetch` against `https://api.github.com` only: no redirect, a timeout, a cap on the body that is read, the
 * headers GitHub asks for, a bounded wait on rate limits, and answers that are validated before use. The token is
 * only in the `Authorization` header of the request; errors carry a fixed code and a status, nothing else.
 */
export class GithubClient {
  private readonly fetchFn: typeof fetch;
  private readonly base: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly maxBody: number;
  private readonly maxRetries: number;
  private readonly maxWait: number;
  /** The most recent time a rate limit was seen (the watcher slows down while it lasts). */
  rateLimitedUntil = 0;

  constructor(private readonly o: GithubClientOptions) {
    this.fetchFn = o.fetch ?? fetch;
    this.base = o.baseUrl ?? GITHUB_API;
    this.sleep = o.sleep ?? sleepDefault;
    this.timeoutMs = o.timeoutMs ?? 15_000;
    this.maxBody = o.maxBodyBytes ?? 1024 * 1024;
    this.maxRetries = o.maxRetries ?? 3;
    this.maxWait = o.maxWaitMs ?? 60_000;
  }

  private repoPath(rest: string): string {
    return `/repos/${this.o.repo}${rest}`;
  }

  private async readBody(res: Response): Promise<unknown> {
    if (res.body === null) return null;
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > this.maxBody) {
        await reader.cancel().catch(() => undefined);
        throw new GithubError('github_bad_response', res.status);
      }
      chunks.push(value);
    }
    if (total === 0) return null;
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch {
      throw new GithubError('github_bad_response', res.status);
    }
  }

  private waitMs(res: Response, attempt: number): number {
    const retryAfter = Number(res.headers.get('retry-after'));
    if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, this.maxWait);
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    if (Number.isFinite(reset) && reset > 0) return Math.min(Math.max(reset * 1000 - Date.now(), 1000), this.maxWait);
    return Math.min(1000 * 2 ** attempt, this.maxWait);
  }

  /** One request with the bounded retries. 304 is an answer, not an error. */
  private async request(method: string, path: string, o: { body?: unknown; etag?: string | null; accept404?: boolean } = {}): Promise<Answer> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.o.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
      'User-Agent': 'haunted-ops',
    };
    if (o.body !== undefined) headers['Content-Type'] = 'application/json';
    if (o.etag) headers['If-None-Match'] = o.etag;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchFn(`${this.base}${path}`, {
          method,
          headers,
          body: o.body === undefined ? undefined : JSON.stringify(o.body),
          redirect: 'error',
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch {
        if (attempt < 1) {
          await this.sleep(500);
          continue;
        }
        throw new GithubError('github_unavailable');
      }
      const limited = (res.status === 403 || res.status === 429) && (res.headers.has('retry-after') || res.headers.get('x-ratelimit-remaining') === '0' || res.status === 429);
      if (limited) {
        const wait = this.waitMs(res, attempt);
        this.rateLimitedUntil = Date.now() + wait;
        await res.body?.cancel().catch(() => undefined);
        if (attempt >= this.maxRetries) throw new GithubError('github_rate_limited', res.status);
        await this.sleep(wait);
        continue;
      }
      if (res.status >= 500) {
        await res.body?.cancel().catch(() => undefined);
        if (attempt >= 2) throw new GithubError('github_unavailable', res.status);
        await this.sleep(Math.min(500 * 2 ** attempt, this.maxWait));
        continue;
      }
      if (res.status === 304) {
        await res.body?.cancel().catch(() => undefined);
        return { status: 304, etag: res.headers.get('etag'), data: null, headers: res.headers };
      }
      if (res.status >= 200 && res.status < 300) {
        const data = res.status === 204 ? null : await this.readBody(res);
        return { status: res.status, etag: res.headers.get('etag'), data, headers: res.headers };
      }
      await res.body?.cancel().catch(() => undefined);
      if (res.status === 404 && o.accept404 === true) return { status: 404, etag: null, data: null, headers: res.headers };
      throw new GithubError(res.status === 401 ? 'github_unauthorized' : res.status === 403 ? 'github_forbidden' : res.status === 404 ? 'github_not_found' : res.status === 422 ? 'github_unprocessable' : 'github_bad_response', res.status);
    }
  }

  async getRepo(): Promise<RepoInfo> {
    const a = await this.request('GET', this.repoPath(''));
    if (!isRecord(a.data) || !isRecord(a.data.permissions) || typeof a.data.permissions.push !== 'boolean') throw new GithubError('github_bad_response', a.status);
    const expiry = a.headers.get('github-authentication-token-expiration');
    const ms = expiry === null ? Number.NaN : Date.parse(expiry);
    return { canPush: a.data.permissions.push, tokenDaysLeft: Number.isFinite(ms) ? Math.floor((ms - Date.now()) / 86_400_000) : null };
  }

  /** Makes sure each label exists (created when missing, 422 means someone made it first). */
  async ensureLabels(labels: ReadonlyArray<{ name: string; color: string; description: string }>): Promise<void> {
    for (const l of labels) {
      const got = await this.request('GET', this.repoPath(`/labels/${encodeURIComponent(l.name)}`), { accept404: true });
      if (got.status === 404) {
        try {
          await this.request('POST', this.repoPath('/labels'), { body: l });
        } catch (err) {
          if (!(err instanceof GithubError && err.code === 'github_unprocessable')) throw err;
        }
      }
    }
  }

  /** True when the branch exists on the remote. Only the two proposal branch names are asked for. */
  async branchExists(branch: string): Promise<boolean> {
    if (!PROPOSAL_BRANCH_PATTERN.test(branch)) throw new GithubError('github_bad_response');
    const a = await this.request('GET', this.repoPath(`/git/ref/heads/${branch}`), { accept404: true });
    return a.status !== 404;
  }

  /** The commit a proposal branch points at, or null when it does not exist. */
  async branchHead(branch: string): Promise<string | null> {
    if (!PROPOSAL_BRANCH_PATTERN.test(branch)) throw new GithubError('github_bad_response');
    const a = await this.request('GET', this.repoPath(`/git/ref/heads/${branch}`), { accept404: true });
    if (a.status === 404) return null;
    const sha = isRecord(a.data) && isRecord(a.data.object) ? str(a.data.object.sha, 40) : null;
    if (sha === null || !FULL_SHA_PATTERN.test(sha)) throw new GithubError('github_bad_response', a.status);
    return sha;
  }

  async createPull(p: { title: string; head: string; base: string; body: string }): Promise<{ number: number; htmlUrl: string }> {
    if (!PROPOSAL_BRANCH_PATTERN.test(p.head) || !PROPOSAL_BRANCH_PATTERN.test(p.base)) throw new GithubError('github_bad_response');
    const a = await this.request('POST', this.repoPath('/pulls'), { body: { title: p.title, head: p.head, base: p.base, body: p.body, draft: false, maintainer_can_modify: false } });
    const pull = this.parsePull(a.data);
    return { number: pull.number, htmlUrl: pull.htmlUrl };
  }

  async addLabels(number: number, labels: readonly string[]): Promise<void> {
    await this.request('POST', this.repoPath(`/issues/${number}/labels`), { body: { labels } });
  }

  private parsePull(data: unknown): PullInfo {
    if (!isRecord(data) || !isRecord(data.head) || !isRecord(data.base)) throw new GithubError('github_bad_response');
    const number = data.number;
    const htmlUrl = str(data.html_url, 300);
    const headSha = str(data.head.sha, 40);
    const headRef = str(data.head.ref, 300);
    const baseRef = str(data.base.ref, 300);
    const state = data.state;
    const prefix = `https://github.com/${this.o.repo}/pull/`;
    if (typeof number !== 'number' || !Number.isInteger(number) || number < 1 || htmlUrl === null || htmlUrl !== `${prefix}${number}`) throw new GithubError('github_bad_response');
    if (headSha === null || !FULL_SHA_PATTERN.test(headSha) || headRef === null || baseRef === null || (state !== 'open' && state !== 'closed')) throw new GithubError('github_bad_response');
    const merged = data.merged === true;
    const mergeSha = str(data.merge_commit_sha, 40);
    // `merged_by` is null when GitHub does not say who merged (a deleted account, some app merges): that is a merge
    // with no login, not a bad answer. A `merged_by` object must carry a valid login.
    if (data.merged_by !== null && data.merged_by !== undefined && !isRecord(data.merged_by)) throw new GithubError('github_bad_response');
    const mergedBy = isRecord(data.merged_by) ? str(data.merged_by.login, 60) : null;
    if (isRecord(data.merged_by) && (mergedBy === null || !GITHUB_LOGIN_PATTERN.test(mergedBy))) throw new GithubError('github_bad_response');
    if (merged && (mergeSha === null || !FULL_SHA_PATTERN.test(mergeSha))) throw new GithubError('github_bad_response');
    return { number, htmlUrl, state, merged, mergeCommitSha: merged ? mergeSha : null, mergedBy: merged ? mergedBy : null, headSha, headRef, baseRef };
  }

  /** The pull request, or `not_modified` when the ETag still matches (that costs no rate limit). */
  async getPull(number: number, etag: string | null): Promise<PullAnswer> {
    if (!Number.isInteger(number) || number < 1) throw new GithubError('github_bad_response');
    const a = await this.request('GET', this.repoPath(`/pulls/${number}`), { etag });
    if (a.status === 304) return { kind: 'not_modified' };
    return { kind: 'ok', etag: a.etag, pull: this.parsePull(a.data) };
  }

  /** Head and base of every open pull request (at most 10 pages of 100). */
  async listOpenPullRefs(): Promise<Array<{ head: string; base: string }>> {
    const out: Array<{ head: string; base: string }> = [];
    for (let page = 1; page <= 10; page++) {
      const a = await this.request('GET', this.repoPath(`/pulls?state=open&per_page=100&page=${page}`));
      if (!Array.isArray(a.data)) throw new GithubError('github_bad_response', a.status);
      for (const p of a.data) {
        if (!isRecord(p) || !isRecord(p.head) || !isRecord(p.base)) throw new GithubError('github_bad_response', a.status);
        const head = str(p.head.ref, 300);
        const base = str(p.base.ref, 300);
        if (head === null || base === null) throw new GithubError('github_bad_response', a.status);
        out.push({ head, base });
      }
      if (a.data.length < 100) break;
    }
    return out;
  }

  /** The proposal branches (`incident/` and `exorcist/` only) with the commit each points at. */
  async listProposalBranches(): Promise<Array<{ name: string; sha: string }>> {
    const out: Array<{ name: string; sha: string }> = [];
    for (const prefix of ['incident', 'exorcist']) {
      for (let page = 1; page <= 10; page++) {
        const a = await this.request('GET', this.repoPath(`/git/matching-refs/heads/${prefix}/?per_page=100&page=${page}`));
        if (!Array.isArray(a.data)) throw new GithubError('github_bad_response', a.status);
        for (const r of a.data) {
          if (!isRecord(r) || !isRecord(r.object)) throw new GithubError('github_bad_response', a.status);
          const ref = str(r.ref, 300);
          const sha = str(r.object.sha, 40);
          if (ref === null || sha === null || !FULL_SHA_PATTERN.test(sha) || !ref.startsWith('refs/heads/')) throw new GithubError('github_bad_response', a.status);
          out.push({ name: ref.slice('refs/heads/'.length), sha });
        }
        if (a.data.length < 100) break;
      }
    }
    return out;
  }

  /** The commit date of a SHA (ISO), for a branch with no Proposal row. */
  async commitDate(sha: string): Promise<Date> {
    if (!FULL_SHA_PATTERN.test(sha)) throw new GithubError('github_bad_response');
    const a = await this.request('GET', this.repoPath(`/commits/${sha}`));
    const date = isRecord(a.data) && isRecord(a.data.commit) && isRecord(a.data.commit.committer) ? str(a.data.commit.committer.date, 40) : null;
    const ms = date === null ? Number.NaN : Date.parse(date);
    if (!Number.isFinite(ms)) throw new GithubError('github_bad_response', a.status);
    return new Date(ms);
  }

  /** Deletes one proposal branch. A branch that is already gone is not an error. */
  async deleteBranch(branch: string): Promise<void> {
    if (!PROPOSAL_BRANCH_PATTERN.test(branch)) throw new GithubError('github_bad_response');
    try {
      await this.request('DELETE', this.repoPath(`/git/refs/heads/${branch}`), { accept404: true });
    } catch (err) {
      // GitHub answers 422 for a reference that does not exist.
      if (!(err instanceof GithubError && err.code === 'github_unprocessable')) throw err;
    }
  }
}
