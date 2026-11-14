import {
  CUID_PATTERN,
  DEPLOY_ID_PATTERN,
  FULL_SHA_PATTERN,
  PROPOSAL_CHECK_NAMES,
  PROPOSAL_KINDS,
  SERVICE_NAMES,
  type ProposalCheck,
  type ProposalKind,
  type ServiceName,
} from '@haunted-ops/shared';
import { sanitizeModelText } from '../hunts/model-text.js';

export const PR_TITLE_MAX = 72;
export const PR_BODY_MAX = 6000;
export const PR_SUMMARY_MAX = 400;
export const PR_EVIDENCE_MAX = 8;
export const PR_EVIDENCE_DETAIL_MAX = 160;
export const PR_REF_MAX = 80;
/** The zero-width space that goes after `@` and `#` so that they name nobody and nothing. */
export const ZWSP = '\u200b';
export const PR_NOTICE = 'AI generated, review before merging. Nothing is merged or deployed until a person merges this pull request.';

/**
 * Model or lab text for a title or a body. `sanitizeModelText` has removed control, direction and zero-width
 * characters, URLs, markdown links, images and HTML tags, and has collapsed whitespace. This also breaks any
 * markdown link or image syntax that is left, drops backticks, puts a zero-width space after every `@` (no mention,
 * no e-mail link) and after a `#` that is followed by a digit (no issue or pull request link), and cuts the result to
 * `cap` characters without ever separating an `@` from its space.
 */
export function sanitizePrText(value: unknown, cap: number): string {
  const clean = sanitizeModelText(value, cap)
    .replaceAll('`', '')
    .replaceAll('![', '[')
    .replaceAll('](', '] (')
    .replace(/\s+/g, ' ')
    .trim();
  let out = '';
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i] as string;
    const next = clean[i + 1] ?? '';
    const piece = ch === '@' || (ch === '#' && /\d/.test(next)) ? `${ch}${ZWSP}` : ch;
    if (out.length + piece.length > cap) break;
    out += piece;
  }
  return out.trimEnd();
}

export interface PrFacts {
  huntId: string;
  /** `owner/name` of the Lab repo. */
  repo: string;
  /** `WEB_ORIGIN`: the link to the hunt. */
  webOrigin: string;
  service: ServiceName;
  deployId: string;
  /** The full SHA of the culprit commit. */
  sha: string;
  kind: ProposalKind;
  summary: string;
  evidence: ReadonlyArray<{ kind: string; ref: string; detail: string }>;
  checks: readonly ProposalCheck[];
  /** False when the `tests` check passed with no test file (only with `FIX_REQUIRE_TESTS=false`). */
  testsRan: boolean;
  credits: number;
  creditsEstimated: boolean;
}

export class PrFactsError extends Error {
  constructor(readonly field: keyof PrFacts) {
    super(`invalid pull request fact: ${field}`);
    this.name = 'PrFactsError';
  }
}

function assertFacts(f: PrFacts): void {
  if (!CUID_PATTERN.test(f.huntId)) throw new PrFactsError('huntId');
  if (!/^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/.test(f.repo)) throw new PrFactsError('repo');
  if (!/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(f.webOrigin)) throw new PrFactsError('webOrigin');
  if (!(SERVICE_NAMES as readonly string[]).includes(f.service)) throw new PrFactsError('service');
  if (!DEPLOY_ID_PATTERN.test(f.deployId)) throw new PrFactsError('deployId');
  if (!FULL_SHA_PATTERN.test(f.sha)) throw new PrFactsError('sha');
  if (!(PROPOSAL_KINDS as readonly string[]).includes(f.kind)) throw new PrFactsError('kind');
  if (!f.checks.every((c) => (PROPOSAL_CHECK_NAMES as readonly string[]).includes(c.name))) throw new PrFactsError('checks');
  if (!Number.isFinite(f.credits) || f.credits < 0) throw new PrFactsError('credits');
}

/** The first sentence of a summary (or the whole of it), as plain text. */
function firstSentence(text: string): string {
  return text.split(/(?<=[.!?])\s/)[0] ?? text;
}

/** `Exorcist: <one-line summary of the fix>`, at most 72 characters in all. */
export function prTitle(f: Pick<PrFacts, 'kind' | 'service' | 'sha' | 'summary'>): string {
  const head = 'Exorcist: ';
  const line = f.kind === 'revert' ? `Revert ${f.sha.slice(0, 7)} in ${f.service}` : sanitizePrText(firstSentence(sanitizeModelText(f.summary, PR_SUMMARY_MAX)), PR_TITLE_MAX - head.length);
  return `${head}${line === '' ? `fix for ${f.service}` : line}`.slice(0, PR_TITLE_MAX).trimEnd();
}

/** The body, from the fixed template. Only the template adds links: the hunt link and the commit link. */
export function prBody(f: PrFacts): string {
  assertFacts(f);
  const lines: string[] = [];
  lines.push(`Exorcist fix for hunt ${f.huntId}`, '');
  lines.push(`Hunt: ${f.webOrigin}/hunts/${f.huntId}`);
  lines.push(`Service: ${f.service}`);
  lines.push(`Culprit: deploy ${f.deployId}, commit https://github.com/${f.repo}/commit/${f.sha}`);
  lines.push(`Patch kind: ${f.kind}`, '');
  lines.push('Summary', sanitizePrText(f.summary, PR_SUMMARY_MAX) || 'No summary.', '');
  lines.push('Evidence');
  const evidence = f.evidence.slice(0, PR_EVIDENCE_MAX);
  if (evidence.length === 0) lines.push('- none cited');
  for (const e of evidence) lines.push(`- ${sanitizePrText(e.kind, 12)} ${sanitizePrText(e.ref, PR_REF_MAX)}: ${sanitizePrText(e.detail, PR_EVIDENCE_DETAIL_MAX)}`.trimEnd());
  lines.push('', 'Checks');
  if (f.checks.length === 0) lines.push('- none ran');
  for (const c of f.checks) lines.push(`- ${c.name}: ${c.name === 'tests' && c.ok && !f.testsRan ? 'no test ran' : c.ok ? 'passed' : 'failed'}`);
  lines.push('', `Credits spent: ${f.credits.toFixed(2)} (${f.creditsEstimated ? 'estimated' : 'exact'})`, '', PR_NOTICE);
  return lines.join('\n').slice(0, PR_BODY_MAX);
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;
const BIDI_OR_INVISIBLE = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]|\u00ad|\u034f|\u180e|\u200c|\u200d|[\u2060-\u2064]|\ufeff/;
const SCHEME = /\b[a-z][a-z0-9+.-]{1,15}:\/\/\S*/gi;

/**
 * What must hold for any title and body: no HTML, no markdown image or link syntax, no URL but the hunt link and
 * links under `https://github.com/<repo>/`, every `@` followed by U+200B, no `#` directly before a digit, no
 * control, direction or invisible character (U+200B aside), within the limits. An empty list means it holds.
 */
export function prTextProblems(title: string, body: string, ctx: { repo: string; webOrigin: string }): string[] {
  const problems: string[] = [];
  const all = `${title}\n${body}`;
  if (all.includes('<')) problems.push('html');
  if (all.includes('![') || all.includes('](')) problems.push('markdown');
  const allowed = [`https://github.com/${ctx.repo}/`, `${ctx.webOrigin}/hunts/`];
  for (const url of all.match(SCHEME) ?? []) if (!allowed.some((a) => url.startsWith(a))) problems.push('url');
  if (/\bwww\./i.test(all) || /\b(javascript|data|vbscript|mailto|file):/i.test(all)) problems.push('url');
  for (let i = all.indexOf('@'); i !== -1; i = all.indexOf('@', i + 1)) if (all[i + 1] !== ZWSP) problems.push('mention');
  if (/#\d/.test(all)) problems.push('reference');
  if (CONTROL.test(all) || BIDI_OR_INVISIBLE.test(all)) problems.push('characters');
  if (title.includes('\n') || title.length > PR_TITLE_MAX || !title.startsWith('Exorcist: ')) problems.push('title');
  if (body.length > PR_BODY_MAX) problems.push('length');
  if (!body.includes(PR_NOTICE)) problems.push('notice');
  return [...new Set(problems)];
}

/** Throws when the text breaks a rule: the runner calls this before it sends anything to GitHub. */
export function assertPrText(title: string, body: string, ctx: { repo: string; webOrigin: string }): void {
  const problems = prTextProblems(title, body, ctx);
  if (problems.length > 0) throw new PrTextError(problems);
}

export class PrTextError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`pull request text refused: ${problems.join(',')}`);
    this.name = 'PrTextError';
  }
}
