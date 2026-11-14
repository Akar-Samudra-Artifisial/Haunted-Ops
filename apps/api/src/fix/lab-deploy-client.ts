import { FULL_SHA_PATTERN, SERVICE_NAMES, incidentBranch, type ServiceName } from '@haunted-ops/shared';
import type { LabAnswer, LabDeploy, LabLookup } from '../hunts/lab-client.js';

export const CHAOS_TIMEOUT_MS = 10_000;
export const CHAOS_MAX_BYTES = 4096;

export type DeployFixAnswer =
  | { kind: 'ok'; deployId: string }
  /** The lab refused (a 4xx): the request is not going to be accepted by trying again. */
  | { kind: 'rejected'; status: number }
  /** The lab did not answer, or answered 5xx or something that is not the contract. */
  | { kind: 'unavailable' };

/** What the fix runner needs from the lab: the deploy records, and the chaos route that deploys a merged fix. */
export interface FixLab extends Pick<LabLookup, 'deploys'> {
  deployFix(body: { service: ServiceName; huntId: string; sha: string }): Promise<DeployFixAnswer>;
}

export type PostFetch = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string; redirect: 'error'; signal: AbortSignal }) => Promise<Response>;

/**
 * `POST /chaos/deploy-fix` of the lab (the contract of `fix-proposal-flow`; the lab side is the spec `fix-deploy`).
 * The body is exactly `{ service, ref, sha }`, with `ref` built from the hunt id, and the bearer `CHAOS_TOKEN` goes
 * only to the chaos URL. The answer is read for its deploy id and nothing else.
 */
export class HttpChaosClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: PostFetch = fetch as unknown as PostFetch,
  ) {}

  async deployFix(body: { service: ServiceName; huntId: string; sha: string }): Promise<DeployFixAnswer> {
    if (!(SERVICE_NAMES as readonly string[]).includes(body.service) || !FULL_SHA_PATTERN.test(body.sha)) return { kind: 'rejected', status: 400 };
    let ref: string;
    try {
      ref = incidentBranch(body.huntId);
    } catch {
      return { kind: 'rejected', status: 400 };
    }
    let res: Response;
    try {
      res = await this.fetchImpl(new URL('/chaos/deploy-fix', this.baseUrl).toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${this.token}` },
        body: JSON.stringify({ service: body.service, ref, sha: body.sha }),
        redirect: 'error',
        signal: AbortSignal.timeout(CHAOS_TIMEOUT_MS),
      });
    } catch {
      return { kind: 'unavailable' };
    }
    try {
      if (res.status >= 500) return { kind: 'unavailable' };
      if (res.status >= 400) return { kind: 'rejected', status: res.status };
      const text = await readCapped(res, CHAOS_MAX_BYTES);
      const parsed: unknown = text === null ? null : JSON.parse(text);
      const id = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>).deployId : undefined;
      return typeof id === 'string' && /^d-[0-9]{1,9}$/.test(id) ? { kind: 'ok', deployId: id } : { kind: 'unavailable' };
    } catch {
      return { kind: 'unavailable' };
    } finally {
      await res.body?.cancel().catch(() => undefined);
    }
  }
}

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

/** The two halves together: the read-only deploy list and the chaos deploy. */
export class HttpFixLab implements FixLab {
  constructor(
    private readonly reader: Pick<LabLookup, 'deploys'>,
    private readonly chaos: Pick<HttpChaosClient, 'deployFix'>,
  ) {}
  deploys(since: string): Promise<LabAnswer<LabDeploy[]>> {
    return this.reader.deploys(since);
  }
  deployFix(body: { service: ServiceName; huntId: string; sha: string }): Promise<DeployFixAnswer> {
    return this.chaos.deployFix(body);
  }
}
