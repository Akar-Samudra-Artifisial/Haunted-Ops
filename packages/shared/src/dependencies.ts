import { SERVICE_NAMES, type ServiceName } from './types.js';

/**
 * The lab is one call chain: `gate` calls `orders`, `orders` calls `payments`, `payments` calls
 * `ledger`. A fault in a service breaks every caller upstream of it, so one root cause opens several
 * Incidents within seconds. Each entry lists the services a service calls directly.
 */
export const SERVICE_DEPENDENCIES: Readonly<Record<ServiceName, readonly ServiceName[]>> = Object.freeze({
  gate: Object.freeze(['orders'] as const),
  orders: Object.freeze(['payments'] as const),
  payments: Object.freeze(['ledger'] as const),
  ledger: Object.freeze([] as const),
});

/** Every service `service` depends on, directly or not, in the fixed service order. Never includes `service`. */
export function downstreamOf(service: ServiceName): ServiceName[] {
  const seen = new Set<ServiceName>();
  const visit = (name: ServiceName): void => {
    for (const next of SERVICE_DEPENDENCIES[name]) {
      if (!seen.has(next)) {
        seen.add(next);
        visit(next);
      }
    }
  };
  visit(service);
  return SERVICE_NAMES.filter((n) => seen.has(n));
}

/** True when `culprit` is `hunted` itself or a service `hunted` depends on. */
export function isCulpritCandidate(hunted: ServiceName, culprit: ServiceName): boolean {
  return culprit === hunted || downstreamOf(hunted).includes(culprit);
}

/**
 * The most downstream service of a set: the one with no member of the set downstream of it. For the
 * chain this is unique. Null for an empty set.
 */
export function mostDownstream(services: Iterable<ServiceName>): ServiceName | null {
  const set = new Set(services);
  for (const name of SERVICE_NAMES) {
    if (set.has(name) && !downstreamOf(name).some((d) => set.has(d))) return name;
  }
  return null;
}
