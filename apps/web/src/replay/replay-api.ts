import { REPLAY_ID_PATTERN, validateReplayFile, validateReplayList, type ReplayFile, type ReplayListItem } from '@haunted-ops/shared';
import type { FetchLike } from '../net/api.js';
/** `missing` is a 404 (or an id that cannot exist); `error` is anything else: the API is down, slow or sends something invalid. */
export type ReplayLoad<T> = { status: 'ok'; value: T } | { status: 'missing' } | { status: 'error' };
async function get(url: string, fetchImpl: FetchLike): Promise<{ res: Response } | null> {
  try {
    return { res: await fetchImpl(url, { headers: { accept: 'application/json' } }) };
  } catch {
    return null;
  }
}
/** `GET /api/replays`. */
export async function fetchReplayList(baseUrl: string, fetchImpl: FetchLike = fetch): Promise<ReplayLoad<ReplayListItem[]>> {
  const got = await get(`${baseUrl}/api/replays`, fetchImpl);
  if (got === null || !got.res.ok) return { status: 'error' };
  const checked = validateReplayList(await got.res.json().catch(() => null));
  return checked.ok ? { status: 'ok', value: checked.value } : { status: 'error' };
}
/** `GET /api/replays/:id`, validated again here: a file that is not valid is not played. */
export async function fetchReplay(baseUrl: string, id: string, fetchImpl: FetchLike = fetch): Promise<ReplayLoad<ReplayFile>> {
  if (!REPLAY_ID_PATTERN.test(id)) return { status: 'missing' };
  const got = await get(`${baseUrl}/api/replays/${id}`, fetchImpl);
  if (got === null) return { status: 'error' };
  if (got.res.status === 404) return { status: 'missing' };
  if (!got.res.ok) return { status: 'error' };
  const checked = validateReplayFile(await got.res.json().catch(() => null));
  return checked.ok && checked.value.id === id && checked.value.review !== null ? { status: 'ok', value: checked.value } : { status: 'error' };
}
