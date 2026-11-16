#!/usr/bin/env node
// Env guard of the demo server: refuses an environment file that breaks a rule of the deployment.
//   node scripts/demo-env-check.mjs <file> [api|lab|kiro]   (default profile: api)
// Exit 0: accepted. Exit 1: refused. Exit 2: usage error or unreadable file. The `kiro` file is optional: a missing one is accepted.
// On success it also prints `env ok: <profile>` on stderr: the pre-flight requires that line, so a guard that did not run is not a pass.
// It prints variable names (and the number of a line it cannot read), never a value.
import { readFileSync } from 'node:fs';
import { isMain } from './is-main.mjs';

/** The caps decided for the demo server. */
export const DECIDED_CAPS = Object.freeze({ HUNT_DAILY_MAX: 3, HUNT_CREDIT_CAP: 1.5, HUNT_DAILY_CREDIT_CAP: 4.5 });
export const MIN_TOKEN_LENGTH = 24;
export const PROFILES = Object.freeze(['api', 'lab', 'kiro']);

const LOOPBACK_HOSTS = ['127.0.0.1', '[::1]', '::1', 'localhost'];
const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Parses text the way a systemd EnvironmentFile reads it: KEY=VALUE lines, `#` and `;` comments,
 * optional matching quotes, the last duplicate wins. Unreadable lines are returned by number.
 * @param {string} text
 * @returns {{ vars: Record<string, string>; badLines: number[] }}
 */
export function parseEnvText(text) {
  /** @type {Record<string, string>} */
  const vars = Object.create(null);
  /** @type {number[]} */
  const badLines = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) return;
    const eq = line.indexOf('=');
    const key = eq > 0 ? line.slice(0, eq).trim() : '';
    if (!KEY.test(key)) {
      badLines.push(i + 1);
      return;
    }
    let value = line.slice(eq + 1).trim();
    const q = value[0];
    if ((q === '"' || q === "'") && value.length >= 2 && value.endsWith(q)) value = value.slice(1, -1);
    vars[key] = value;
  });
  return { vars, badLines };
}

/** @param {Record<string, string>} vars @param {string} name */
const has = (vars, name) => Object.prototype.hasOwnProperty.call(vars, name);

/** @param {string | undefined} v @param {number} min @param {number} max */
function intIn(v, min, max) {
  if (v === undefined || !/^\d{1,9}$/.test(v)) return false;
  const n = Number(v);
  return n >= min && n <= max;
}

/** A positive decimal number no larger than `max`. @param {string | undefined} v @param {number} max */
function decimalAtMost(v, max) {
  if (v === undefined || !/^\d{1,4}(\.\d{1,3})?$/.test(v)) return false;
  const n = Number(v);
  return n > 0 && n <= max;
}

/** @param {string | undefined} v */
function isLoopbackHost(v) {
  return v !== undefined && LOOPBACK_HOSTS.includes(v.toLowerCase());
}

/** An origin (scheme, host, optional port, nothing else) whose host is loopback. @param {string} v */
function isLoopbackOrigin(v) {
  if (!URL.canParse(v)) return false;
  const u = new URL(v);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (u.origin !== v) return false;
  return LOOPBACK_HOSTS.includes(u.hostname.toLowerCase());
}

/** @param {string | undefined} v */
function isHttpsOrigin(v) {
  if (v === undefined || !URL.canParse(v)) return false;
  const u = new URL(v);
  return u.protocol === 'https:' && u.origin === v && u.hostname.length > 0;
}

/** @param {string | undefined} v */
function isDatabaseUrl(v) {
  if (v === undefined || !URL.canParse(v)) return false;
  const u = new URL(v);
  return (u.protocol === 'postgres:' || u.protocol === 'postgresql:') && u.hostname.length > 0;
}

/** @param {string | undefined} v */
function isAbsolutePath(v) {
  return v !== undefined && v.startsWith('/') && !v.includes('\0') && v.length <= 500;
}

/**
 * The Kiro API key: printable ASCII with no space, 20 to 512 characters (the rule of the API at start), and no `\`, `"` or `'`
 * (systemd reads them in an environment file as escapes and quotes). @param {string | undefined} v
 */
export function isKiroApiKey(v) {
  return v !== undefined && /^[\x21\x23-\x26\x28-\x5b\x5d-\x7e]{20,512}$/.test(v);
}
/** @param {string | undefined} v */
function isStrongToken(v) {
  return v !== undefined && v.length >= MIN_TOKEN_LENGTH && !v.includes('CHANGE_ME');
}

/**
 * Returns the names of the variables that break a rule, in a fixed order. No values.
 * @param {Record<string, string>} vars
 * @param {'api' | 'lab' | 'kiro'} [profile]
 * @returns {string[]}
 */
export function checkEnv(vars, profile = 'api') {
  /** @type {string[]} */
  const bad = [];
  const v = (/** @type {string} */ name) => (has(vars, name) ? vars[name] : undefined);
  const rule = (/** @type {string} */ name, /** @type {boolean} */ ok) => {
    if (!ok) bad.push(name);
  };
  if (profile === 'kiro') {
    // `/etc/haunted/kiro.env`: one variable, KIRO_API_KEY. Any other name is refused (by name, never its value).
    // That includes HAUNTED_NODE: the node binary of the guard is the option `--node` of env-guard.sh, never a variable of a file.
    rule('KIRO_API_KEY', isKiroApiKey(v('KIRO_API_KEY')));
    for (const name of Object.keys(vars)) if (name !== 'KIRO_API_KEY') bad.push(name);
    return bad;
  }
  if (profile === 'lab') {
    rule('HAUNTED_NODE', !has(vars, 'HAUNTED_NODE'));
    rule('NODE_ENV', v('NODE_ENV') === 'production');
    rule('FIX_RUN_AS_USER', !has(vars, 'FIX_RUN_AS_USER'));
    rule('GITHUB_TOKEN', !has(vars, 'GITHUB_TOKEN'));
    rule('SERVICE_BIND_HOST', !has(vars, 'SERVICE_BIND_HOST') || isLoopbackHost(v('SERVICE_BIND_HOST')));
    rule('CHAOS_TOKEN', isStrongToken(v('CHAOS_TOKEN')));
    rule('LAB_READ_TOKEN', isStrongToken(v('LAB_READ_TOKEN')) && v('LAB_READ_TOKEN') !== v('CHAOS_TOKEN'));
    rule('TRAFFIC_RPS', !has(vars, 'TRAFFIC_RPS') || intIn(v('TRAFFIC_RPS'), 0, 50));
    return bad;
  }
  rule('HAUNTED_NODE', !has(vars, 'HAUNTED_NODE'));
  rule('NODE_ENV', v('NODE_ENV') === 'production');
  rule('DATABASE_URL', isDatabaseUrl(v('DATABASE_URL')));
  rule('PORT', intIn(v('PORT'), 1, 65535));
  rule('HOST', !has(vars, 'HOST') || isLoopbackHost(v('HOST')));
  rule('WEB_ORIGIN', isHttpsOrigin(v('WEB_ORIGIN')));
  rule('TRUST_PROXY_HOPS', v('TRUST_PROXY_HOPS') === '1');
  rule('FIX_ENABLED', v('FIX_ENABLED') === 'false');
  rule('GITHUB_TOKEN', !has(vars, 'GITHUB_TOKEN'));
  rule('HUNTS_ENABLED', v('HUNTS_ENABLED') === 'true' || v('HUNTS_ENABLED') === 'false');
  rule('LAB_URL', !has(vars, 'LAB_URL') || isLoopbackOrigin(v('LAB_URL') ?? ''));
  rule('PROMETHEUS_URL', !has(vars, 'PROMETHEUS_URL') || isLoopbackOrigin(v('PROMETHEUS_URL') ?? ''));
  rule('LAB_READ_TOKEN', isStrongToken(v('LAB_READ_TOKEN')));
  rule('HUNT_ADMIN_TOKEN', isStrongToken(v('HUNT_ADMIN_TOKEN')) && v('HUNT_ADMIN_TOKEN') !== v('LAB_READ_TOKEN'));
  rule('KIRO_CLI_PATH', isAbsolutePath(v('KIRO_CLI_PATH')));
  rule('HUNT_WORKDIR', isAbsolutePath(v('HUNT_WORKDIR')));
  rule('HUNT_DAILY_MAX', intIn(v('HUNT_DAILY_MAX'), 1, DECIDED_CAPS.HUNT_DAILY_MAX));
  rule('HUNT_CREDIT_CAP', decimalAtMost(v('HUNT_CREDIT_CAP'), DECIDED_CAPS.HUNT_CREDIT_CAP));
  rule('HUNT_DAILY_CREDIT_CAP', decimalAtMost(v('HUNT_DAILY_CREDIT_CAP'), DECIDED_CAPS.HUNT_DAILY_CREDIT_CAP));
  // The key belongs in /etc/haunted/kiro.env (the `kiro` profile), never in api.env.
  rule('KIRO_API_KEY', !has(vars, 'KIRO_API_KEY'));
  return bad;
}

/**
 * Checks the text of one file. Returns the refusal names; a line it cannot read counts as `line <n>`.
 * @param {string} text
 * @param {'api' | 'lab' | 'kiro'} [profile]
 */
export function checkEnvText(text, profile = 'api') {
  const { vars, badLines } = parseEnvText(text);
  return [...checkEnv(vars, profile), ...badLines.map((n) => `line ${n}`)];
}

/** The line the CLI prints for a result. @param {string[]} refused @param {string} profile */
export function formatResult(refused, profile) {
  return refused.length === 0 ? `demo-env-check: ok (${profile})` : `demo-env-check: refused: ${refused.join(', ')}`;
}

function main() {
  const [file, profile = 'api', ...rest] = process.argv.slice(2);
  if (!file || rest.length > 0 || !PROFILES.includes(profile)) {
    process.stderr.write('usage: demo-env-check.mjs <file> [api|lab|kiro]\n');
    process.exit(2);
  }
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    // The Kiro API key file is optional: without it the login of hops is used.
    if (profile === 'kiro' && /** @type {{ code?: string }} */ (err).code === 'ENOENT') {
      process.stdout.write('demo-env-check: ok (kiro, no file)\n');
      process.stderr.write('env ok: kiro\n');
      return;
    }
    process.stderr.write('demo-env-check: cannot read the file\n');
    process.exit(2);
  }
  const refused = checkEnvText(text, /** @type {'api' | 'lab' | 'kiro'} */ (profile));
  if (refused.length === 0) {
    process.stdout.write(`${formatResult(refused, profile)}\n`);
    // The line the pre-flight requires: a guard that never ran prints nothing, so exit status alone is not proof.
    process.stderr.write(`env ok: ${profile}\n`);
    return;
  }
  process.stderr.write(`${formatResult(refused, profile)}\n`);
  process.exit(1);
}

if (isMain(import.meta.url)) main();
