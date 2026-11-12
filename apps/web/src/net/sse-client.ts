import {
  DOMAIN_EVENT_NAMES,
  SERVICE_NAMES,
  validateSseEvent,
  type ServiceState,
  type SseEventName,
} from '@haunted-ops/shared';
import { fetchServices, type FetchLike } from './api.js';
import { reconnectDelay } from './backoff.js';
import { FetchEventSource, type EventSourceLike, type SseErrorDetail } from './fetch-event-source.js';
import {
  LIVE_WINDOW_MS,
  initialConnectionState,
  reduceConnection,
  type ConnectionAction,
  type ConnectionState,
} from './status.js';

export type { EventSourceLike, SseErrorDetail };
export type EventSourceFactory = (url: string) => EventSourceLike;

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface SseClientOptions {
  baseUrl: string;
  createEventSource?: EventSourceFactory;
  fetchImpl?: FetchLike;
  timers?: Timers;
  now?: () => number;
  random?: () => number;
  /** Window-like target for `online` / `offline` events. */
  network?: Pick<Window, 'addEventListener' | 'removeEventListener'> & { navigator?: { onLine: boolean } };
  onServices: (services: ServiceState[]) => void;
  onConnection: (state: ConnectionState) => void;
}

export const TICK_MS = 5_000;
const STREAM_EVENTS: readonly SseEventName[] = [...DOMAIN_EVENT_NAMES, 'connected', 'heartbeat', 'resync'];

const defaultTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (h) => globalThis.clearInterval(h as ReturnType<typeof setInterval>),
};

/** Room order: row (y), then column (x), then the fixed service order. */
export function sortByRoom(services: readonly ServiceState[]): ServiceState[] {
  const rank = (s: ServiceState): number => SERVICE_NAMES.indexOf(s.name);
  return [...services].sort((a, b) => a.room.y - b.room.y || a.room.x - b.room.x || rank(a) - rank(b));
}

/**
 * Merges a snapshot with the current state: per service the entry with the
 * later `updatedAt` wins, so a snapshot never overwrites a newer event.
 */
export function mergeByUpdatedAt(current: readonly ServiceState[], snapshot: readonly ServiceState[]): ServiceState[] {
  const byName = new Map<string, ServiceState>();
  for (const s of snapshot) byName.set(s.name, s);
  for (const s of current) {
    const snap = byName.get(s.name);
    if (!snap || Date.parse(s.updatedAt) > Date.parse(snap.updatedAt)) byName.set(s.name, s);
  }
  return sortByRoom([...byName.values()]);
}

/**
 * SSE client for GET /api/events. It owns reconnects so it can apply backoff
 * (and the server's Retry-After) and send `lastEventId` as a query parameter.
 * On `connected` it loads GET /api/services; a new boot id or a `resync` also
 * clears the resume id, so the next reconnect starts fresh.
 */
export class SseClient {
  private readonly o: Required<Omit<SseClientOptions, 'network'>> & Pick<SseClientOptions, 'network'>;
  private source: EventSourceLike | null = null;
  private retryTimer: unknown = null;
  private tickTimer: unknown = null;
  private attempt = 0;
  private lastEventId: string | null = null;
  private bootId: string | null = null;
  private services: ServiceState[] = [];
  /** Counts applied `service.updated` events, to detect events that race a snapshot fetch. */
  private eventSeq = 0;
  private loading = false;
  private reloadQueued = false;
  private state: ConnectionState;
  private stopped = true;

  constructor(options: SseClientOptions) {
    const fetchImpl: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.o = {
      createEventSource: (url) => new FetchEventSource(url, fetchImpl),
      timers: defaultTimers,
      now: () => Date.now(),
      random: () => Math.random(),
      ...options,
      fetchImpl,
    };
    const online = options.network?.navigator?.onLine ?? true;
    this.state = initialConnectionState(this.o.now(), online);
  }

  get connection(): ConnectionState {
    return this.state;
  }

  /** The id the next reconnect resumes from, or null. */
  get resumeId(): string | null {
    return this.lastEventId;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.o.network?.addEventListener('online', this.handleOnline);
    this.o.network?.addEventListener('offline', this.handleOffline);
    this.tickTimer = this.o.timers.setInterval(this.handleTick, TICK_MS);
    this.o.onConnection(this.state);
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.o.network?.removeEventListener('online', this.handleOnline);
    this.o.network?.removeEventListener('offline', this.handleOffline);
    if (this.tickTimer !== null) this.o.timers.clearInterval(this.tickTimer);
    this.tickTimer = null;
    this.clearRetry();
    this.closeSource();
  }

  private dispatch(action: ConnectionAction['type']): void {
    const next = reduceConnection(this.state, { type: action, at: this.o.now() });
    const changed = next.status !== this.state.status;
    this.state = next;
    if (changed || action === 'open' || action === 'error') this.o.onConnection(next);
  }

  private streamUrl(): string {
    const base = `${this.o.baseUrl}/api/events`;
    return this.lastEventId === null ? base : `${base}?lastEventId=${encodeURIComponent(this.lastEventId)}`;
  }

  private connect(): void {
    if (this.stopped) return;
    this.closeSource();
    const source = this.o.createEventSource(this.streamUrl());
    this.source = source;
    source.onopen = () => {
      if (this.source !== source) return;
      this.attempt = 0;
      this.dispatch('open');
    };
    source.onerror = (detail) => {
      if (this.source !== source) return;
      this.closeSource();
      this.dispatch('error');
      this.scheduleReconnect(detail?.retryAfterMs);
    };
    for (const name of STREAM_EVENTS) {
      source.addEventListener(name, (ev) => {
        if (this.source === source) this.handleEvent(name, ev);
      });
    }
  }

  private parse(ev: MessageEvent<string>): unknown {
    try {
      return JSON.parse(ev.data);
    } catch {
      return undefined;
    }
  }

  private handleEvent(name: SseEventName, ev: MessageEvent<string>): void {
    this.dispatch('message');
    if (name === 'connected') {
      const result = validateSseEvent('connected', this.parse(ev));
      if (!result.ok) return;
      if (this.bootId !== null && this.bootId !== result.value.bootId) {
        // The server restarted: ids of the old boot mean nothing now.
        this.lastEventId = null;
      }
      this.bootId = result.value.bootId;
      void this.loadServices();
      return;
    }
    if (name === 'resync') {
      this.lastEventId = null;
      void this.loadServices();
      return;
    }
    if (name === 'heartbeat') return;

    if (typeof ev.lastEventId === 'string' && ev.lastEventId !== '') this.lastEventId = ev.lastEventId;
    if (name !== 'service.updated') return;
    const result = validateSseEvent('service.updated', this.parse(ev));
    if (!result.ok) return;
    const updated = result.value.service;
    this.eventSeq++;
    this.services = sortByRoom([...this.services.filter((s) => s.name !== updated.name), updated]);
    this.o.onServices(this.services);
  }

  /** Loads the snapshot. Concurrent calls coalesce into one follow-up load. */
  private async loadServices(): Promise<void> {
    if (this.loading) {
      this.reloadQueued = true;
      return;
    }
    this.loading = true;
    const seqAtStart = this.eventSeq;
    try {
      const snapshot = await fetchServices(this.o.baseUrl, this.o.fetchImpl);
      if (this.stopped) return;
      // An event that arrived after the fetch started may be newer than the snapshot.
      this.services = this.eventSeq === seqAtStart ? sortByRoom(snapshot) : mergeByUpdatedAt(this.services, snapshot);
      this.o.onServices(this.services);
    } catch {
      // Keep the previous state; the next connect or resync retries.
    } finally {
      this.loading = false;
      if (this.reloadQueued && !this.stopped) {
        this.reloadQueued = false;
        void this.loadServices();
      }
    }
  }

  private scheduleReconnect(retryAfterMs?: number): void {
    if (this.stopped) return;
    this.clearRetry();
    const delay = reconnectDelay(this.attempt, this.o.random(), retryAfterMs);
    this.attempt++;
    this.retryTimer = this.o.timers.setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) this.o.timers.clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private closeSource(): void {
    const source = this.source;
    this.source = null;
    if (source) {
      source.onopen = null;
      source.onerror = null;
      source.close();
    }
  }

  private readonly handleTick = (): void => {
    this.dispatch('tick');
    const last = this.state.lastActivityAt;
    // An open stream that went silent (no heartbeat for 45 s) is treated as dropped.
    if (this.source !== null && this.state.open && last !== null && this.o.now() - last > LIVE_WINDOW_MS) {
      this.closeSource();
      this.dispatch('error');
      this.scheduleReconnect();
    }
  };

  private readonly handleOnline = (): void => {
    this.dispatch('online');
    this.attempt = 0;
    this.clearRetry();
    this.connect();
  };

  private readonly handleOffline = (): void => {
    this.dispatch('offline');
  };
}
