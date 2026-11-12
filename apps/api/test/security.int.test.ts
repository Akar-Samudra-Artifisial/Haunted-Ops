import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REQUEST_LOG_FIELDS } from '../src/security/logger.js';
import { TEST_ORIGIN, parsedLogs, startServer, type TestServer } from './support/http.js';

describe('security baseline over HTTP', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer();
  });
  afterAll(async () => {
    await server.close();
  });

  it('answers unknown routes with a JSON 404 and no stack', async () => {
    const res = await fetch(`${server.url}/nope`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: 'not_found', requestId: res.headers.get('x-request-id') });
  });

  it('rejects a 33 KiB body with 413 and accepts a small one', async () => {
    const big = JSON.stringify({ data: 'x'.repeat(33 * 1024) });
    const res = await fetch(`${server.url}/__test/echo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: big });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: 'payload_too_large' });

    const ok = await fetch(`${server.url}/__test/echo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' });
    expect(ok.status).toBe(201);
  });

  it('sends CORS headers only for WEB_ORIGIN', async () => {
    const allowed = await fetch(`${server.url}/__test/any`, { headers: { origin: TEST_ORIGIN } });
    expect(allowed.headers.get('access-control-allow-origin')).toBe(TEST_ORIGIN);

    const denied = await fetch(`${server.url}/__test/any`, { headers: { origin: 'http://evil.test' } });
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();

    const preflight = await fetch(`${server.url}/__test/echo`, {
      method: 'OPTIONS',
      headers: { origin: 'http://evil.test', 'access-control-request-method': 'POST' },
    });
    expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
    expect(preflight.headers.get('access-control-allow-methods')).toBeNull();
  });

  it('sends security headers on every response', async () => {
    for (const path of ['/__test/any', '/nope']) {
      const res = await fetch(`${server.url}${path}`);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('content-security-policy')).toBeTruthy();
      expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
      expect(res.headers.get('strict-transport-security')).toBeTruthy();
      expect(res.headers.get('x-powered-by')).toBeNull();
    }
  });

  it('answers unhandled errors with a generic 500', async () => {
    const res = await fetch(`${server.url}/__test/boom`);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: 'internal', requestId: res.headers.get('x-request-id') });
    expect(text).not.toContain('secret');
    expect(server.logs.join('')).not.toContain('db-secret-host');
  });

  it('assigns its own request id and logs one line per request without query or headers', async () => {
    server.logs.length = 0;
    const res = await fetch(`${server.url}/__test/any?token=abc123secret`, {
      headers: { 'x-request-id': 'client-chosen', authorization: 'Bearer hunter2' },
    });
    const id = res.headers.get('x-request-id');
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(id).not.toBe('client-chosen');
    await new Promise((r) => setTimeout(r, 20));
    const lines = parsedLogs(server.logs).filter((l) => l.msg === 'request');
    expect(lines).toHaveLength(1);
    const [line] = lines;
    expect(line).toMatchObject({ requestId: id, method: 'GET', path: '/__test/any', status: 200, level: 'info' });
    expect(Object.keys(line ?? {}).every((k) => (REQUEST_LOG_FIELDS as readonly string[]).includes(k))).toBe(true);
    const all = server.logs.join('');
    expect(all).not.toContain('abc123secret');
    expect(all).not.toContain('hunter2');
  });
});
