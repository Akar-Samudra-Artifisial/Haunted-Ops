import type { ServiceName } from '@haunted-ops/shared';
import { getJson, isRecord, type FetchLike } from './http.js';
import type { ErrorCode } from './untrusted.js';

/**
 * Read-only client of the lab observability API (`/lab/*`, Bearer `LAB_READ_TOKEN`). Formats:
 * `../haunted-lab/.kiro/specs/haunted-lab/design.md:109-120` (routes) and `:161-196` (items).
 * It returns raw items; cleaning and capping happen in the tools.
 */

export type LabResult<T> = { ok: true; value: T } | { ok: false; code: ErrorCode };

export interface LabList {
  items: unknown[];
  truncated: boolean;
}

export interface LabDiff {
  sha: unknown;
  subject: unknown;
  author: unknown;
  date: unknown;
  diff: unknown;
  truncated: unknown;
  bytes: unknown;
}

export interface LabApi {
  errors(service: ServiceName, since: string, limit: number): Promise<LabResult<LabList>>;
  logs(service: ServiceName, since: string, limit: number): Promise<LabResult<LabList>>;
  deploys(since: string): Promise<LabResult<LabList>>;
  diff(sha: string): Promise<LabResult<LabDiff>>;
}

export class LabClient implements LabApi {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private async get(path: string, params: Record<string, string>): Promise<LabResult<Record<string, unknown>>> {
    const url = new URL(path, this.baseUrl);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const r = await getJson(this.fetchImpl, url.toString(), { authorization: `Bearer ${this.token}` });
    if (r.kind === 'unavailable') return { ok: false, code: 'lab_unavailable' };
    if (r.kind === 'bad_body') return { ok: false, code: 'lab_error' };
    if (r.kind === 'status') {
      const code = isRecord(r.body) && isRecord(r.body.error) ? r.body.error.code : undefined;
      return { ok: false, code: r.status === 404 && (code === 'unknown_commit' || code === 'not_found') ? 'not_found' : 'lab_error' };
    }
    if (!isRecord(r.body)) return { ok: false, code: 'lab_error' };
    return { ok: true, value: r.body };
  }

  private async list(path: string, params: Record<string, string>): Promise<LabResult<LabList>> {
    const r = await this.get(path, params);
    if (!r.ok) return r;
    if (!Array.isArray(r.value.items)) return { ok: false, code: 'lab_error' };
    return { ok: true, value: { items: r.value.items, truncated: r.value.truncated === true } };
  }

  errors(service: ServiceName, since: string, limit: number): Promise<LabResult<LabList>> {
    return this.list('/lab/errors', { service, since, limit: String(limit) });
  }

  logs(service: ServiceName, since: string, limit: number): Promise<LabResult<LabList>> {
    return this.list('/lab/logs', { service, since, limit: String(limit) });
  }

  deploys(since: string): Promise<LabResult<LabList>> {
    return this.list('/lab/deploys', { since });
  }

  async diff(sha: string): Promise<LabResult<LabDiff>> {
    // `sha` is checked against ^[0-9a-f]{7,40}$ before this call, so it is a safe path segment.
    const r = await this.get(`/lab/commits/${sha}/diff`, {});
    if (!r.ok) return r;
    const b = r.value;
    return { ok: true, value: { sha: b.sha, subject: b.subject, author: b.author, date: b.date, diff: b.diff, truncated: b.truncated, bytes: b.bytes } };
  }
}
