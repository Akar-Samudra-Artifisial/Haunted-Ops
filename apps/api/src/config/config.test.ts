import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULTS, isLinkLocalHost, isOrigin, parseConfig } from './config.js';

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
      prometheusUrl: 'http://127.0.0.1:9090',
      prometheusAllowRemote: false,
      pollIntervalMs: 5000,
      pollTimeoutMs: 3000,
      signalRetentionH: 24,
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

describe('ingest variables', () => {
  it('reads PROMETHEUS_URL, POLL_INTERVAL_MS, POLL_TIMEOUT_MS and SIGNAL_RETENTION_H', () => {
    const cfg = parseConfig({
      ...good,
      PROMETHEUS_URL: 'https://prom.example.test:9443',
      PROMETHEUS_ALLOW_REMOTE: 'true',
      POLL_INTERVAL_MS: '2000',
      POLL_TIMEOUT_MS: '1500',
      SIGNAL_RETENTION_H: '48',
    });
    expect(cfg.prometheusUrl).toBe('https://prom.example.test:9443');
    expect(cfg.pollIntervalMs).toBe(2000);
    expect(cfg.pollTimeoutMs).toBe(1500);
    expect(cfg.signalRetentionH).toBe(48);
  });

  it('defaults the timeout to the smaller of 3000 and the interval', () => {
    expect(parseConfig({ ...good, POLL_INTERVAL_MS: '1000' }).pollTimeoutMs).toBe(1000);
    expect(parseConfig({ ...good, POLL_INTERVAL_MS: '60000' }).pollTimeoutMs).toBe(3000);
    expect(parseConfig(good).pollTimeoutMs).toBe(3000);
  });

  it.each([
    ['PROMETHEUS_URL', 'http://127.0.0.1:9090/'],
    ['PROMETHEUS_URL', 'http://127.0.0.1:9090/api'],
    ['PROMETHEUS_URL', 'http://user:pass@127.0.0.1:9090'],
    ['PROMETHEUS_URL', 'http://127.0.0.1:9090?x=1'],
    ['PROMETHEUS_URL', 'ftp://127.0.0.1'],
    ['POLL_INTERVAL_MS', '999'],
    ['POLL_INTERVAL_MS', '60001'],
    ['POLL_INTERVAL_MS', '5s'],
    ['POLL_TIMEOUT_MS', '99'],
    ['POLL_TIMEOUT_MS', '30001'],
    ['POLL_TIMEOUT_MS', '5001'],
    ['SIGNAL_RETENTION_H', '0'],
    ['SIGNAL_RETENTION_H', '721'],
    ['SIGNAL_RETENTION_H', '1.5'],
  ])('rejects %s=%s', (name, value) => {
    expect(errorOf({ ...good, [name]: value }).variables).toEqual([name]);
  });

  it.each(['http://127.0.0.1:9090', 'http://127.0.0.1', 'http://localhost:9090', 'https://localhost', 'http://[::1]:9090'])(
    'accepts the loopback host %s',
    (url) => {
      expect(parseConfig({ ...good, PROMETHEUS_URL: url }).prometheusUrl).toBe(url);
    },
  );

  it.each(['http://prometheus.internal:9090', 'http://10.0.0.5:9090', 'https://example.test', 'http://192.168.1.10:9090', 'http://0.0.0.0:9090'])(
    'refuses the remote host %s unless PROMETHEUS_ALLOW_REMOTE=true',
    (url) => {
      expect(errorOf({ ...good, PROMETHEUS_URL: url }).variables).toEqual(['PROMETHEUS_URL']);
      expect(errorOf({ ...good, PROMETHEUS_URL: url, PROMETHEUS_ALLOW_REMOTE: 'false' }).variables).toEqual(['PROMETHEUS_URL']);
      const cfg = parseConfig({ ...good, PROMETHEUS_URL: url, PROMETHEUS_ALLOW_REMOTE: 'true' });
      expect(cfg.prometheusUrl).toBe(url);
      expect(cfg.prometheusAllowRemote).toBe(true);
    },
  );

  it.each([
    'http://169.254.169.254',
    'http://169.254.0.1:9090',
    'http://169.254.255.255',
    'http://[fe80::1]:9090',
    'http://[febf::1]',
    'http://[fe80::a9fe:a9fe]',
    'http://[::ffff:169.254.169.254]',
    'http://[::ffff:a9fe:a9fe]:9090',
  ])('always refuses the link-local host %s, even with PROMETHEUS_ALLOW_REMOTE=true', (url) => {
    expect(errorOf({ ...good, PROMETHEUS_URL: url }).variables).toEqual(['PROMETHEUS_URL']);
    expect(errorOf({ ...good, PROMETHEUS_URL: url, PROMETHEUS_ALLOW_REMOTE: 'true' }).variables).toEqual(['PROMETHEUS_URL']);
  });

  it('allows the neighbours of the link-local ranges when remote hosts are allowed', () => {
    for (const url of ['http://169.253.1.1', 'http://169.255.1.1', 'http://[fec0::1]', 'http://[fe7f::1]']) {
      expect(parseConfig({ ...good, PROMETHEUS_URL: url, PROMETHEUS_ALLOW_REMOTE: 'true' }).prometheusUrl).toBe(url);
    }
    expect(isLinkLocalHost('169.254.1.1')).toBe(true);
    expect(isLinkLocalHost('169.253.1.1')).toBe(false);
  });

  it.each(['yes', 'TRUE', '1', 'True', 'on'])('rejects PROMETHEUS_ALLOW_REMOTE=%s', (value) => {
    expect(errorOf({ ...good, PROMETHEUS_ALLOW_REMOTE: value }).variables).toEqual(['PROMETHEUS_ALLOW_REMOTE']);
  });

  it('names the variable and never prints the Prometheus URL', () => {
    const err = errorOf({ ...good, PROMETHEUS_URL: 'http://169.254.169.254' });
    expect(err.message).toBe('Invalid configuration: PROMETHEUS_URL');
    expect(err.message).not.toContain('169.254');
    const refused = errorOf({ ...good, PROMETHEUS_URL: 'http://secret-host.internal:9090' });
    expect(refused.message).not.toContain('secret-host');
  });

  it('checks the timeout against the configured interval', () => {
    expect(parseConfig({ ...good, POLL_INTERVAL_MS: '1000', POLL_TIMEOUT_MS: '1000' }).pollTimeoutMs).toBe(1000);
    expect(errorOf({ ...good, POLL_INTERVAL_MS: '1000', POLL_TIMEOUT_MS: '1001' }).variables).toEqual(['POLL_TIMEOUT_MS']);
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
