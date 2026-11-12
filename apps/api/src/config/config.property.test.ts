// Feature: foundation, Property 6: Config validation rejects bad input without echoing it
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  OPTIONAL_VARS,
  REQUIRED_VARS,
  formatConfigError,
  isListenHost,
  parseConfig,
  type ConfigVar,
} from './config.js';

const hostArb = fc.constantFrom('localhost', 'db.internal', '127.0.0.1', 'example.test');

const validEnvArb = fc.record({
  DATABASE_URL: fc
    .tuple(fc.constantFrom('postgres', 'postgresql'), hostArb, fc.integer({ min: 1, max: 65535 }), fc.stringMatching(/^[a-z_]{1,12}$/))
    .map(([s, h, p, d]) => `${s}://app@${h}:${p}/${d}`),
  PORT: fc.integer({ min: 1, max: 65535 }).map(String),
  WEB_ORIGIN: fc
    .tuple(fc.constantFrom('http', 'https'), hostArb, fc.option(fc.integer({ min: 1, max: 65535 }), { nil: undefined }))
    .map(([s, h, p]) => new URL(`${s}://${h}${p === undefined ? '' : `:${p}`}`).origin),
  HOST: fc.option(fc.constantFrom('127.0.0.1', '0.0.0.0', '::', '::1', 'localhost', 'api.internal'), { nil: undefined }),
  SSE_MAX_CLIENTS: fc.option(fc.integer({ min: 1, max: 100000 }).map(String), { nil: undefined }),
  SSE_MAX_CLIENTS_PER_IP: fc.option(fc.integer({ min: 1, max: 1000 }).map(String), { nil: undefined }),
  RATE_LIMIT_MAX: fc.option(fc.integer({ min: 1, max: 100000 }).map(String), { nil: undefined }),
  TRUST_PROXY_HOPS: fc.option(fc.integer({ min: 0, max: 3 }).map(String), { nil: undefined }),
});

const notDigits = fc.string({ minLength: 1 }).filter((s) => !/^\s*\d+\s*$/.test(s) && s.trim() !== '');

/** Invalid values per variable; `undefined` means the variable is missing. */
const invalidArbs: Record<ConfigVar, fc.Arbitrary<string | undefined>> = {
  DATABASE_URL: fc.oneof(
    fc.constant(undefined),
    fc.constant(''),
    fc.string().filter((s) => !/^postgres(ql)?:\/\//.test(s)),
    hostArb.map((h) => `mysql://secret-value@${h}/db`),
  ),
  PORT: fc.oneof(
    fc.constant(undefined),
    fc.constant('0'),
    fc.integer({ min: 65536, max: 10_000_000 }).map(String),
    fc.string().filter((s) => !/^\d+$/.test(s)),
  ),
  WEB_ORIGIN: fc.oneof(
    fc.constant(undefined),
    fc.constant('*'),
    hostArb.map((h) => `http://${h}/path-secret`),
    hostArb.map((h) => `ftp://${h}`),
    fc.string().filter((s) => !/^https?:\/\//.test(s)),
  ),
  HOST: fc.oneof(
    fc.constantFrom('http://0.0.0.0', 'localhost:3000', 'a b', '-bad', 'x/y'),
    fc.string({ minLength: 1 }).filter((s) => s.trim() !== '' && !isListenHost(s)),
  ),
  SSE_MAX_CLIENTS: fc.oneof(fc.constant('0'), fc.constant('-3'), notDigits),
  SSE_MAX_CLIENTS_PER_IP: fc.oneof(fc.constant('0'), fc.constant('2.5'), notDigits),
  RATE_LIMIT_MAX: fc.oneof(fc.constant('0'), fc.constant('1.5'), notDigits),
  TRUST_PROXY_HOPS: fc.oneof(fc.constant('true'), fc.integer({ min: 4, max: 1000 }).map(String), notDigits),
};

const ALL_VARS: readonly ConfigVar[] = [...REQUIRED_VARS, ...OPTIONAL_VARS];

describe('Property 6: config validation', () => {
  it('returns the parsed values for every valid environment', () => {
    fc.assert(
      fc.property(validEnvArb, (env) => {
        const cfg = parseConfig(env);
        expect(cfg.databaseUrl).toBe(env.DATABASE_URL);
        expect(cfg.port).toBe(Number(env.PORT));
        expect(cfg.webOrigin).toBe(env.WEB_ORIGIN);
        expect(cfg.sseMaxClients).toBe(env.SSE_MAX_CLIENTS === undefined ? 100 : Number(env.SSE_MAX_CLIENTS));
        expect(cfg.rateLimitMax).toBe(env.RATE_LIMIT_MAX === undefined ? 30 : Number(env.RATE_LIMIT_MAX));
        expect(cfg.host).toBe(env.HOST ?? '127.0.0.1');
        expect(cfg.sseMaxClientsPerIp).toBe(env.SSE_MAX_CLIENTS_PER_IP === undefined ? 5 : Number(env.SSE_MAX_CLIENTS_PER_IP));
        expect(cfg.trustProxyHops).toBe(env.TRUST_PROXY_HOPS === undefined ? 0 : Number(env.TRUST_PROXY_HOPS));
      }),
      { numRuns: 200 },
    );
  });

  it('rejects any set of broken variables, names exactly those, and echoes no value', () => {
    const brokenArb = fc
      .subarray([...ALL_VARS], { minLength: 1 })
      .chain((names) => fc.tuple(fc.constant(names), fc.tuple(...names.map((n) => invalidArbs[n]))));
    fc.assert(
      fc.property(validEnvArb, brokenArb, (valid, [names, values]) => {
        const env: Record<string, string | undefined> = { ...valid };
        names.forEach((name, i) => {
          env[name] = values[i];
        });
        let caught: unknown;
        try {
          parseConfig(env);
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(ConfigError);
        const err = caught as ConfigError;
        const expected = ALL_VARS.filter((n) => names.includes(n));
        expect(err.variables).toEqual(expected);
        // The message is a function of the names only, so no value can appear in it.
        expect(err.message).toBe(formatConfigError(expected));
        for (const name of ALL_VARS) {
          const v = env[name];
          if (v !== undefined && v.length >= 8) expect(err.message).not.toContain(v);
        }
      }),
      { numRuns: 300 },
    );
  });
});
