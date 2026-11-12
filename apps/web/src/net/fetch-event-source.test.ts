import { describe, expect, it } from 'vitest';
import { FetchEventSource, parseRetryAfter, type SseErrorDetail } from './fetch-event-source.js';

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

function response(init: { status: number; headers?: Record<string, string>; body?: ReadableStream<Uint8Array> | null }): Response {
  return {
    ok: init.status >= 200 && init.status < 300,
    status: init.status,
    headers: new Headers(init.headers ?? {}),
    body: init.body ?? null,
  } as Response;
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('parseRetryAfter', () => {
  it('reads seconds and HTTP dates', () => {
    expect(parseRetryAfter('5')).toBe(5_000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
    const now = Date.parse('2026-11-12T10:00:00.000Z');
    expect(parseRetryAfter('Thu, 12 Nov 2026 10:00:30 GMT', now)).toBe(30_000);
  });
});

describe('FetchEventSource', () => {
  it('reports status and Retry-After of a 503', async () => {
    const errors: SseErrorDetail[] = [];
    const es = new FetchEventSource('http://api.test/api/events', async () =>
      response({ status: 503, headers: { 'retry-after': '5' } }),
    );
    es.onerror = (d) => errors.push(d);
    await settle();
    expect(errors).toEqual([{ status: 503, retryAfterMs: 5_000 }]);
  });

  it('dispatches named events with their ids, across chunk boundaries', async () => {
    const got: { type: string; data: string; id: string }[] = [];
    let opened = false;
    const errors: SseErrorDetail[] = [];
    const es = new FetchEventSource('http://api.test/api/events', async () =>
      response({
        status: 200,
        body: streamOf([
          ': connected\n\nevent: connected\ndata: {"bootId":"a1b2c3d4e5f6"}\n\nid: a1b2c3d4e5f6-1\nevent: service.up',
          'dated\ndata: {"x":1}\n\nevent: heartbeat\ndata: {}\n\n',
        ]),
      }),
    );
    es.onopen = () => {
      opened = true;
    };
    es.onerror = (d) => errors.push(d);
    for (const type of ['connected', 'service.updated', 'heartbeat']) {
      es.addEventListener(type, (ev) => got.push({ type, data: ev.data, id: ev.lastEventId }));
    }
    await settle();
    await settle();
    expect(opened).toBe(true);
    expect(got).toEqual([
      { type: 'connected', data: '{"bootId":"a1b2c3d4e5f6"}', id: '' },
      { type: 'service.updated', data: '{"x":1}', id: 'a1b2c3d4e5f6-1' },
      { type: 'heartbeat', data: '{}', id: 'a1b2c3d4e5f6-1' },
    ]);
    // The stream ended: reported once as an error so the client reconnects.
    expect(errors).toEqual([{}]);
  });

  it('reports a network failure and stays silent after close()', async () => {
    const errors: SseErrorDetail[] = [];
    const failing = new FetchEventSource('http://api.test/api/events', async () => {
      throw new TypeError('network');
    });
    failing.onerror = (d) => errors.push(d);
    const closed = new FetchEventSource('http://api.test/api/events', async () => response({ status: 503 }));
    closed.onerror = (d) => errors.push(d);
    closed.close();
    await settle();
    expect(errors).toEqual([{}]);
  });
});
