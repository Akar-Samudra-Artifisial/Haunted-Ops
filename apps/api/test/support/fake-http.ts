import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import type { SseRequest } from '../../src/events/sse.service.js';

export interface FakeExchangeOptions {
  headers?: Record<string, string>;
  query?: Record<string, unknown>;
  ip?: string;
  /** When true, written bytes stay buffered (a client that does not read). */
  stalled?: boolean;
}

/** Minimal in-memory request/response pair for SseService tests. */
export function fakeExchange(options: FakeExchangeOptions = {}) {
  const req = Object.assign(new EventEmitter(), {
    headers: options.headers ?? {},
    query: options.query ?? {},
    ip: options.ip ?? '203.0.113.1',
    socket: undefined,
  }) as unknown as SseRequest;
  const chunks: string[] = [];
  const resHeaders: Record<string, string> = {};
  const state = { writableEnded: false, destroyed: false, writableLength: 0 };
  // Getters are defined on the instance; Object.assign would copy their values once.
  const emitter = new EventEmitter();
  Object.defineProperties(emitter, {
    writableEnded: { get: () => state.writableEnded },
    destroyed: { get: () => state.destroyed },
    writableLength: { get: () => state.writableLength },
  });
  const res = Object.assign(emitter, {
    statusCode: 200,
    setHeader(k: string, v: string) {
      resHeaders[k.toLowerCase()] = v;
    },
    flushHeaders() {},
    write(chunk: string) {
      chunks.push(chunk);
      if (options.stalled) state.writableLength += Buffer.byteLength(chunk);
      return !options.stalled;
    },
    end(chunk?: string) {
      if (chunk) chunks.push(chunk);
      state.writableEnded = true;
    },
    destroy() {
      state.destroyed = true;
    },
  });
  const disconnect = (): void => {
    state.destroyed = true;
    (req as unknown as EventEmitter).emit('close');
    res.emit('close');
  };
  return { req, res: res as unknown as ServerResponse, state, chunks, headers: resHeaders, disconnect };
}
