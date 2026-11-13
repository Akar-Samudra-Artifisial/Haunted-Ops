import {
  SERVICE_NAMES,
  type IngestStatus,
  type ServiceMetrics,
  type ServiceState,
  type SsePayloads,
} from '@haunted-ops/shared';

export interface LiveState {
  services: ServiceState[];
  ingest: IngestStatus | null;
}

/** The domain events the table reacts to. */
export type LiveEventName = 'service.updated' | 'ingest.polled' | 'ingest.status' | 'incident.opened' | 'incident.closed';

export const LIVE_EVENT_NAMES: readonly LiveEventName[] = [
  'service.updated',
  'ingest.polled',
  'ingest.status',
  'incident.opened',
  'incident.closed',
];

/** Room order: row (y), then column (x), then the fixed service order. */
export function sortByRoom(services: readonly ServiceState[]): ServiceState[] {
  const rank = (s: ServiceState): number => SERVICE_NAMES.indexOf(s.name);
  return [...services].sort((a, b) => a.room.y - b.room.y || a.room.x - b.room.x || rank(a) - rank(b));
}

const time = (iso: string): number => Date.parse(iso);

/** The metrics with the later poll time; the first one on a tie. */
export function newerMetrics(a: ServiceMetrics | null, b: ServiceMetrics | null): ServiceMetrics | null {
  if (a === null) return b;
  if (b === null) return a;
  return time(b.at) > time(a.at) ? b : a;
}

function replaceService(services: readonly ServiceState[], next: ServiceState): ServiceState[] {
  return sortByRoom(services.map((s) => (s.name === next.name ? next : s)));
}

/**
 * Applies one validated event to the live state. Pure. Applying the same event twice gives the same
 * state, and an event older than what is stored never overwrites it.
 */
export function applyLiveEvent<K extends LiveEventName>(state: LiveState, name: K, payload: SsePayloads[K]): LiveState {
  switch (name) {
    case 'service.updated': {
      const { service } = payload as SsePayloads['service.updated'];
      const current = state.services.find((s) => s.name === service.name);
      if (!current) return { ...state, services: sortByRoom([...state.services, service]) };
      if (time(current.updatedAt) > time(service.updatedAt)) return state;
      const merged: ServiceState = { ...service, metrics: newerMetrics(service.metrics, current.metrics) };
      return { ...state, services: replaceService(state.services, merged) };
    }
    case 'ingest.polled': {
      const { at, samples } = payload as SsePayloads['ingest.polled'];
      const services = state.services.map((s) => {
        const sample = samples.find((x) => x.service === s.name);
        if (!sample) return s;
        if (s.metrics !== null && time(s.metrics.at) > time(at)) return s;
        return { ...s, metrics: { errorRate: sample.errorRate, p95Ms: sample.p95Ms, up: sample.up, at } };
      });
      return { ...state, services };
    }
    case 'incident.opened': {
      const { incidentId, service, openedAt, level } = payload as SsePayloads['incident.opened'];
      const current = state.services.find((s) => s.name === service);
      if (!current || current.openIncident?.id === incidentId) return state;
      const next: ServiceState = {
        ...current,
        // The Incident opens at `level`, which is its peak so far; later peaks arrive with service.updated.
        openIncident: { id: incidentId, openedAt, peakLevel: level },
      };
      return { ...state, services: replaceService(state.services, next) };
    }
    case 'incident.closed': {
      const { incidentId, service } = payload as SsePayloads['incident.closed'];
      const current = state.services.find((s) => s.name === service);
      if (!current || current.openIncident?.id !== incidentId) return state;
      return { ...state, services: replaceService(state.services, { ...current, openIncident: null }) };
    }
    case 'ingest.status': {
      const status = payload as SsePayloads['ingest.status'];
      if (state.ingest !== null && time(state.ingest.at) > time(status.at)) return state;
      return { ...state, ingest: status };
    }
  }
  return state;
}
