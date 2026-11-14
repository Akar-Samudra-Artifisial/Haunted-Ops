import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PROPOSAL_CHECK_NAMES, PROPOSAL_KINDS, SERVICE_NAMES } from '@haunted-ops/shared';
import { startFakeGithub } from '../../../../tools/fake-kiro-cli/fake-github.mjs';
import { DUMMY_GITHUB_TOKEN } from '../../test/support/fix.js';
import { PROPOSAL_LABELS } from './fix-startup.js';
import { GithubClient } from './github-client.js';
import { openPullRequest } from './pull-request.js';
import { PR_BODY_MAX, PR_NOTICE, PR_TITLE_MAX, PrFactsError, ZWSP, assertPrText, prBody, prTextProblems, prTitle, sanitizePrText, type PrFacts } from './pr-text.js';

const REPO = 'Akar-Samudra-Artifisial/Haunted-Lab';
const ORIGIN = 'http://localhost:5173';
const SHA = '65c0fca31d0df62c4bab40d2d854c81b1044c650';
const HUNT = 'cmhuntaaaaaaaaaaaaaaaaaaa';
const ctx = { repo: REPO, webOrigin: ORIGIN };

const facts = (over: Partial<PrFacts> = {}): PrFacts => ({
  huntId: HUNT,
  repo: REPO,
  webOrigin: ORIGIN,
  service: 'payments',
  deployId: 'd-7',
  sha: SHA,
  kind: 'ai_patch',
  summary: 'The guard on a missing order was removed. Restore it.',
  evidence: [
    { kind: 'metric', ref: 'metric:payments/error_ratio/15m', detail: 'errors rose' },
    { kind: 'deploy', ref: 'deploy:d-7', detail: 'deploy before the rise' },
  ],
  checks: [{ name: 'non_empty', ok: true }, { name: 'scope', ok: true }, { name: 'tests', ok: true }],
  testsRan: true,
  credits: 0.92,
  creditsEstimated: false,
  ...over,
});

describe('the pull request text', () => {
  it('renders the fixed template with the link, the culprit, the kind, the checks, the credits and the notice', () => {
    const title = prTitle(facts());
    const body = prBody(facts());
    expect(title).toBe('Exorcist: The guard on a missing order was removed.');
    expect(body).toBe(
      [
        `Exorcist fix for hunt ${HUNT}`,
        '',
        `Hunt: ${ORIGIN}/hunts/${HUNT}`,
        'Service: payments',
        `Culprit: deploy d-7, commit https://github.com/${REPO}/commit/${SHA}`,
        'Patch kind: ai_patch',
        '',
        'Summary',
        'The guard on a missing order was removed. Restore it.',
        '',
        'Evidence',
        '- metric metric:payments/error_ratio/15m: errors rose',
        '- deploy deploy:d-7: deploy before the rise',
        '',
        'Checks',
        '- non_empty: passed',
        '- scope: passed',
        '- tests: passed',
        '',
        'Credits spent: 0.92 (exact)',
        '',
        PR_NOTICE,
      ].join('\n'),
    );
    expect(prTextProblems(title, body, ctx)).toEqual([]);
  });

  it('names a revert by its commit, says when no test ran and when the Credits are an estimate', () => {
    const f = facts({ kind: 'revert', checks: [{ name: 'tests', ok: true }, { name: 'size', ok: false }], testsRan: false, credits: 1.5, creditsEstimated: true });
    expect(prTitle(f)).toBe('Exorcist: Revert 65c0fca in payments');
    const body = prBody(f);
    expect(body).toContain('- tests: no test ran');
    expect(body).toContain('- size: failed');
    expect(body).toContain('Credits spent: 1.50 (estimated)');
    expect(body.endsWith(PR_NOTICE)).toBe(true);
  });

  it('removes HTML, images, links, mentions and references from model text, and keeps the words', () => {
    const hostile = 'Fix <script>alert(1)</script> now! ![x](https://evil.example/p.png) [click](http://evil.example) @everyone ping @octocat see #12 and owner/repo#13 www.evil.example `code` javascript:alert(1)';
    const out = sanitizePrText(hostile, 400);
    expect(out).not.toMatch(/<|evil|www\.|javascript:|`|!\[|\]\(/);
    expect(out).toContain(`@${ZWSP}everyone`);
    expect(out).toContain(`#${ZWSP}12`);
    expect(out).toContain(`#${ZWSP}13`);
    expect(out).toContain('Fix');
    const title = prTitle(facts({ summary: hostile }));
    const body = prBody(facts({ summary: hostile, evidence: [{ kind: 'log', ref: 'log:1', detail: hostile }] }));
    expect(prTextProblems(title, body, ctx)).toEqual([]);
    expect(() => assertPrText(title, body, ctx)).not.toThrow();
  });

  it('never separates an @ from its zero-width space when it cuts', () => {
    for (let cap = 1; cap < 12; cap++) {
      const out = sanitizePrText('ab @cd @ef @gh', cap);
      expect(out.length).toBeLessThanOrEqual(cap);
      for (let i = out.indexOf('@'); i !== -1; i = out.indexOf('@', i + 1)) expect(out[i + 1]).toBe(ZWSP);
    }
  });

  it('refuses facts that are not what they should be, and text that breaks a rule', () => {
    expect(() => prBody(facts({ huntId: 'main' }))).toThrow(PrFactsError);
    expect(() => prBody(facts({ sha: 'abc' }))).toThrow(PrFactsError);
    expect(() => prBody(facts({ deployId: 'x' }))).toThrow(PrFactsError);
    expect(() => prBody(facts({ webOrigin: 'javascript:alert(1)' }))).toThrow(PrFactsError);
    expect(() => prBody(facts({ checks: [{ name: 'shell' as never, ok: true }] }))).toThrow(PrFactsError);
    const good = prBody(facts());
    for (const [title, body, problem] of [
      ['Exorcist: x', `${good}\n<img src=x>`, 'html'],
      ['Exorcist: x', `${good}\n![a](b)`, 'markdown'],
      ['Exorcist: x', `${good}\nhttps://evil.example/x`, 'url'],
      ['Exorcist: x', `${good}\nhttps://github.com/other/repo/pull/1`, 'url'],
      ['Exorcist: x', `${good}\nping @octocat`, 'mention'],
      ['Exorcist: x', `${good}\nsee #12`, 'reference'],
      ['Exorcist: x', `${good}\u202e`, 'characters'],
      ['Fix', good, 'title'],
      ['Exorcist: x', good.replace(PR_NOTICE, 'trust me'), 'notice'],
      ['Exorcist: x', `${good}${'x'.repeat(PR_BODY_MAX)}`, 'length'],
    ] as const) {
      expect(prTextProblems(title, body, ctx), problem).toContain(problem);
    }
  });
});

describe('openPullRequest (fake GitHub server)', () => {
  const INCIDENT = `incident/${HUNT}`;
  const FIX = `exorcist/${HUNT}`;
  const make = async () => {
    const fake = await startFakeGithub({ repo: REPO, token: DUMMY_GITHUB_TOKEN });
    const gh = new GithubClient({ token: DUMMY_GITHUB_TOKEN, repo: REPO, baseUrl: fake.url, sleep: async () => undefined });
    await gh.ensureLabels(PROPOSAL_LABELS);
    fake.refs.set(INCIDENT, 'a'.repeat(40));
    fake.refs.set(FIX, 'b'.repeat(40));
    return { fake, gh };
  };

  it('opens a non-draft pull request with the sanitized text and the labels, and no reviewer', async () => {
    const { fake, gh } = await make();
    const hostile = 'Restore the guard @everyone <img src=x> https://evil.example #5';
    const out = await openPullRequest(gh, facts({ summary: hostile }), { head: FIX, base: INCIDENT });
    expect(out).toEqual({ number: 1, htmlUrl: `https://github.com/${REPO}/pull/1`, labeled: true });
    const pull = fake.pulls[0];
    expect(pull).toMatchObject({ head: FIX, base: INCIDENT, labels: ['exorcist', 'ai_patch'], state: 'open' });
    expect(prTextProblems(pull?.title ?? '', pull?.body ?? '', ctx)).toEqual([]);
    expect(pull?.title.startsWith('Exorcist: ')).toBe(true);
    expect(fake.requests.some((r) => /requested_reviewers|reviews|merge|auto/.test(r.path))).toBe(false);
    await fake.close();
  });

  it('labels a revert with its kind, and keeps the pull request when a label cannot be added', async () => {
    const { fake, gh } = await make();
    const out = await openPullRequest(gh, facts({ kind: 'revert' }), { head: FIX, base: INCIDENT });
    expect(fake.pulls[0]?.labels).toEqual(['exorcist', 'revert']);
    expect(out.labeled).toBe(true);
    fake.labels.delete('revert');
    fake.refs.set(`exorcist/${'cmhuntbbbbbbbbbbbbbbbbbbb'}`, 'c'.repeat(40));
    fake.refs.set(`incident/${'cmhuntbbbbbbbbbbbbbbbbbbb'}`, 'a'.repeat(40));
    const two = await openPullRequest(gh, facts({ huntId: 'cmhuntbbbbbbbbbbbbbbbbbbb', kind: 'revert' }), { head: 'exorcist/cmhuntbbbbbbbbbbbbbbbbbbb', base: 'incident/cmhuntbbbbbbbbbbbbbbbbbbb' });
    expect(two).toMatchObject({ number: 2, labeled: false });
    await fake.close();
  });

  it('sends nothing when the base is not an incident branch', async () => {
    const { fake, gh } = await make();
    await expect(openPullRequest(gh, facts({ webOrigin: 'http://localhost:5173' }), { head: FIX, base: 'main' })).rejects.toMatchObject({ code: 'github_bad_response' });
    expect(fake.pulls).toHaveLength(0);
    await fake.close();
  });
});

// Feature: fix-proposal-flow, Property 4: sanitized pull request text has no HTML, mention, image or foreign link
describe('Property 4: sanitized pull request text has no HTML, mention, image or foreign link', () => {
  const pieces = fc.constantFrom(
    'plain words',
    '<b>bold</b>',
    '<script>x</script>',
    '<img src=x onerror=y',
    '![img](https://evil.example/a.png)',
    '[link](https://evil.example)',
    '[ref][1]',
    'https://evil.example/path?q=1',
    'http://169.254.169.254/latest',
    'ftp://host/file',
    'javascript:alert(1)',
    'www.evil.example',
    'mailto:me@evil.example',
    'me@evil.example',
    '@everyone',
    '@octocat',
    '#12',
    'owner/repo#7',
    'closes #3',
    '`code`',
    '\u202eRTL',
    'zero\u200bwidth\u200d',
    '\u001b[31mred\u001b[0m',
    'line\nbreak',
    '\ttab',
    '   spaces   ',
    '](',
    '![',
    'x'.repeat(300),
  );
  const text = fc.array(pieces, { maxLength: 14 }).map((p) => p.join(' '));
  const anyText = fc.oneof(text, fc.string({ maxLength: 600 }), fc.string({ unit: 'binary', maxLength: 200 }));
  const hexSha = fc.stringMatching(/^[0-9a-f]{40}$/);
  const cuid = fc.stringMatching(/^[a-z0-9]{25}$/);
  const repoArb = fc.tuple(fc.stringMatching(/^[A-Za-z0-9._-]{1,20}$/), fc.stringMatching(/^[A-Za-z0-9._-]{1,20}$/)).map(([a, b]) => `${a}/${b}`);
  const originArb = fc.constantFrom('http://localhost:5173', 'https://haunted.example', 'http://127.0.0.1:4173');
  const factsArb: fc.Arbitrary<PrFacts> = fc.record({
    huntId: cuid,
    repo: repoArb,
    webOrigin: originArb,
    service: fc.constantFrom(...SERVICE_NAMES),
    deployId: fc.integer({ min: 1, max: 999_999 }).map((n) => `d-${n}`),
    sha: hexSha,
    kind: fc.constantFrom(...PROPOSAL_KINDS),
    summary: anyText,
    evidence: fc.array(fc.record({ kind: anyText, ref: anyText, detail: anyText }), { maxLength: 12 }),
    checks: fc.array(fc.record({ name: fc.constantFrom(...PROPOSAL_CHECK_NAMES), ok: fc.boolean() }), { maxLength: 8 }),
    testsRan: fc.boolean(),
    credits: fc.double({ min: 0, max: 10, noNaN: true }),
    creditsEstimated: fc.boolean(),
  });

  it('holds for any model or lab text, hunt id and repository', () => {
    fc.assert(
      fc.property(factsArb, (f) => {
        const title = prTitle(f);
        const body = prBody(f);
        expect(prTextProblems(title, body, { repo: f.repo, webOrigin: f.webOrigin })).toEqual([]);
        expect(title.startsWith('Exorcist: ')).toBe(true);
        expect(title.length).toBeLessThanOrEqual(PR_TITLE_MAX);
        expect(body.length).toBeLessThanOrEqual(PR_BODY_MAX);
        expect(body.endsWith(PR_NOTICE)).toBe(true);
        expect(title).not.toContain('\n');
        // The only links are the two the template adds.
        const urls = body.match(/\bhttps?:\/\/\S+/g) ?? [];
        for (const u of urls) expect(u.startsWith(`https://github.com/${f.repo}/commit/`) || u.startsWith(`${f.webOrigin}/hunts/`)).toBe(true);
        expect(urls).toHaveLength(2);
      }),
      { numRuns: 300 },
    );
  });

  it('sanitizes any single string to at most its cap, with every @ and #digit defused', () => {
    fc.assert(
      fc.property(anyText, fc.integer({ min: 1, max: 400 }), (value, cap) => {
        const out = sanitizePrText(value, cap);
        expect(out.length).toBeLessThanOrEqual(cap);
        expect(out).not.toMatch(/[<`]|!\[|\]\(/);
        for (let i = out.indexOf('@'); i !== -1; i = out.indexOf('@', i + 1)) expect(out[i + 1]).toBe(ZWSP);
        expect(/#\d/.test(out)).toBe(false);
        expect(/https?:|ftp:|www\./i.test(out)).toBe(false);
      }),
      { numRuns: 300 },
    );
  });
});
