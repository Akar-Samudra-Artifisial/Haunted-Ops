import type { BeforeApplicationShutdown } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { requestIdOf } from '../security/request-context.js';
import type { EventBus } from './event-bus.js';
import { parseLastEventId, subscribeWithResume } from './resume.js';
import { formatControl } from './sse-format.js';

export const HEARTBEAT_MS = 15_000;
export const SSE_RETRY_AFTER_S = 5;
/** A stream whose unsent output grows past this is destroyed; the client reconnects and resumes. */
export const MAX_BUFFERED_BYTES = 64 * 1024;
/** Streams are ended cleanly after this long, so no connection lives forever. */
export const MAX_STREAM_AGE_MS = 30 * 60 * 1000;

interface Stream {
  res: ServerResponse;
  ip: string;
  heartbeat: ReturnType<typeof setInterval>;
  maxAge: ReturnType<typeof setTimeout>;
  unsubscribe: () => void;
  release: () => void;
}

export interface SseRequest extends IncomingMessage {
  query?: Record<string, unknown>;
  /** Client address as computed by Express, honouring the configured trust proxy hops. */
  ip?: string;
}

export interface SseLimits {
  maxClients: number;
  maxClientsPerIp: number;
  maxAgeMs?: number;
  maxBufferedBytes?: number;
}

/** Client address used for the per-IP cap. `req.ip` already applies `trust proxy`. */
export function clientIp(req: SseRequest): string {
  return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
}

/**
 * Owns every open SSE stream: the global and per-IP caps, heartbeats, the
 * maximum stream age, backpressure, resume and cleanup. On shutdown it ends all
 * streams and closes the bus, so the HTTP server can stop.
 */
export class SseService implements BeforeApplicationShutdown {
  private readonly streams = new Set<Stream>();
  private readonly perIp = new Map<string, number>();
  private closing = false;
  private readonly maxAgeMs: number;
  private readonly maxBufferedBytes: number;

  constructor(
    private readonly bus: EventBus,
    private readonly limits: SseLimits,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.maxAgeMs = limits.maxAgeMs ?? MAX_STREAM_AGE_MS;
    this.maxBufferedBytes = limits.maxBufferedBytes ?? MAX_BUFFERED_BYTES;
  }

  get openCount(): number {
    return this.streams.size;
  }

  openCountFor(ip: string): number {
    return this.perIp.get(ip) ?? 0;
  }

  private reject(req: SseRequest, res: ServerResponse): void {
    res.statusCode = 503;
    res.setHeader('Retry-After', String(SSE_RETRY_AFTER_S));
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'unavailable', requestId: requestIdOf(req) }));
  }

  open(req: SseRequest, res: ServerResponse): void {
    const ip = clientIp(req);
    if (
      this.closing ||
      this.streams.size >= this.limits.maxClients ||
      this.openCountFor(ip) >= this.limits.maxClientsPerIp
    ) {
      this.reject(req, res);
      return;
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    // Long-lived by design: no socket inactivity timeout on this route (heartbeats keep it busy).
    req.socket?.setTimeout?.(0);
    req.socket?.setKeepAlive?.(true);
    req.socket?.setNoDelay?.(true);

    // The slot is taken now and released exactly once, on every close path.
    this.perIp.set(ip, this.openCountFor(ip) + 1);
    let stream: Stream | null = null;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      const left = this.openCountFor(ip) - 1;
      if (left > 0) this.perIp.set(ip, left);
      else this.perIp.delete(ip);
      if (stream) {
        clearInterval(stream.heartbeat);
        clearTimeout(stream.maxAge);
        stream.unsubscribe();
        this.streams.delete(stream);
      }
    };
    const write = (chunk: string): void => {
      if (released || res.writableEnded || res.destroyed) {
        release();
        return;
      }
      res.write(chunk);
      // A slow client: drop it rather than buffer without bound. It reconnects and resumes or resyncs.
      if (res.writableLength > this.maxBufferedBytes) {
        release();
        res.destroy();
      }
    };

    const last = parseLastEventId(req.headers['last-event-id'], req.query?.lastEventId, this.bus.bootId);
    const sub = subscribeWithResume(this.bus, last, write);
    if (released) {
      sub.unsubscribe();
      return;
    }
    stream = {
      res,
      ip,
      heartbeat: setInterval(() => write(formatControl('heartbeat', { at: this.now().toISOString() })), HEARTBEAT_MS),
      maxAge: setTimeout(() => {
        release();
        res.end();
      }, this.maxAgeMs),
      unsubscribe: sub.unsubscribe,
      release,
    };
    this.streams.add(stream);

    req.on('close', release);
    res.on('close', release);
    res.on('error', release);
  }

  /** Ends every stream and releases the bus. */
  beforeApplicationShutdown(): void {
    this.closing = true;
    for (const stream of [...this.streams]) {
      stream.release();
      stream.res.end();
    }
    this.streams.clear();
    this.perIp.clear();
    this.bus.close();
  }
}
