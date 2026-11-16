import {
  checkArrayOf,
  checkInteger,
  checkNullable,
  checkOneOf,
  isPlainObject,
  makeValidator,
  type Check,
} from './checks.js';
import { checkHuntDetail } from './hunts.js';
import { sha256Hex } from './sha256.js';
import { checkProposalView } from './proposals.js';
import { checkServiceState } from './validators.js';
import { SERVICE_NAMES, type ServiceState } from './types.js';
import type { HuntDetail } from './hunts.js';
import type { ProposalView } from './proposals.js';
/**
 * A replay: one recorded incident of the lab, sanitized and read by a person, that the Web plays back.
 * It is one JSON file under `fixtures/replays/<id>.json`, one row of the `Replay` table and one answer of
 * `GET /api/replays/:id`. Each frame REPLACES the part of the state it names; a part a frame leaves out stays.
 */
export const REPLAY_VERSION = 1;
export const REPLAY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,47}$/;
export const REPLAY_SCENARIOS = ['error-spike', 'fog', 'dark-room'] as const;
export type ReplayScenario = (typeof REPLAY_SCENARIOS)[number];
export const REPLAY_LIMITS = Object.freeze({
  title: 80,
  note: 200,
  frames: 400,
  durationMs: 900_000,
  /** The whole file as UTF-8 JSON. */
  bytes: 256 * 1024,
  /** No string of a replay is longer than this (the checks of each field are tighter). */
  string: 1000,
});
/** The one repository a replay may link to. */
export const REPLAY_LAB_REPO = 'Akar-Samudra-Artifisial/Haunted-Lab';
export const REPLAY_PR_URL_PATTERN = /^https:\/\/github\.com\/Akar-Samudra-Artifisial\/Haunted-Lab\/pull\/[1-9]\d{0,7}$/;
export const REPLAY_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const REPLAY_HASH_PATTERN = /^[0-9a-f]{64}$/;
export const REPLAY_INITIALS_PATTERN = /^[A-Za-z]{2,4}$/;
export interface ReplayReview {
  /** `YYYY-MM-DD`. */
  reviewedOn: string;
  /** The initials of the person who read the file. */
  by: string;
  note: string;
  /**
   * `replayReviewHash` of the file this review was written for: the review is bound to the content, so a file edited after
   * it was read no longer validates.
   */
  sha256: string;
}
export interface ReplayFrame {
  /** Milliseconds from the start of the recording. */
  t: number;
  services?: ServiceState[];
  hunt?: HuntDetail | null;
  proposal?: ProposalView | null;
}
export interface ReplayFile {
  version: 1;
  id: string;
  title: string;
  scenario: ReplayScenario;
  /** `YYYY-MM-DD`, no time. */
  recordedOn: string;
  durationMs: number;
  /** `null` until a person has read the file; only reviewed files are seeded or served. */
  review: ReplayReview | null;
  frames: ReplayFrame[];
}
/** What the list answer shows of one replay. */
export interface ReplayListItem {
  id: string;
  title: string;
  scenario: ReplayScenario;
  recordedOn: string;
  durationMs: number;
}
/** What the validator looks for in every string. `test` is true when the text holds the kind. */
export interface ReplayForbidden {
  name: string;
  test: (text: string) => boolean;
}
const byRegExp = (name: string, re: RegExp): ReplayForbidden => ({ name, test: (text) => re.test(text) });
/** The names of file endings that make `name.ext` a file name (`app.py`, `config.yaml`, `README.md`), not a host name. */
const FILE_ENDINGS = new Set(['py', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'json', 'yaml', 'yml', 'toml', 'md', 'txt', 'lock', 'log', 'cfg', 'ini', 'sh', 'sql', 'html', 'css', 'env', 'conf', 'csv', 'xml']);
/** `py`, `md` and `sh` are file endings and country codes: `app.py` is a file, `staging.example.sh` (two labels before it) is a host. */
const AMBIGUOUS_ENDINGS = new Set(['py', 'md', 'sh']);
/** Common host endings: a last label with one of these, in any case, is a host ending. */
const HOST_ENDINGS = new Set('com net org io dev app co ai id me info biz cloud xyz tech site online sg us uk de jp internal local lan corp home'.split(' '));
const NAME_RUN = /[A-Za-z0-9._-]+/g;
/** Without the `.`, `_` and `-` at both ends (a loop: a regular expression with `$` would be quadratic on a long run). */
function trimSeparators(token: string): string {
  let start = 0;
  let end = token.length;
  while (start < end && '._-'.includes(token.charAt(start))) start++;
  while (end > start && '._-'.includes(token.charAt(end - 1))) end--;
  return token.slice(start, end);
}
/**
 * A host name: a run of `label.label...` whose last label is 2 to 24 letters, in any case when it is a common host ending (`Example.Com`), else all lower or all upper case, and is not a
 * file ending (`py`, `md` and `sh` are a file only with one label before them: `app.py`, but `staging.example.sh` is a host), with a host label before it. Refused: `staging.example.com`, `db1.corp`, `ec2-1-2-3-4.compute-1.amazonaws.com`,
 * `github.com` (a link to the lab goes in a `prUrl`, where it is checked by its own pattern). Accepted (tested): service
 * and tool names (`payments`, `query_metrics`: no dot), lab file names (`payments/app.py`, `config.yaml`, `app.test.ts`),
 * version numbers and decimals (`1.2.3`, `0.35`, `3.12.1`: the last label has a digit), timestamps, a sentence that
 * lost its space (`Done.Next`: mixed case), `e.g.` (one letter). A code name such as `os.path` is refused too: the Builder
 * writes `[host]` in its place. One pass over the text, linear.
 */
export function hasHostName(text: string): boolean {
  for (const match of text.matchAll(NAME_RUN)) {
    const token = trimSeparators(match[0]);
    const last = token.lastIndexOf('.');
    if (last < 1) continue;
    const tld = token.slice(last + 1);
    if (tld.length < 2 || tld.length > 24 || !/^[A-Za-z]+$/.test(tld)) continue;
    const lower = tld.toLowerCase();
    const before = token.slice(0, last);
    if (!HOST_ENDINGS.has(lower)) {
      // Any other ending counts only in one case (a sentence that lost its space, `Done.Next`, has a mixed one).
      if (tld !== lower && tld !== tld.toUpperCase()) continue;
      if (FILE_ENDINGS.has(lower) && !(AMBIGUOUS_ENDINGS.has(lower) && before.includes('.'))) continue;
    }
    const domain = before.slice(before.lastIndexOf('.') + 1);
    if (domain !== '' && /^[A-Za-z0-9_-]+$/.test(domain)) return true;
  }
  return false;
}
const IPV4 = /(?<![A-Za-z0-9.])\d{1,3}(?:\.\d{1,3}){3}(?![0-9]|\.[0-9])/g;
/** An IPv4 address: four octets of 0 to 255, not part of a longer number and not after a letter, a digit or a dot (`v1.2.3.4`). 127.0.0.1 is allowed. */
export function hasIpv4(text: string): boolean {
  for (const match of text.matchAll(IPV4)) {
    const octets = match[0].split('.').map(Number);
    if (octets.every((n) => n <= 255) && match[0] !== '127.0.0.1') return true;
  }
  return false;
}
const HEX_COLON_RUN = /[0-9A-Fa-f:]{2,}/g;
const IPV6_GROUP = /^[0-9A-Fa-f]{1,4}$/;
/** An IPv6 address, full (8 groups) or compressed with one `::` (`::1`, `fe80::1`). `12:30:45`, `std::vector` and `::` alone are not. */
export function hasIpv6(text: string): boolean {
  for (const match of text.matchAll(HEX_COLON_RUN)) {
    let run = match[0];
    let index = match.index ?? 0;
    // One `:` that starts the run (`addr:fe80::1`) is a separator, not part of a word: drop it and skip the left check.
    const separated = run.startsWith(':') && !run.startsWith('::');
    if (separated) {
      run = run.slice(1);
      index++;
    }
    // A run inside a word (`std::vector`, `ab::cd` after a letter) is code, not an address.
    if ((!separated && /[A-Za-z0-9_]/.test(text.charAt(index - 1))) || /[A-Za-z0-9_]/.test(text.charAt(index + run.length))) continue;
    if (run.length < 2) continue;
    const gap = run.indexOf('::');
    if (gap === -1) {
      const groups = run.split(':');
      if (groups.length === 8 && groups.every((g) => IPV6_GROUP.test(g))) return true;
      continue;
    }
    if (run.indexOf('::', gap + 1) !== -1 || run.includes(':::')) continue;
    const head = run.slice(0, gap);
    const tail = run.slice(gap + 2);
    const groups = [...(head === '' ? [] : head.split(':')), ...(tail === '' ? [] : tail.split(':'))];
    if (groups.length >= 1 && groups.length <= 7 && groups.every((g) => IPV6_GROUP.test(g))) return true;
  }
  return false;
}
const EMAIL_LOCAL = /[A-Za-z0-9._%+-]/;
const EMAIL_DOMAIN = /[A-Za-z0-9.-]/;
/** `local@domain.tld` with a domain of letters, digits, dots and hyphens that has a dot and 2 letters after it. Linear: each `@` reads its own neighbours. */
export function hasEmail(text: string): boolean {
  for (let at = text.indexOf('@'); at !== -1; at = text.indexOf('@', at + 1)) {
    if (at === 0 || !EMAIL_LOCAL.test(text.charAt(at - 1))) continue;
    let end = at + 1;
    while (end < text.length && EMAIL_DOMAIN.test(text.charAt(end))) end++;
    const domain = text.slice(at + 1, end);
    for (let dot = domain.indexOf('.', 1); dot !== -1; dot = domain.indexOf('.', dot + 1)) {
      if (dot + 3 <= domain.length && /^[A-Za-z]{2}$/.test(domain.slice(dot + 1, dot + 3))) return true;
    }
  }
  return false;
}
/**
 * Text that must never be in a replay: the kinds the sanitizer of `tools/sanitize-replay` removes, and more. The validator
 * checks them again so that a file edited by hand cannot carry one. A 40-hex commit SHA of the public lab is allowed.
 * Every test reads the text once or a few times (linear), so a 64 KiB text of any shape is checked in a few milliseconds.
 */
export const REPLAY_FORBIDDEN: ReadonlyArray<ReplayForbidden> = [
  byRegExp('bearer value', /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/),
  { name: 'email address', test: hasEmail },
  byRegExp('home path', /(?:\/Users|\/home)\/[^\s"'\\/]+/),
  byRegExp('root path', /(?<![\w.-])\/root\//),
  byRegExp('temp path', /\/(?:private\/)?(?:var\/folders|tmp)\//),
  byRegExp('windows path', /[A-Za-z]:\\Users\\/),
  byRegExp('github token', /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}\b/),
  byRegExp('aws key id', /\b(?:AKIA|ASIA)[0-9A-Z]{12,}\b/),
  byRegExp('api key', /\b(?:sk|pk|key|tok)-[A-Za-z0-9_-]{16,}\b/),
  byRegExp('private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/),
  byRegExp('uuid', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i),
  byRegExp('account id', /\b\d{12}\b/),
  { name: 'ip address', test: hasIpv4 },
  { name: 'ipv6 address', test: hasIpv6 },
  { name: 'hostname', test: hasHostName },
  byRegExp('url', /https?:\/\//i),
  byRegExp('html tag', /<[A-Za-z/!]/),
  byRegExp('bidi or zero-width character', /[\u061C\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}]/u),
  // eslint-disable-next-line no-control-regex
  byRegExp('control character', /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/),
];
const LONG_RUN = /[A-Za-z0-9_-]{32,}/g;
const FULL_SHA = /^[0-9a-f]{40}$/;
/** The name of the first forbidden kind in `text`, or `null`. `\n` is the only control character allowed. */
export function replayForbiddenKind(text: string): string | null {
  if (text.length > REPLAY_LIMITS.string) return 'long string';
  for (const { name, test } of REPLAY_FORBIDDEN) if (test(text)) return name;
  for (const run of text.match(LONG_RUN) ?? []) if (!FULL_SHA.test(run)) return 'token shape';
  return null;
}
/** The length of `text` as UTF-8, without `TextEncoder` (this package has no DOM or Node types). */
function utf8Length(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}
const isString = (v: unknown): v is string => typeof v === 'string';
const checkDate: Check = (input, path, errors) => {
  if (!isString(input) || !REPLAY_DATE_PATTERN.test(input)) {
    errors.push(path);
    return;
  }
  const d = new Date(`${input}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== input) errors.push(path);
};
const checkText =
  (max: number, min = 0): Check =>
  (input, path, errors) => {
    if (!isString(input) || input.length < min || input.length > max) errors.push(path);
  };
const checkOneLine: Check = (input, path, errors) => {
  if (isString(input) && /[\n\r]/.test(input)) errors.push(path);
};
const checkReview: Check = (input, path, errors) => {
  if (!isPlainObject(input)) {
    errors.push(path);
    return;
  }
  checkDate(input.reviewedOn, `${path}.reviewedOn`, errors);
  if (!isString(input.by) || !REPLAY_INITIALS_PATTERN.test(input.by)) errors.push(`${path}.by`);
  checkText(REPLAY_LIMITS.note)(input.note, `${path}.note`, errors);
  if (!isString(input.sha256) || !REPLAY_HASH_PATTERN.test(input.sha256)) errors.push(`${path}.sha256`);
  for (const key of Object.keys(input)) if (!['reviewedOn', 'by', 'note', 'sha256'].includes(key)) errors.push(`${path}.${key}`);
};
const checkServices: Check = (input, path, errors) => {
  if (!Array.isArray(input) || input.length !== SERVICE_NAMES.length) {
    errors.push(path);
    return;
  }
  checkArrayOf(checkServiceState)(input, path, errors);
  input.forEach((s: unknown, i) => {
    if (!isPlainObject(s) || s.name !== SERVICE_NAMES[i]) errors.push(`${path}[${i}].name`);
  });
};
/** Every `prUrl` of a frame is the pull request URL of the one lab repository. */
function checkPrUrls(frame: Record<string, unknown>, path: string, errors: string[]): void {
  const check = (holder: unknown, at: string): void => {
    if (!isPlainObject(holder) || holder.prUrl === null || holder.prUrl === undefined) return;
    if (!isString(holder.prUrl) || !REPLAY_PR_URL_PATTERN.test(holder.prUrl)) errors.push(`${at}.prUrl`);
  };
  if (Array.isArray(frame.services)) frame.services.forEach((s: unknown, i) => check(isPlainObject(s) ? s.proposal : null, `${path}.services[${i}].proposal`));
  if (isPlainObject(frame.hunt)) check(frame.hunt.proposal, `${path}.hunt.proposal`);
  check(frame.proposal, `${path}.proposal`);
}
const FRAME_KEYS = ['t', 'services', 'hunt', 'proposal'];
function checkFrames(input: unknown, path: string, errors: string[], durationMs: unknown): void {
  if (!Array.isArray(input) || input.length < 1 || input.length > REPLAY_LIMITS.frames) {
    errors.push(path);
    if (!Array.isArray(input)) return;
  }
  let last = 0;
  (input as unknown[]).forEach((frame, i) => {
    const at = `${path}[${i}]`;
    if (!isPlainObject(frame)) {
      errors.push(at);
      return;
    }
    for (const key of Object.keys(frame)) if (!FRAME_KEYS.includes(key)) errors.push(`${at}.${key}`);
    const t = frame.t;
    if (typeof t !== 'number' || !Number.isInteger(t) || t < 0) errors.push(`${at}.t`);
    else {
      if (i === 0 ? t !== 0 : t < last) errors.push(`${at}.t`);
      if (typeof durationMs === 'number' && t > durationMs) errors.push(`${at}.t`);
      last = t;
    }
    if (i === 0 && !Object.hasOwn(frame, 'services')) errors.push(`${at}.services`);
    if (Object.hasOwn(frame, 'services')) checkServices(frame.services, `${at}.services`, errors);
    if (Object.hasOwn(frame, 'hunt')) checkNullable(checkHuntDetail)(frame.hunt, `${at}.hunt`, errors);
    if (Object.hasOwn(frame, 'proposal')) checkNullable(checkProposalView)(frame.proposal, `${at}.proposal`, errors);
    checkPrUrls(frame, at, errors);
  });
}
/**
 * Every string of the file passes `replayForbiddenKind`; the paths of the failing strings are listed, never the text.
 * Two kinds of string are not read as text: the hash of the review (64 hex characters) and a `prUrl` that is the pull
 * request URL of the lab (checked by its own pattern, the one place a link may be).
 */
function checkStrings(value: unknown, path: string, errors: string[], depth = 0): void {
  if (depth > 12) {
    errors.push(path);
    return;
  }
  if (isString(value)) {
    if (path === '$.review.sha256' || (path.endsWith('.prUrl') && REPLAY_PR_URL_PATTERN.test(value))) return;
    if (replayForbiddenKind(value) !== null) errors.push(path);
  } else if (Array.isArray(value)) value.forEach((v, i) => checkStrings(v, `${path}[${i}]`, errors, depth + 1));
  else if (isPlainObject(value)) for (const [k, v] of Object.entries(value)) checkStrings(v, `${path}.${k}`, errors, depth + 1);
}
/** JSON with the keys of every object in sorted order and no spaces: the same text for the same data, in any key order (PostgreSQL `jsonb` does not keep the order). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`;
  if (isPlainObject(value)) {
    const parts: string[] = [];
    for (const key of Object.keys(value).sort()) if (value[key] !== undefined) parts.push(`${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
/** SHA-256 of the canonical JSON of a replay: the `sha256` of its row. */
export function replayHash(file: unknown): string {
  return sha256Hex(canonicalJson(file));
}
/** The hash a review binds to: `replayHash` of the file with `review` set to `null`. */
export function replayReviewHash(file: object): string {
  return replayHash({ ...file, review: null });
}
const TOP_KEYS = ['version', 'id', 'title', 'scenario', 'recordedOn', 'durationMs', 'review', 'frames'];
const checkReplayFile: Check = (input, path, errors) => {
  if (!isPlainObject(input)) {
    errors.push(path);
    return;
  }
  for (const key of Object.keys(input)) if (!TOP_KEYS.includes(key)) errors.push(`${path}.${key}`);
  for (const key of TOP_KEYS) if (!Object.hasOwn(input, key)) errors.push(`${path}.${key}`);
  if (input.version !== REPLAY_VERSION) errors.push(`${path}.version`);
  if (!isString(input.id) || !REPLAY_ID_PATTERN.test(input.id)) errors.push(`${path}.id`);
  checkText(REPLAY_LIMITS.title, 1)(input.title, `${path}.title`, errors);
  checkOneLine(input.title, `${path}.title`, errors);
  checkOneOf(REPLAY_SCENARIOS)(input.scenario, `${path}.scenario`, errors);
  checkDate(input.recordedOn, `${path}.recordedOn`, errors);
  checkInteger(input.durationMs, `${path}.durationMs`, errors);
  if (typeof input.durationMs === 'number' && (input.durationMs < 1 || input.durationMs > REPLAY_LIMITS.durationMs)) errors.push(`${path}.durationMs`);
  checkNullable(checkReview)(input.review, `${path}.review`, errors);
  checkFrames(input.frames, `${path}.frames`, errors, input.durationMs);
  const before = errors.length;
  // The id has its own pattern (it may be a long run of letters and digits).
  for (const [key, value] of Object.entries(input)) if (key !== 'id') checkStrings(value, `${path}.${key}`, errors);
  if (before === errors.length && utf8Length(JSON.stringify(input)) > REPLAY_LIMITS.bytes) errors.push(path);
  // The review is bound to the content: checked last, and only for a file that is otherwise valid (the hash reads all of it).
  if (errors.length === 0 && isPlainObject(input.review) && input.review.sha256 !== replayReviewHash(input)) errors.push(`${path}.review.sha256`);
};
export const validateReplayFile = makeValidator<ReplayFile>(checkReplayFile);
const checkListItem: Check = (input, path, errors) => {
  if (!isPlainObject(input)) {
    errors.push(path);
    return;
  }
  for (const key of Object.keys(input)) if (!['id', 'title', 'scenario', 'recordedOn', 'durationMs'].includes(key)) errors.push(`${path}.${key}`);
  if (!isString(input.id) || !REPLAY_ID_PATTERN.test(input.id)) errors.push(`${path}.id`);
  checkText(REPLAY_LIMITS.title, 1)(input.title, `${path}.title`, errors);
  checkOneLine(input.title, `${path}.title`, errors);
  checkOneOf(REPLAY_SCENARIOS)(input.scenario, `${path}.scenario`, errors);
  checkDate(input.recordedOn, `${path}.recordedOn`, errors);
  checkInteger(input.durationMs, `${path}.durationMs`, errors);
  if (typeof input.durationMs === 'number' && (input.durationMs < 1 || input.durationMs > REPLAY_LIMITS.durationMs)) errors.push(`${path}.durationMs`);
};
/** `GET /api/replays`: a list of at most 100 items. */
export const validateReplayList = makeValidator<ReplayListItem[]>((input, path, errors) => {
  if (!Array.isArray(input) || input.length > 100) {
    errors.push(path);
    return;
  }
  checkArrayOf(checkListItem)(input, path, errors);
});
/** The list item of a (valid) file. */
export function replayListItem(file: ReplayFile): ReplayListItem {
  return { id: file.id, title: file.title, scenario: file.scenario, recordedOn: file.recordedOn, durationMs: file.durationMs };
}
/** The state a replay shows at a point in time: the fold of the frames up to it. */
export interface ReplayState {
  services: ServiceState[];
  hunt: HuntDetail | null;
  proposal: ProposalView | null;
}
/** Applies one frame: each part it names replaces that part of `state`. */
export function applyReplayFrame(state: ReplayState, frame: ReplayFrame): ReplayState {
  return {
    services: frame.services ?? state.services,
    hunt: frame.hunt === undefined ? state.hunt : frame.hunt,
    proposal: frame.proposal === undefined ? state.proposal : frame.proposal,
  };
}
