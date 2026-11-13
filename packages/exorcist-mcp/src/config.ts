import { isAbsolute } from 'node:path';

/** Settings of one Exorcist MCP server process (one Hunt). */
export interface McpConfig {
  labUrl: string;
  labToken: string;
  promUrl: string;
  huntId: string;
  ledgerPath: string;
}

export type ConfigResult = { ok: true; config: McpConfig } | { ok: false; names: string[] };

export const DEFAULT_LAB_URL = 'http://127.0.0.1:4100';
export const DEFAULT_PROMETHEUS_URL = 'http://127.0.0.1:9090';
const HUNT_ID_PATTERN = /^[a-z0-9]{20,32}$/;
const MIN_TOKEN_LENGTH = 16;

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** True for 169.254.0.0/16 and fe80::/10 (bracketed as `new URL` writes them). */
export function isLinkLocal(hostname: string): boolean {
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
  return /^\[fe[89ab][0-9a-f]:/i.test(hostname);
}

/**
 * An `http(s)` origin with nothing after it (a trailing `/` is allowed), no user info, no query.
 * The host must be loopback unless `allowRemote`; a link-local host is always refused.
 */
export function isAllowedOrigin(value: string, allowRemote: boolean): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return false;
  if (url.pathname !== '/' && url.pathname !== '') return false;
  if (isLinkLocal(url.hostname)) return false;
  return allowRemote || LOOPBACK.has(url.hostname);
}

const flag = (raw: string | undefined): boolean | null => {
  if (raw === undefined || raw === '') return false;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return null;
};

const origin = (value: string): string => new URL(value).origin;

/** Reads the environment. Errors name the variables, never their values. */
export function parseMcpConfig(env: Readonly<Record<string, string | undefined>>): ConfigResult {
  const bad: string[] = [];
  const read = (name: string): string | undefined => {
    const v = env[name]?.trim();
    return v === '' ? undefined : v;
  };

  const labRemote = flag(read('LAB_ALLOW_REMOTE'));
  if (labRemote === null) bad.push('LAB_ALLOW_REMOTE');
  const promRemote = flag(read('PROMETHEUS_ALLOW_REMOTE'));
  if (promRemote === null) bad.push('PROMETHEUS_ALLOW_REMOTE');

  const labUrl = read('LAB_URL') ?? DEFAULT_LAB_URL;
  if (!isAllowedOrigin(labUrl, labRemote === true)) bad.push('LAB_URL');
  const promUrl = read('PROMETHEUS_URL') ?? DEFAULT_PROMETHEUS_URL;
  if (!isAllowedOrigin(promUrl, promRemote === true)) bad.push('PROMETHEUS_URL');

  const labToken = read('LAB_READ_TOKEN');
  if (labToken === undefined || labToken.length < MIN_TOKEN_LENGTH || /\s/.test(labToken)) bad.push('LAB_READ_TOKEN');

  const huntId = read('HUNT_ID');
  if (huntId === undefined || !HUNT_ID_PATTERN.test(huntId)) bad.push('HUNT_ID');

  const ledgerPath = read('HUNT_LEDGER_PATH');
  const ledgerOk =
    ledgerPath !== undefined &&
    huntId !== undefined &&
    isAbsolute(ledgerPath) &&
    ledgerPath.endsWith(`/ledgers/${huntId}.jsonl`) &&
    !ledgerPath.split('/').includes('..');
  if (!ledgerOk) bad.push('HUNT_LEDGER_PATH');

  if (bad.length > 0) return { ok: false, names: bad };
  return {
    ok: true,
    config: {
      labUrl: origin(labUrl),
      labToken: labToken as string,
      promUrl: origin(promUrl),
      huntId: huntId as string,
      ledgerPath: ledgerPath as string,
    },
  };
}

/** The message printed on a bad environment: variable names only. */
export function formatConfigError(names: readonly string[]): string {
  return `invalid env: ${names.join(', ')}`;
}
