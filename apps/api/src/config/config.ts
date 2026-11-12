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
}

export const REQUIRED_VARS = ['DATABASE_URL', 'PORT', 'WEB_ORIGIN'] as const;
export const OPTIONAL_VARS = [
  'HOST',
  'SSE_MAX_CLIENTS',
  'SSE_MAX_CLIENTS_PER_IP',
  'RATE_LIMIT_MAX',
  'TRUST_PROXY_HOPS',
] as const;
export type ConfigVar = (typeof REQUIRED_VARS)[number] | (typeof OPTIONAL_VARS)[number];

export const DEFAULTS = {
  host: '127.0.0.1',
  sseMaxClients: 100,
  sseMaxClientsPerIp: 5,
  rateLimitMax: 30,
  trustProxyHops: 0,
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
  });
}
