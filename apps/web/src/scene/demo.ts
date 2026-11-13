import {
  SERVICE_NAMES,
  initialHauntState,
  stepHaunt,
  type HauntLevel,
  type HauntState,
  type OpenIncident,
  type Sample,
  type ServiceName,
  type ServiceState,
} from '@haunted-ops/shared';
import { clamp } from './math.js';
import type { DemoScenarioName } from './params.js';

export const DEMO_DURATION_MS = 48_000;
/** In the demo an Incident closes after this many calm seconds (30 s in the real pipeline). */
export const DEMO_INCIDENT_CLOSE_S = 2;

const ROOM: Record<ServiceName, { x: number; y: number }> = {
  gate: { x: 0, y: 0 },
  orders: { x: 1, y: 0 },
  payments: { x: 0, y: 1 },
  ledger: { x: 1, y: 1 },
};
const EPOCH = Date.parse('2026-11-13T10:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

/** Linear ramp: `from` before `t0`, `to` after `t1`. */
const ramp = (t: number, t0: number, t1: number, from: number, to: number): number =>
  from + (to - from) * clamp((t - t0) / (t1 - t0), 0, 1);

/** Calm background: a little deterministic wobble so the numbers look alive. */
function calmSample(service: ServiceName, second: number): Sample {
  const i = SERVICE_NAMES.indexOf(service);
  return { errorRate: 0.002 + 0.001 * (1 + Math.sin(second * 0.7 + i)), p95Ms: 60 + 12 * (1 + Math.sin(second * 0.9 + i * 1.7)), up: 1 };
}

/** What Prometheus would say at a given second of the script. */
function scriptedSample(service: ServiceName, s: number): Sample {
  const base = calmSample(service, s);
  switch (service) {
    case 'payments': {
      // rise 5-11 to 0.35, rise 16-20 to 0.6, hold, fall 36-40
      const up1 = ramp(s, 5, 11, 0, 0.35);
      const up2 = ramp(s, 16, 20, 0, 0.25);
      const down = ramp(s, 36, 40, 1, 0);
      return { ...base, errorRate: base.errorRate! + (up1 + up2) * down };
    }
    case 'orders': {
      const slow = ramp(s, 20, 26, 0, 2330) * ramp(s, 36, 40, 1, 0);
      return { ...base, p95Ms: base.p95Ms! + slow };
    }
    case 'ledger':
      return { ...base, up: s < 30 ? 1 : s < 36 ? 0 : ramp(s, 36, 38, 0, 1) };
    default:
      return base;
  }
}

interface Replay {
  haunt: HauntState;
  incident: { id: string; openedAt: number; peak: HauntLevel } | null;
  calm: number;
  serial: number;
}

function toState(service: ServiceName, second: number, r: Replay, sample: Sample): ServiceState {
  const openIncident: OpenIncident | null = r.incident
    ? { id: r.incident.id, openedAt: iso(r.incident.openedAt), peakLevel: r.incident.peak }
    : null;
  return {
    name: service,
    room: ROOM[service],
    hauntLevel: r.haunt.level,
    reason: r.haunt.reason,
    metrics: { ...sample, at: iso(EPOCH + second * 1000) },
    openIncident,
    updatedAt: iso(EPOCH),
  };
}

/**
 * The scripted state at time `tMs`. Pure: the same time always gives the same state. It replays the
 * script one second at a time through `stepHaunt`, so levels rise after 2 polls and fall after 3
 * like the real pipeline.
 *
 * 0-5 calm; 5-11 payments errors to 0.35; 16-20 to 0.6; 20-26 orders p95 to 2.4 s; 30 ledger down;
 * 36-40 everything returns; 44-48 calm.
 */
export function demoServices(tMs: number): ServiceState[] {
  const second = Math.max(0, Math.floor(tMs / 1000));
  return SERVICE_NAMES.map((service) => {
    const r: Replay = { haunt: initialHauntState(0, null), incident: null, calm: 0, serial: 0 };
    let sample = scriptedSample(service, 0);
    for (let s = 0; s <= second; s++) {
      sample = scriptedSample(service, s);
      r.haunt = stepHaunt(r.haunt, sample);
      const level = r.haunt.level;
      if (r.incident === null) {
        if (level >= 2) r.incident = { id: `demo-${service}-${++r.serial}`, openedAt: EPOCH + s * 1000, peak: level };
      } else if (level > 0) {
        r.calm = 0;
        r.incident.peak = Math.max(r.incident.peak, level) as HauntLevel;
      } else if (++r.calm >= DEMO_INCIDENT_CLOSE_S) {
        r.incident = null;
        r.calm = 0;
      }
    }
    return toState(service, second, r, sample);
  });
}

/** Time inside the script: stops at the end, or wraps with `loop`. */
export function demoTime(elapsedMs: number, loop: boolean): number {
  const e = Math.max(0, elapsedMs);
  return loop ? e % DEMO_DURATION_MS : Math.min(e, DEMO_DURATION_MS - 1);
}

function fixed(service: ServiceName, over: Partial<ServiceState>): ServiceState {
  return {
    name: service,
    room: ROOM[service],
    hauntLevel: 0,
    reason: null,
    metrics: { ...calmSample(service, 0), at: iso(EPOCH) },
    openIncident: null,
    updatedAt: iso(EPOCH),
    ...over,
  };
}
const metrics = (errorRate: number, p95Ms: number, up: number): ServiceState['metrics'] => ({ errorRate, p95Ms, up, at: iso(EPOCH) });
const incident = (service: ServiceName, peak: HauntLevel): OpenIncident => ({ id: `demo-${service}`, openedAt: iso(EPOCH), peakLevel: peak });

/** A frozen state for design and screenshots. */
export function scenarioServices(name: DemoScenarioName): ServiceState[] {
  const calm = SERVICE_NAMES.map((s) => fixed(s, {}));
  const patch = (changes: Partial<Record<ServiceName, Partial<ServiceState>>>): ServiceState[] =>
    calm.map((s) => (changes[s.name] ? { ...s, ...changes[s.name] } : s));
  switch (name) {
    case 'calm':
      return calm;
    case 'payments-haunted':
      return patch({
        payments: { hauntLevel: 2, reason: { kind: 'error_rate', value: 0.25 }, metrics: metrics(0.25, 90, 1), openIncident: incident('payments', 2) },
      });
    case 'payments-possessed':
      return patch({
        payments: { hauntLevel: 3, reason: { kind: 'error_rate', value: 0.6 }, metrics: metrics(0.6, 90, 1), openIncident: incident('payments', 3) },
      });
    case 'orders-fog':
      return patch({
        orders: { hauntLevel: 2, reason: { kind: 'p95', value: 2200 }, metrics: metrics(0.004, 2200, 1), openIncident: incident('orders', 2) },
      });
    case 'ledger-dark':
      return patch({
        ledger: { hauntLevel: 4, reason: { kind: 'down', value: 0 }, metrics: { errorRate: null, p95Ms: null, up: 0, at: iso(EPOCH) }, openIncident: incident('ledger', 4) },
      });
    case 'all-haunted':
      return patch({
        gate: { hauntLevel: 2, reason: { kind: 'error_rate', value: 0.3 }, metrics: metrics(0.3, 150, 1), openIncident: incident('gate', 2) },
        orders: { hauntLevel: 2, reason: { kind: 'p95', value: 2800 }, metrics: metrics(0.01, 2800, 1), openIncident: incident('orders', 2) },
        payments: { hauntLevel: 3, reason: { kind: 'error_rate', value: 0.6 }, metrics: metrics(0.6, 90, 1), openIncident: incident('payments', 3) },
        ledger: { hauntLevel: 4, reason: { kind: 'down', value: 0 }, metrics: { errorRate: null, p95Ms: null, up: 0, at: iso(EPOCH) }, openIncident: incident('ledger', 4) },
      });
  }
}
