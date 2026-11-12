// Feature: foundation, Property 9: Logs never leak secrets
// Feature: foundation, Property 10: Rate limit counts only mutating requests
// Feature: foundation, Property 11: CORS is exact
import { EventEmitter } from 'node:events';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { TEST_ORIGIN, startServer, testConfig } from '../../test/support/http.js';
import { isAllowedOrigin } from './cors.js';
import { JsonLogger, REQUEST_LOG_FIELDS } from './logger.js';
import { REDACTED, SECRET_KEY_PATTERN, redact, scrubText } from './redact.js';
import { requestContext, type RequestWithId } from './request-context.js';

const keyArb = fc.oneof(
  fc.string({ minLength: 1, maxLength: 12 }),
  fc.constantFrom('token', 'apiKey', 'GITHUB_TOKEN', 'password', 'Authorization', 'set-cookie', 'clientSecret', 'name', 'value'),
);
const treeArb = fc.letrec((tie) => ({
  node: fc.oneof(
    { depthSize: 'small' },
    fc.string(),
    fc.integer(),
    fc.boolean(),
    fc.constant(null),
    fc.array(tie('node'), { maxLength: 4 }),
    fc.dictionary(keyArb, tie('node'), { maxKeys: 5 }),
  ),
})).node;

/** Walks original and redacted trees side by side. */
function checkRedacted(original: unknown, out: unknown): void {
  if (typeof original === 'string') {
    expect(out).toBe(scrubText(original));
    return;
  }
  if (original === null || typeof original !== 'object') {
    expect(out).toEqual(original);
    return;
  }
  if (Array.isArray(original)) {
    expect(Array.isArray(out)).toBe(true);
    original.forEach((v, i) => checkRedacted(v, (out as unknown[])[i]));
    return;
  }
  for (const [k, v] of Object.entries(original)) {
    const o = (out as Record<string, unknown>)[k];
    if (SECRET_KEY_PATTERN.test(k)) expect(o).toBe(REDACTED);
    else checkRedacted(v, o);
  }
}

describe('Property 9: logs never leak secrets', () => {
  it('redact replaces every secret-named value and keeps everything else', () => {
    fc.assert(
      fc.property(fc.dictionary(keyArb, treeArb, { maxKeys: 6 }), (tree) => {
        checkRedacted(tree, redact(tree));
      }),
      { numRuns: 300 },
    );
  });

  it('connection strings and URL credentials inside free text never survive', () => {
    const word = fc.stringMatching(/^[A-Za-z0-9_.-]{1,12}$/);
    const secret = fc.stringMatching(/^[A-Za-z0-9]{10,16}$/).map((s) => `S3cr${s}`);
    const textArb = fc.tuple(
      fc.string({ maxLength: 20 }).map((s) => s.replace(/[a-z]+:\/\//gi, '')),
      fc.constantFrom('postgres', 'postgresql', 'redis', 'https', 'amqp'),
      word,
      secret,
      fc.constantFrom('localhost', 'db.internal:5432', '10.0.0.4'),
      fc.constantFrom(' ', '"', "'", '\n', ''),
      fc.string({ maxLength: 20 }),
    );
    fc.assert(
      fc.property(textArb, ([before, scheme, user, pass, host, sep, after]) => {
        const text = `${before} ${scheme}://${user}:${pass}@${host}/db${sep}${after}`;
        const scrubbed = redact({ msg: text, nested: [{ detail: text }] }) as { msg: string; nested: { detail: string }[] };
        for (const s of [scrubbed.msg, scrubbed.nested[0]?.detail ?? '']) {
          expect(s).not.toContain(pass);
          if (scheme.startsWith('postgres')) expect(s).not.toMatch(/postgres(ql)?:\/\//i);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('a request log line has only the allowed fields and none of the request data', () => {
    const marker = fc.stringMatching(/^[A-Za-z0-9]{12,20}$/).map((s) => `zz${s}`);
    fc.assert(
      fc.property(
        fc.constantFrom('GET', 'POST', 'DELETE', 'PATCH'),
        fc.stringMatching(/^\/[a-z/]{0,20}$/),
        marker,
        marker,
        marker,
        fc.integer({ min: 100, max: 599 }),
        (method, path, queryValue, headerValue, bodyValue, status) => {
          const lines: string[] = [];
          const mw = requestContext(new JsonLogger((l) => lines.push(l)));
          const req = Object.assign(new EventEmitter(), {
            method,
            url: `${path}?q=${queryValue}`,
            originalUrl: `${path}?q=${queryValue}`,
            headers: { authorization: headerValue, cookie: headerValue, 'x-custom': headerValue },
            body: { password: bodyValue, text: bodyValue },
          }) as unknown as RequestWithId;
          const headers: Record<string, string> = {};
          const res = Object.assign(new EventEmitter(), {
            statusCode: status,
            setHeader: (k: string, v: string) => {
              headers[k] = v;
            },
          });
          mw(req, res as never, () => undefined);
          res.emit('finish');
          res.emit('close');
          expect(lines).toHaveLength(1);
          const line = lines[0] as string;
          const parsed = JSON.parse(line) as Record<string, unknown>;
          expect(Object.keys(parsed).sort()).toEqual([...REQUEST_LOG_FIELDS].sort());
          expect(parsed.path).toBe(path);
          expect(parsed.requestId).toBe(headers['X-Request-Id']);
          for (const v of [queryValue, headerValue, bodyValue]) expect(line).not.toContain(v);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('Property 10: rate limit counts only mutating requests', () => {
  it('safe methods never count; the (limit + 1)th mutating request gets 429 with Retry-After', async () => {
    const limit = 3;
    const methodArb = fc.constantFrom('GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE');
    await fc.assert(
      fc.asyncProperty(fc.array(methodArb, { minLength: 1, maxLength: 12 }), async (methods) => {
        const server = await startServer({ config: testConfig({ RATE_LIMIT_MAX: String(limit) }) });
        try {
          let mutating = 0;
          for (const method of methods) {
            const res = await fetch(`${server.url}/__test/any`, { method });
            await res.arrayBuffer();
            const isMut = !['GET', 'HEAD', 'OPTIONS'].includes(method);
            if (isMut) mutating++;
            if (isMut && mutating > limit) {
              expect(res.status).toBe(429);
              expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
            } else {
              expect(res.status).not.toBe(429);
            }
          }
        } finally {
          await server.close();
        }
      }),
      { numRuns: 15 },
    );
  });
});

describe('Property 11: CORS is exact', () => {
  it('allows an origin if and only if it equals the configured one', () => {
    const originArb = fc.oneof(
      fc.constant(TEST_ORIGIN),
      fc.webUrl().map((u) => new URL(u).origin),
      fc.string(),
      fc.constantFrom(`${TEST_ORIGIN}/`, TEST_ORIGIN.toUpperCase(), `${TEST_ORIGIN}.evil.test`, 'null', '*', ` ${TEST_ORIGIN}`),
    );
    fc.assert(
      fc.property(originArb, fc.oneof(fc.constant(TEST_ORIGIN), fc.webUrl().map((u) => new URL(u).origin)), (origin, configured) => {
        expect(isAllowedOrigin(origin, configured)).toBe(origin === configured);
      }),
      { numRuns: 300 },
    );
  });
});
