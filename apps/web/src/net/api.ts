import {
  validateHuntDetail,
  validateIngestStatus,
  validateServiceStates,
  type HuntDetail,
  type IngestStatus,
  type ServiceState,
} from '@haunted-ops/shared';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Default API base URL, from VITE_API_BASE_URL. */
export function apiBaseUrl(): string {
  const configured = import.meta.env.VITE_API_BASE_URL;
  const base = typeof configured === 'string' && configured !== '' ? configured : 'http://localhost:3000';
  return base.replace(/\/+$/, '');
}

export class InvalidResponseError extends Error {
  constructor() {
    super('invalid response from GET /api/services');
    this.name = 'InvalidResponseError';
  }
}

/** GET /api/ingest/status, validated with the shared validator. */
export async function fetchIngestStatus(baseUrl: string, fetchImpl: FetchLike = fetch): Promise<IngestStatus> {
  const res = await fetchImpl(`${baseUrl}/api/ingest/status`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`GET /api/ingest/status failed with ${res.status}`);
  const result = validateIngestStatus(await res.json());
  if (!result.ok) throw new InvalidResponseError();
  return result.value;
}

/** GET /api/services, validated with the shared validator. */
export async function fetchServices(baseUrl: string, fetchImpl: FetchLike = fetch): Promise<ServiceState[]> {
  const res = await fetchImpl(`${baseUrl}/api/services`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`GET /api/services failed with ${res.status}`);
  const result = validateServiceStates(await res.json());
  if (!result.ok) throw new InvalidResponseError();
  return result.value;
}

/** GET /api/hunts/:id, validated with the shared validator. */
export async function fetchHuntDetail(baseUrl: string, huntId: string, fetchImpl: FetchLike = fetch): Promise<HuntDetail> {
  const res = await fetchImpl(`${baseUrl}/api/hunts/${encodeURIComponent(huntId)}`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`GET /api/hunts/:id failed with ${res.status}`);
  const result = validateHuntDetail(await res.json());
  if (!result.ok) throw new InvalidResponseError();
  return result.value;
}
