/**
 * Is the fixer's agent copy still the committed agent, after `kiro-cli` used it? (fix-proposal-flow task 16)
 *
 * kiro-cli 3.3.0 migrates an agent file in place on first use: `tools` (and sometimes `allowedTools`) `fs_read` and
 * `fs_write` become `read` and `write`, `permissions.rules` is added (the `toolsSettings` path patterns as `allow`
 * rules, plus `fs_read`, `fs_write` and `skill` `allow` rules with no `match`), and `kiroUpgrade` is added. A byte
 * comparison called every real run `agent_changed`. This check accepts exactly that migration and nothing more. It is
 * not the fence: the stream guard (reads in the folder, writes under `services/<S>/src/`) and the work folder (outside
 * every repository, one service and a read-only `packages/lab-common/`) are, and the patch is read against the export.
 */

export type AgentCheck = { ok: true } | { ok: false; key: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The old and the migrated spelling of each file tool. */
const TOOL_ALIASES: ReadonlyMap<string, string> = new Map([
  ['fs_read', 'fs_read'],
  ['read', 'fs_read'],
  ['fs_write', 'fs_write'],
  ['write', 'fs_write'],
]);
/** Keys handled on their own; every other key of the source must be equal in the copy. */
const TOOL_KEYS = new Set(['tools', 'allowedTools']);
/** Keys the migration may add. */
const ADDED_KEYS = new Set(['permissions', 'kiroUpgrade']);
/** Capabilities an added rule may name (always `allow`). */
const RULE_CAPABILITIES = new Set(['fs_read', 'fs_write', 'skill']);

/** Deep equality of JSON values; key order does not matter, array order does. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => jsonEqual(v, b[i]));
  }
  if (isRecord(a) && isRecord(b)) {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    return ka.length === kb.length && ka.every((k, i) => k === kb[i] && jsonEqual(a[k], b[k]));
  }
  return false;
}

/** The tools a list names, in the old spelling, or null when one is not a file tool (`*`, `@mcp`, `execute_bash`, ...). */
function canonicalTools(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const t of v) {
    const c = typeof t === 'string' ? TOOL_ALIASES.get(t) : undefined;
    if (c === undefined) return null;
    out.push(c);
  }
  return [...new Set(out)].sort();
}

/** Why `permissions` is not the migration's (a key name, never a value), or null. */
function permissionsProblem(p: unknown): string | null {
  if (!isRecord(p)) return 'permissions';
  for (const k of Object.keys(p)) if (k !== 'rules') return `permissions.${k.slice(0, 40)}`;
  if (p.rules === undefined) return null;
  if (!Array.isArray(p.rules) || p.rules.length > 20) return 'permissions.rules';
  for (const [i, r] of p.rules.entries()) {
    const at = `permissions.rules[${i}]`;
    if (!isRecord(r)) return at;
    for (const k of Object.keys(r)) if (k !== 'capability' && k !== 'match' && k !== 'effect') return `${at}.${k.slice(0, 40)}`;
    if (typeof r.capability !== 'string' || !RULE_CAPABILITIES.has(r.capability)) return `${at}.capability`;
    if (r.effect !== 'allow') return `${at}.effect`;
    if (r.match !== undefined && (!Array.isArray(r.match) || !r.match.every((m) => typeof m === 'string'))) return `${at}.match`;
  }
  return null;
}

/**
 * Compares the committed agent (`source`) with the copy after a run. Accepted: the copy equals the source except that
 * `tools` and `allowedTools` may use the migrated tool names, and `permissions` (allow rules for `fs_read`,
 * `fs_write`, `skill` only) and `kiroUpgrade` may be added. Anything else, including a file that does not parse, is a
 * change; the result names the first differing key, never a value.
 */
export function agentUnchanged(source: string, copy: string): AgentCheck {
  let s: unknown;
  let c: unknown;
  try {
    s = JSON.parse(source);
  } catch {
    return { ok: false, key: '(source)' };
  }
  try {
    c = JSON.parse(copy);
  } catch {
    return { ok: false, key: '(unparsable)' };
  }
  if (!isRecord(s)) return { ok: false, key: '(source)' };
  if (!isRecord(c)) return { ok: false, key: '(not an object)' };
  for (const key of Object.keys(s).sort()) {
    if (TOOL_KEYS.has(key)) continue;
    if (!jsonEqual(s[key], c[key])) return { ok: false, key };
  }
  for (const key of [...TOOL_KEYS].sort()) {
    const want = s[key] === undefined ? null : canonicalTools(s[key]);
    const got = c[key] === undefined ? null : canonicalTools(c[key]);
    if (want === null ? c[key] !== undefined : got === null || !jsonEqual(want, got)) return { ok: false, key };
  }
  for (const key of Object.keys(c).sort()) {
    if (Object.hasOwn(s, key)) continue;
    if (!ADDED_KEYS.has(key)) return { ok: false, key: key.slice(0, 40) };
    if (key === 'permissions') {
      const problem = permissionsProblem(c.permissions);
      if (problem !== null) return { ok: false, key: problem };
    } else if (!isRecord(c.kiroUpgrade)) {
      return { ok: false, key: 'kiroUpgrade' };
    }
  }
  // A source that already has `permissions` (a pre-migrated file) must keep it, which the equality loop checked.
  return { ok: true };
}
