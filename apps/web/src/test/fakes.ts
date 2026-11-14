import type { IngestStatus, ServiceState } from '@haunted-ops/shared';
import type { EventSourceLike, SseErrorDetail } from '../net/fetch-event-source.js';

export const BOOT_A = 'a1b2c3d4e5f6';
export const BOOT_B = '0f0f0f0f0f0f';

export class FakeEventSource implements EventSourceLike {
  onopen: (() => void) | null = null;
  onerror: ((detail: SseErrorDetail) => void) | null = null;
  closed = false;
  private readonly listeners = new Map<string, ((ev: MessageEvent<string>) => void)[]>();

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: (ev: MessageEvent<string>) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.onopen?.();
  }

  /** Opens and sends `connected`, as the server does. */
  connect(bootId: string = BOOT_A): void {
    this.open();
    this.emit('connected', { bootId });
  }

  fail(detail: SseErrorDetail = {}): void {
    this.onerror?.(detail);
  }

  emit(type: string, data: unknown, id?: string): void {
    const ev = new MessageEvent<string>(type, { data: JSON.stringify(data), lastEventId: id ?? '' });
    for (const l of this.listeners.get(type) ?? []) l(ev);
  }
}

export function eventSourceRegistry() {
  const created: FakeEventSource[] = [];
  return {
    created,
    factory: (url: string) => {
      const es = new FakeEventSource(url);
      created.push(es);
      return es;
    },
    latest: (): FakeEventSource => {
      const es = created.at(-1);
      if (!es) throw new Error('no EventSource created');
      return es;
    },
  };
}

export const SAMPLE_SERVICES: ServiceState[] = [
  { name: 'gate', room: { x: 0, y: 0 }, hauntLevel: 0, reason: null, metrics: null, openIncident: null, updatedAt: '2026-11-12T10:00:00.000Z', hunt: null, proposal: null },
  { name: 'orders', room: { x: 1, y: 0 }, hauntLevel: 1, reason: null, metrics: null, openIncident: null, updatedAt: '2026-11-12T10:00:00.000Z', hunt: null, proposal: null },
  { name: 'payments', room: { x: 0, y: 1 }, hauntLevel: 4, reason: null, metrics: null, openIncident: null, updatedAt: '2026-11-12T10:00:00.000Z', hunt: null, proposal: null },
  { name: 'ledger', room: { x: 1, y: 1 }, hauntLevel: 0, reason: null, metrics: null, openIncident: null, updatedAt: '2026-11-12T10:00:00.000Z', hunt: null, proposal: null },
];

export const OK_STATUS: IngestStatus = {
  state: 'ok',
  at: '2026-11-12T10:00:00.000Z',
  lastSuccessAt: '2026-11-12T10:00:00.000Z',
};

const isStatusUrl = (url: string): boolean => url.endsWith('/api/ingest/status');
const json = (body: unknown): Response => ({ ok: true, status: 200, json: async () => body }) as Response;

/** fetch stand-in that records URLs and answers with the given services. Status requests are kept apart. */
export function fakeFetch(services: () => unknown = () => SAMPLE_SERVICES, status: () => unknown = () => OK_STATUS) {
  const urls: string[] = [];
  const statusUrls: string[] = [];
  const impl = async (url: string): Promise<Response> => {
    if (isStatusUrl(url)) {
      statusUrls.push(url);
      return json(status());
    }
    urls.push(url);
    return json(services());
  };
  return { urls, statusUrls, impl };
}

/** fetch stand-in whose services responses are released by the test, to stage races. */
export function deferredFetch(status: () => unknown = () => OK_STATUS) {
  const pending: { url: string; resolve: (body: unknown) => void }[] = [];
  const impl = (url: string): Promise<Response> => {
    if (isStatusUrl(url)) return Promise.resolve(json(status()));
    return new Promise((resolveResponse) => {
      pending.push({ url, resolve: (body) => resolveResponse(json(body)) });
    });
  };
  return { pending, impl };
}
/** Lets pending promise callbacks run. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}
