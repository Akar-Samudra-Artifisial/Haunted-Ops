import { SERVICE_NAMES, type ServiceName } from '@haunted-ops/shared';

const NUMBER_TEXT = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isServiceName(value: unknown): value is ServiceName {
  return typeof value === 'string' && (SERVICE_NAMES as readonly string[]).includes(value);
}

/** A finite number from a Prometheus sample value (a decimal string), or null for anything else. */
export function parseSampleValue(value: unknown): number | null {
  if (typeof value !== 'string' || !NUMBER_TEXT.test(value)) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** True when the body has the shape of a successful instant vector answer. */
export function isVectorSuccess(body: unknown): boolean {
  if (!isRecord(body) || body.status !== 'success') return false;
  const data = body.data;
  return isRecord(data) && data.resultType === 'vector' && Array.isArray(data.result);
}

/**
 * Total. Never throws. Reads only the `service` label and the sample value of each entry.
 * A service that is unknown, listed twice, or has a missing or non-finite value is left out,
 * so the caller sees it as `null`.
 */
export function parseVector(body: unknown): Map<ServiceName, number> {
  const out = new Map<ServiceName, number>();
  try {
    if (!isVectorSuccess(body)) return out;
    const result = ((body as Record<string, unknown>).data as Record<string, unknown>).result as unknown[];
    const seen = new Set<ServiceName>();
    const duplicated = new Set<ServiceName>();
    for (const entry of result) {
      if (!isRecord(entry) || !isRecord(entry.metric)) continue;
      const service = entry.metric.service;
      if (!isServiceName(service)) continue;
      if (seen.has(service)) {
        duplicated.add(service);
        continue;
      }
      seen.add(service);
      const pair = entry.value;
      const value = Array.isArray(pair) && pair.length === 2 ? parseSampleValue(pair[1]) : null;
      if (value !== null) out.set(service, value);
    }
    for (const service of duplicated) out.delete(service);
  } catch {
    return new Map();
  }
  return out;
}
