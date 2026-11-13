/**
 * Startup configuration. Values come only from the environment.
 * Error messages name variables and never include their values.
 */
import { isIP } from 'node:net';

export interface Config {
  readonly databaseUrl: string;
  readonly port: number;
  readonly webOrigin: string;
  readonly host: string;
  readonly sseMaxClients: number;
  readonly sseMaxClientsPerIp: number;
  readonly rateLimitMax: number;
  /** Number of reverse proxies in front of the API whose X-Forwarded-For is trusted. Never `true`. */
  readonly trustProxyHops: number;
  /** Origin of the Prometheus server the Poller queries. */
  readonly prometheusUrl: string;
  /** True when PROMETHEUS_URL may name a host other than loopback. Link-local hosts stay refused. */
  readonly prometheusAllowRemote: boolean;
  readonly pollIntervalMs: number;
  readonly pollTimeoutMs: number;
  /** Signals older than this many hours are deleted. */
  readonly signalRetentionH: number;
}

export const REQUIRED_VARS = ['DATABASE_URL', 'PORT', 'WEB_ORIGIN'] as const;
export const OPTIONAL_VARS = [
  'HOST',
  'SSE_MAX_CLIENTS',
  'SSE_MAX_CLIENTS_PER_IP',
  'RATE_LIMIT_MAX',
  'TRUST_PROXY_HOPS',
  'PROMETHEUS_URL',
  'PROMETHEUS_ALLOW_REMOTE',
  'POLL_INTERVAL_MS',
  'POLL_TIMEOUT_MS',
  'SIGNAL_RETENTION_H',
] as const;
export type ConfigVar = (typeof REQUIRED_VARS)[number] | (typeof OPTIONAL_VARS)[number];

export const DEFAULTS = {
  host: '127.0.0.1',
  sseMaxClients: 100,
  sseMaxClientsPerIp: 5,
  rateLimitMax: 30,
  trustProxyHops: 0,
  prometheusUrl: 'http://127.0.0.1:9090',
  prometheusAllowRemote: false,
  pollIntervalMs: 5000,
  pollTimeoutMs: 3000,
  signalRetentionH: 24,
} as const;

export const MAX_TRUST_PROXY_HOPS = 3;

export class ConfigError extends Error {
  constructor(readonly variables: readonly ConfigVar[]) {
    super(formatConfigError(variables));
    this.name = 'ConfigError';
  }
}

export function formatConfigError(variables: readonly ConfigVar[]): string {
  return `Invalid configuration: ${variables.join(', ')}`;
}

function parseInteger(value: string, min: number, max: number): number | null {
  if (!/^\d{1,9}$/.test(value)) return null;
  const n = Number(value);
  return n >= min && n <= max ? n : null;
}

function isDatabaseUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return (url.protocol === 'postgres:' || url.protocol === 'postgresql:') && url.hostname.length > 0;
}

/** An origin is scheme + host + optional port, nothing else, in canonical form. */
export function isOrigin(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return url.origin === value;
}

/** Hosts a default PROMETHEUS_URL may name. `new URL` writes an IPv6 host in brackets. */
const LOOPBACK_HOSTS: readonly string[] = ['127.0.0.1', '[::1]', 'localhost'];

/** 169.254.0.0/16, fe80::/10, and an IPv4-mapped IPv6 address of the first. Never allowed, even remote. */
export function isLinkLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  const v6 = h.replace(/^\[|\]$/g, '');
  return /^fe[89ab][0-9a-f]:/.test(v6) || /^::ffff:a9fe:/.test(v6);
}

/**
 * PROMETHEUS_URL: an origin whose host is loopback, or any host when `allowRemote` is set,
 * and never a link-local host (the cloud metadata address lives there).
 */
export function isPrometheusOrigin(value: string, allowRemote: boolean): boolean {
  if (!isOrigin(value)) return false;
  const { hostname } = new URL(value);
  if (isLinkLocalHost(hostname)) return false;
  return allowRemote || LOOPBACK_HOSTS.includes(hostname);
}

/** A listen address: an IPv4/IPv6 literal or a DNS hostname, no scheme, port or path. */
export function isListenHost(value: string): boolean {
  if (isIP(value) !== 0) return true;
  return /^(?=.{1,253}$)([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/.test(value);
}

export function parseConfig(env: Readonly<Record<string, string | undefined>>): Config {
  const bad: ConfigVar[] = [];
  const read = (name: ConfigVar): string | undefined => {
    const v = env[name];
    return v === undefined || v.trim() === '' ? undefined : v;
  };

  const databaseUrl = read('DATABASE_URL');
  if (databaseUrl === undefined || !isDatabaseUrl(databaseUrl)) bad.push('DATABASE_URL');

  const portRaw = read('PORT');
  const port = portRaw === undefined ? null : parseInteger(portRaw, 1, 65535);
  if (port === null) bad.push('PORT');

  const webOrigin = read('WEB_ORIGIN');
  if (webOrigin === undefined || !isOrigin(webOrigin)) bad.push('WEB_ORIGIN');

  const hostRaw = read('HOST');
  if (hostRaw !== undefined && !isListenHost(hostRaw)) bad.push('HOST');
  const host = hostRaw !== undefined && isListenHost(hostRaw) ? hostRaw : DEFAULTS.host;

  const optionalInt = (name: ConfigVar, fallback: number, min: number, max: number): number => {
    const raw = read(name);
    if (raw === undefined) return fallback;
    const n = parseInteger(raw, min, max);
    if (n === null) {
      bad.push(name);
      return fallback;
    }
    return n;
  };
  const sseMaxClients = optionalInt('SSE_MAX_CLIENTS', DEFAULTS.sseMaxClients, 1, 999_999_999);
  const sseMaxClientsPerIp = optionalInt('SSE_MAX_CLIENTS_PER_IP', DEFAULTS.sseMaxClientsPerIp, 1, 999_999_999);
  const rateLimitMax = optionalInt('RATE_LIMIT_MAX', DEFAULTS.rateLimitMax, 1, 999_999_999);
  const trustProxyHops = optionalInt('TRUST_PROXY_HOPS', DEFAULTS.trustProxyHops, 0, MAX_TRUST_PROXY_HOPS);

  const allowRaw = read('PROMETHEUS_ALLOW_REMOTE');
  const allowValid = allowRaw === undefined || allowRaw === 'true' || allowRaw === 'false';
  const prometheusAllowRemote = allowRaw === 'true';
  const prometheusRaw = read('PROMETHEUS_URL');
  const prometheusOk = prometheusRaw === undefined || isPrometheusOrigin(prometheusRaw, prometheusAllowRemote);
  // Pushed in the order of OPTIONAL_VARS, so the error lists names in a stable order.
  if (!prometheusOk) bad.push('PROMETHEUS_URL');
  if (!allowValid) bad.push('PROMETHEUS_ALLOW_REMOTE');
  const prometheusUrl = prometheusRaw !== undefined && prometheusOk ? prometheusRaw : DEFAULTS.prometheusUrl;
  const pollIntervalMs = optionalInt('POLL_INTERVAL_MS', DEFAULTS.pollIntervalMs, 1000, 60_000);
  const timeoutRaw = read('POLL_TIMEOUT_MS');
  let pollTimeoutMs: number = Math.min(DEFAULTS.pollTimeoutMs, pollIntervalMs);
  if (timeoutRaw !== undefined) {
    const n = parseInteger(timeoutRaw, 100, 30_000);
    if (n === null || n > pollIntervalMs) bad.push('POLL_TIMEOUT_MS');
    else pollTimeoutMs = n;
  }
  const signalRetentionH = optionalInt('SIGNAL_RETENTION_H', DEFAULTS.signalRetentionH, 1, 720);
  if (bad.length > 0) throw new ConfigError(bad);

  return Object.freeze({
    databaseUrl: databaseUrl as string,
    port: port as number,
    webOrigin: webOrigin as string,
    host,
    sseMaxClients,
    sseMaxClientsPerIp,
    rateLimitMax,
    trustProxyHops,
    prometheusUrl,
    prometheusAllowRemote,
    pollIntervalMs,
    pollTimeoutMs,
    signalRetentionH,
  });
}
