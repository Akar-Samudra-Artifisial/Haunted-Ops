/** Small GET helper shared by the lab and Prometheus clients: timeout, size cap, JSON. */

export const REQUEST_TIMEOUT_MS = 5_000;
export const MAX_RESPONSE_BYTES = 1024 * 1024;

export type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;

export type GetResult =
  | { kind: 'ok'; status: number; body: unknown }
  | { kind: 'status'; status: number; body: unknown }
  | { kind: 'unavailable' }
  | { kind: 'bad_body' };

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

/** GETs a URL and parses JSON. Network errors and timeouts are `unavailable`; never throws. */
export async function getJson(fetchImpl: FetchLike, url: string, headers: Record<string, string>): Promise<GetResult> {
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch {
    return { kind: 'unavailable' };
  }
  let text: string | null;
  try {
    text = await readCapped(res, MAX_RESPONSE_BYTES);
  } catch {
    return { kind: 'unavailable' };
  }
  if (text === null) return { kind: 'bad_body' };
  let body: unknown = null;
  try {
    body = text === '' ? null : JSON.parse(text);
  } catch {
    if (res.ok) return { kind: 'bad_body' };
  }
  return res.ok ? { kind: 'ok', status: res.status, body } : { kind: 'status', status: res.status, body };
}

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
