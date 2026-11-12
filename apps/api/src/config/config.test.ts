import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULTS, isOrigin, parseConfig } from './config.js';

const good = {
  DATABASE_URL: 'postgresql://app@localhost:5432/haunted_dev',
  PORT: '3000',
  WEB_ORIGIN: 'http://localhost:5173',
};

function errorOf(env: Record<string, string | undefined>): ConfigError {
  try {
    parseConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) return err;
    throw err;
  }
  throw new Error('expected ConfigError');
}

describe('parseConfig', () => {
  it('parses a valid environment with defaults', () => {
    const cfg = parseConfig(good);
    expect(cfg).toEqual({
      databaseUrl: good.DATABASE_URL,
      port: 3000,
      webOrigin: good.WEB_ORIGIN,
      host: '127.0.0.1',
      sseMaxClients: DEFAULTS.sseMaxClients,
      sseMaxClientsPerIp: 5,
      rateLimitMax: DEFAULTS.rateLimitMax,
      trustProxyHops: 0,
    });
    expect(Object.isFrozen(cfg)).toBe(true);
  });

  it('reads HOST, SSE_MAX_CLIENTS_PER_IP and TRUST_PROXY_HOPS', () => {
    const cfg = parseConfig({ ...good, HOST: '0.0.0.0', SSE_MAX_CLIENTS_PER_IP: '2', TRUST_PROXY_HOPS: '3' });
    expect(cfg.host).toBe('0.0.0.0');
    expect(cfg.sseMaxClientsPerIp).toBe(2);
    expect(cfg.trustProxyHops).toBe(3);
    expect(parseConfig({ ...good, HOST: '::1' }).host).toBe('::1');
    expect(parseConfig({ ...good, HOST: 'api.internal' }).host).toBe('api.internal');
    expect(parseConfig({ ...good, TRUST_PROXY_HOPS: '0' }).trustProxyHops).toBe(0);
  });

  it.each([
    ['TRUST_PROXY_HOPS', '4'],
    ['TRUST_PROXY_HOPS', 'true'],
    ['TRUST_PROXY_HOPS', '-1'],
    ['SSE_MAX_CLIENTS_PER_IP', '0'],
    ['HOST', 'http://0.0.0.0'],
    ['HOST', 'localhost:3000'],
    ['HOST', 'a b'],
  ])('rejects %s=%s', (name, value) => {
    expect(errorOf({ ...good, [name]: value }).variables).toEqual([name]);
  });

  it('reads optional variables', () => {
    const cfg = parseConfig({ ...good, SSE_MAX_CLIENTS: '5', RATE_LIMIT_MAX: '7' });
    expect(cfg.sseMaxClients).toBe(5);
    expect(cfg.rateLimitMax).toBe(7);
  });

  it('names every offending variable at once', () => {
    const err = errorOf({ PORT: '70000', SSE_MAX_CLIENTS: '0' });
    expect(err.message).toBe('Invalid configuration: DATABASE_URL, PORT, WEB_ORIGIN, SSE_MAX_CLIENTS');
  });

  it('never echoes values', () => {
    const secret = 'postgresql://user:hunter2-very-secret@/db';
    const err = errorOf({ ...good, DATABASE_URL: 'mysql://user:hunter2-very-secret@db/x', PORT: secret });
    expect(err.message).not.toContain('hunter2');
  });

  it.each([
    ['DATABASE_URL', 'http://localhost/db'],
    ['DATABASE_URL', 'not a url'],
    ['PORT', '0'],
    ['PORT', '3000.5'],
    ['PORT', ' 3000'],
    ['WEB_ORIGIN', 'http://localhost:5173/'],
    ['WEB_ORIGIN', 'http://localhost:5173/app'],
    ['WEB_ORIGIN', 'ftp://localhost'],
    ['WEB_ORIGIN', '*'],
    ['RATE_LIMIT_MAX', '-1'],
  ])('rejects %s=%s', (name, value) => {
    expect(errorOf({ ...good, [name]: value }).variables).toEqual([name]);
  });
});

describe('isOrigin', () => {
  it('accepts canonical origins only', () => {
    expect(isOrigin('https://example.test')).toBe(true);
    expect(isOrigin('https://example.test:8443')).toBe(true);
    expect(isOrigin('https://EXAMPLE.test')).toBe(false);
    expect(isOrigin('https://example.test?x=1')).toBe(false);
    expect(isOrigin('https://u:p@example.test')).toBe(false);
  });
});
