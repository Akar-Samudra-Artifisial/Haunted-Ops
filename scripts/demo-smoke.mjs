#!/usr/bin/env node
// Smoke test of the public demo, from outside:  node scripts/demo-smoke.mjs <origin>
// It sends GET requests, two POSTs that must be refused (405), and opens the event stream once. No token, no redirect followed.
// Exit 0 only when every check passes. It prints a table of name, status and OK or FAIL.
import { isMain } from './is-main.mjs';

export const REQUEST_TIMEOUT_MS = 10_000;
export const SSE_TIMEOUT_MS = 5_000;

/** Headers that must be on the page, with a test for each value. */
export const REQUIRED_HEADERS = Object.freeze([
  ['content-security-policy', (v) => v.includes("default-src 'self'")],
  ['x-content-type-options', (v) => v.toLowerCase() === 'nosniff'],
  ['referrer-policy', (v) => v.length > 0],
  ['strict-transport-security', (v) => /max-age=\d+/.test(v)],
]);

/** @param {string} origin */
export function parseOrigin(origin) {
  if (!URL.canParse(origin)) return null;
  const u = new URL(origin);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.origin !== origin && `${u.origin}/` !== origin) return null;
  return u.origin;
}

/**
 * @typedef {{ name: string; status: number | string; ok: boolean }} Result
 * @param {string} origin
 * @param {{ fetchImpl?: typeof fetch; sseTimeoutMs?: number; timeoutMs?: number }} [options]
 * @returns {Promise<Result[]>}
 */
export async function runSmoke(origin, options = {}) {
  const base = parseOrigin(origin);
  if (base === null) throw new Error('origin must be http(s)://host[:port] with no path');
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const sseTimeoutMs = options.sseTimeoutMs ?? SSE_TIMEOUT_MS;
  /** @type {Result[]} */
  const results = [];

  /** One request; never throws. Returns the response (body already read as text) or an error code. */
  const request = async (/** @type {string} */ path, /** @type {string} */ method = 'GET') => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await doFetch(`${base}${path}`, { method, redirect: 'manual', signal: ctl.signal, headers: { accept: '*/*' } });
      const text = await res.text();
      return { res, text, error: null };
    } catch {
      return { res: null, text: '', error: ctl.signal.aborted ? 'timeout' : 'error' };
    } finally {
      clearTimeout(timer);
    }
  };
  const record = (/** @type {string} */ name, /** @type {number | string} */ status, /** @type {boolean} */ ok) => results.push({ name, status, ok });
  const isHtml = (/** @type {Response} */ res, /** @type {string} */ text) => (res.headers.get('content-type') ?? '').includes('text/html') && /<html|<!doctype html/i.test(text);

  for (const [name, path] of [
    ['GET /', '/'],
    ['GET /hunts/x (fallback)', '/hunts/x'],
    ['GET /?demo=1', '/?demo=1'],
  ]) {
    const { res, text, error } = await request(path);
    record(name, res ? res.status : (error ?? 'error'), res !== null && res.status === 200 && isHtml(res, text));
  }

  {
    const { res, text, error } = await request('/healthz');
    let ok = false;
    if (res && res.status === 200) {
      try {
        ok = JSON.parse(text).status === 'ok';
      } catch {
        ok = false;
      }
    }
    record('GET /healthz', res ? res.status : (error ?? 'error'), ok);
  }

  {
    const { res, text, error } = await request('/api/services');
    let ok = false;
    if (res && res.status === 200 && (res.headers.get('content-type') ?? '').includes('json')) {
      try {
        JSON.parse(text);
        ok = true;
      } catch {
        ok = false;
      }
    }
    record('GET /api/services', res ? res.status : (error ?? 'error'), ok);
  }

  results.push(await checkStream(base, doFetch, sseTimeoutMs));

  for (const path of ['/api/hunts', '/api/hunts/kill-switch']) {
    const { res, error } = await request(path, 'POST');
    record(`POST ${path} refused`, res ? res.status : (error ?? 'error'), res !== null && res.status === 405);
  }

  {
    const { res, error } = await request('/.vite/manifest.json');
    record('GET /.vite/manifest.json is 404', res ? res.status : (error ?? 'error'), res !== null && res.status === 404);
  }

  {
    const { res, error } = await request('/');
    for (const [header, valid] of REQUIRED_HEADERS) {
      const value = res?.headers.get(header) ?? null;
      record(`header ${header}`, res ? res.status : (error ?? 'error'), value !== null && valid(value));
    }
  }
  return results;
}

/** Opens /api/events, waits for the headers (at most `timeoutMs`), checks the type, then closes the stream. */
async function checkStream(/** @type {string} */ base, /** @type {typeof fetch} */ doFetch, /** @type {number} */ timeoutMs) {
  const name = 'GET /api/events is an event stream';
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await doFetch(`${base}/api/events`, { redirect: 'manual', signal: ctl.signal, headers: { accept: 'text/event-stream' } });
    const ok = res.status === 200 && (res.headers.get('content-type') ?? '').includes('text/event-stream');
    ctl.abort();
    await res.body?.cancel().catch(() => undefined);
    return { name, status: res.status, ok };
  } catch {
    return { name, status: ctl.signal.aborted ? 'timeout' : 'error', ok: false };
  } finally {
    clearTimeout(timer);
  }
}

/** @param {Result[]} results */
export function formatTable(results) {
  const rows = results.map((r) => [r.name, String(r.status), r.ok ? 'OK' : 'FAIL']);
  const widths = [0, 1, 2].map((i) => Math.max(...[['name', 'status', 'result'], ...rows].map((row) => (row[i] ?? '').length)));
  const line = (/** @type {string[]} */ row) => row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('  ').trimEnd();
  return [line(['name', 'status', 'result']), ...rows.map(line)].join('\n');
}

async function main() {
  const origin = process.argv[2];
  if (!origin || process.argv.length > 3 || parseOrigin(origin) === null) {
    process.stderr.write('usage: demo-smoke.mjs <origin>   (for example https://demo.example.org)\n');
    process.exit(2);
  }
  const results = await runSmoke(origin);
  process.stdout.write(`${formatTable(results)}\n`);
  const failed = results.filter((r) => !r.ok).length;
  process.stdout.write(failed === 0 ? 'demo-smoke: all checks passed\n' : `demo-smoke: ${failed} check(s) failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

if (isMain(import.meta.url)) await main();
