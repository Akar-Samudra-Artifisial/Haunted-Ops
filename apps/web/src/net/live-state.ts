import {
  HUNT_EVENT_NAMES,
  HUNT_LIMITS,
  SERVICE_NAMES,
  type HuntEventName,
  type HuntEventPayloads,
  type HuntSummary,
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
export type LiveEventName =
  | 'service.updated'
  | 'ingest.polled'
  | 'ingest.status'
  | 'incident.opened'
  | 'incident.closed'
  | HuntEventName;

export const LIVE_EVENT_NAMES: readonly LiveEventName[] = [
  'service.updated',
  'ingest.polled',
  'ingest.status',
  'incident.opened',
  'incident.closed',
  ...HUNT_EVENT_NAMES,
];

const isHuntEvent = (name: string): name is HuntEventName => (HUNT_EVENT_NAMES as readonly string[]).includes(name);

/**
 * Applies one `hunt.*` event to the Service's latest Hunt. A Hunt other than the current one is
 * taken only on `hunt.queued` and only when it is not older than the current one; every other event
 * of another Hunt is ignored. A step, evidence or end that was already applied changes nothing.
 */
export function applyHuntEvent<K extends HuntEventName>(current: HuntSummary | null, name: K, payload: HuntEventPayloads[K]): HuntSummary | null {
  if (name === 'hunt.queued') {
    const p = payload as HuntEventPayloads['hunt.queued'];
    if (current !== null && (current.id === p.huntId || time(current.queuedAt) > time(p.queuedAt))) return current;
    return {
      id: p.huntId,
      incidentId: p.incidentId,
      service: p.service,
      trigger: p.trigger,
      status: 'queued',
      reason: null,
      steps: [],
      stepCount: 0,
      evidenceCount: 0,
      diagnosis: null,
      credits: 0,
      queuedAt: p.queuedAt,
      startedAt: null,
      finishedAt: null,
      diagnosedBy: null,
    };
  }
  if (current === null || current.id !== (payload as { huntId: string }).huntId) return current;
  const ended = current.status === 'succeeded' || current.status === 'failed' || current.status === 'cancelled';
  switch (name) {
    case 'hunt.started': {
      const p = payload as HuntEventPayloads['hunt.started'];
      return ended || current.status === 'running' ? current : { ...current, status: 'running', startedAt: p.startedAt };
    }
    case 'hunt.step': {
      const p = payload as HuntEventPayloads['hunt.step'];
      if (ended || p.index <= current.stepCount) return current;
      const step = { index: p.index, tool: p.tool, summary: p.summary, at: p.at };
      return { ...current, stepCount: p.index, steps: [...current.steps, step].slice(-HUNT_LIMITS.summarySteps) };
    }
    case 'hunt.evidence': {
      const p = payload as HuntEventPayloads['hunt.evidence'];
      return ended || p.index <= current.evidenceCount ? current : { ...current, evidenceCount: p.index };
    }
    case 'hunt.diagnosis': {
      // A valid diagnosis is the result: the Hunt shows as sealed at once, `hunt.finished` follows.
      const p = payload as HuntEventPayloads['hunt.diagnosis'];
      if (ended) return current;
      return {
        ...current,
        status: 'succeeded',
        reason: 'diagnosed',
        finishedAt: p.at,
        diagnosis: { culpritDeploy: p.culpritDeploy, culpritSha: p.culpritSha, culpritService: p.culpritService, summary: p.summary },
      };
    }
    case 'hunt.finished': {
      const p = payload as HuntEventPayloads['hunt.finished'];
      return {
        ...current,
        status: p.status,
        reason: p.reason,
        credits: p.credits,
        finishedAt: p.finishedAt,
        diagnosedBy: p.diagnosedBy,
        diagnosis: p.status === 'succeeded' ? current.diagnosis : null,
      };
    }
  }
  return current;
}

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
  if (isHuntEvent(name)) {
    const service = (payload as { service: string }).service;
    const current = state.services.find((s) => s.name === service);
    if (!current) return state;
    const hunt = applyHuntEvent(current.hunt, name, payload as never);
    return hunt === current.hunt ? state : { ...state, services: replaceService(state.services, { ...current, hunt }) };
  }
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
