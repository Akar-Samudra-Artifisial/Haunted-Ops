/**
 * The API's own read-only view of the lab, used only to check a diagnosis: the deploy records and
 * whether a commit diff exists. The diff body is never read. Time out after 5 s, 1 MiB at most.
 * Formats: `../haunted-lab/.kiro/specs/haunted-lab/design.md:109-120`.
 */

export const LAB_TIMEOUT_MS = 5_000;
export const LAB_MAX_BYTES = 1024 * 1024;

export interface LabDeploy {
  id: string;
  service: string;
  sha: string;
  /** ISO time of the deploy. */
  time: string;
}

export type LabAnswer<T> = { kind: 'ok'; value: T } | { kind: 'missing' } | { kind: 'unavailable' };

/** What the validator needs from the lab. A fake implements it in tests. */
export interface LabLookup {
  /** Deploy records since the time (ISO). */
  deploys(since: string): Promise<LabAnswer<LabDeploy[]>>;
  /** `ok` when the lab serves the diff of the commit, `missing` on a 404, `unavailable` otherwise. */
  commitReachable(sha: string): Promise<LabAnswer<true>>;
}

export type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

async function readCapped(res: Response, max: number): Promise<string | null> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export class HttpLabClient implements LabLookup {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private async request(path: string, params: Record<string, string>): Promise<Response | null> {
    const url = new URL(path, this.baseUrl);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    try {
      return await this.fetchImpl(url.toString(), {
        headers: { accept: 'application/json', authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(LAB_TIMEOUT_MS),
      });
    } catch {
      return null;
    }
  }

  async deploys(since: string): Promise<LabAnswer<LabDeploy[]>> {
    const res = await this.request('/lab/deploys', { since });
    if (res === null || !res.ok) {
      await res?.body?.cancel().catch(() => undefined);
      return { kind: 'unavailable' };
    }
    let body: unknown;
    try {
      const text = await readCapped(res, LAB_MAX_BYTES);
      if (text === null) return { kind: 'unavailable' };
      body = JSON.parse(text);
    } catch {
      return { kind: 'unavailable' };
    }
    if (!isRecord(body) || !Array.isArray(body.items)) return { kind: 'unavailable' };
    const out: LabDeploy[] = [];
    for (const item of body.items) {
      if (!isRecord(item)) continue;
      const { id, service, sha, time } = item;
      if (typeof id === 'string' && typeof service === 'string' && typeof sha === 'string' && typeof time === 'string') {
        out.push({ id, service, sha, time });
      }
    }
    return { kind: 'ok', value: out };
  }

  async commitReachable(sha: string): Promise<LabAnswer<true>> {
    // The caller passes a checked 40-hex SHA, so it is a safe path segment.
    if (!/^[0-9a-f]{40}$/.test(sha)) return { kind: 'missing' };
    const res = await this.request(`/lab/commits/${sha}/diff`, {});
    if (res === null) return { kind: 'unavailable' };
    // Only the status matters; the body is dropped without being read.
    await res.body?.cancel().catch(() => undefined);
    if (res.status === 404) return { kind: 'missing' };
    return res.ok ? { kind: 'ok', value: true } : { kind: 'unavailable' };
  }
}
