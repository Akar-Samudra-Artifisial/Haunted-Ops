import type { FetchLike } from './api.js';

/** Details of a failed or dropped stream. A 503 carries the server's Retry-After. */
export interface SseErrorDetail {
  status?: number;
  retryAfterMs?: number;
}

/** The subset of EventSource the client uses, plus error details. Tests inject a fake. */
export interface EventSourceLike {
  onopen: (() => void) | null;
  onerror: ((detail: SseErrorDetail) => void) | null;
  addEventListener(type: string, listener: (ev: MessageEvent<string>) => void): void;
  close(): void;
}

/** Parses Retry-After (delay seconds or an HTTP date) into milliseconds, or undefined. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d{1,7}$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  if (Number.isFinite(at)) return Math.max(0, at - now);
  return undefined;
}

/**
 * A minimal EventSource over fetch. Unlike the browser EventSource it reports
 * the HTTP status and Retry-After of a failed connection, so the client can
 * honour the server's backoff. It never reconnects by itself.
 */
export class FetchEventSource implements EventSourceLike {
  onopen: (() => void) | null = null;
  onerror: ((detail: SseErrorDetail) => void) | null = null;
  private readonly listeners = new Map<string, ((ev: MessageEvent<string>) => void)[]>();
  private readonly abort = new AbortController();
  private closed = false;
  private lastEventId = '';

  constructor(
    readonly url: string,
    private readonly fetchImpl: FetchLike = (u, init) => fetch(u, init),
  ) {
    // Start after the caller had a chance to attach handlers.
    queueMicrotask(() => void this.run());
  }

  addEventListener(type: string, listener: (ev: MessageEvent<string>) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {
    this.closed = true;
    this.abort.abort();
  }

  private fail(detail: SseErrorDetail): void {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    this.onerror?.(detail);
  }

  private async run(): Promise<void> {
    if (this.closed) return;
    let res: Response;
    try {
      res = await this.fetchImpl(this.url, {
        headers: { accept: 'text/event-stream' },
        cache: 'no-store',
        signal: this.abort.signal,
      });
    } catch {
      this.fail({});
      return;
    }
    if (!res.ok || !res.body) {
      this.fail({ status: res.status, retryAfterMs: parseRetryAfter(res.headers.get('retry-after')) });
      return;
    }
    if (this.closed) return;
    this.onopen?.();

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let match: RegExpExecArray | null;
        while ((match = /\r?\n\r?\n/.exec(buffer)) !== null) {
          const block = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);
          this.dispatchBlock(block);
          if (this.closed) return;
        }
      }
    } catch {
      // Aborted or network error: reported below.
    }
    this.fail({});
  }

  private dispatchBlock(block: string): void {
    let type = 'message';
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line === '' || line.startsWith(':')) continue;
      const sep = line.indexOf(':');
      const field = sep === -1 ? line : line.slice(0, sep);
      const value = sep === -1 ? '' : line.slice(sep + 1).replace(/^ /, '');
      if (field === 'event') type = value;
      else if (field === 'data') data.push(value);
      else if (field === 'id' && !value.includes('\0')) this.lastEventId = value;
    }
    if (data.length === 0) return;
    const ev = new MessageEvent<string>(type, { data: data.join('\n'), lastEventId: this.lastEventId });
    for (const listener of this.listeners.get(type) ?? []) listener(ev);
  }
}
