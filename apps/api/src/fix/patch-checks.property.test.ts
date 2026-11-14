import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { SERVICE_NAMES } from '@haunted-ops/shared';
import { MAX_PATCH_FILES, MAX_PATCH_LINES, judgePatch, type DynamicChecks, type JudgeContext, type Patch, type TestsResult } from './patch-checks.js';

// Feature: fix-proposal-flow, Property 1: a patch is accepted if and only if every Check passes
describe('Property 1: a patch is accepted if and only if every Check passes', () => {
  const service = 'payments' as const;
  const seg = fc.constantFrom('charge', 'refund', 'lib', 'util', 'index', 'a', 'b');
  const ext = fc.constantFrom('.js', '.mjs', '.ts', '.cts', '.json', '.JSON', '.md', '.yaml', '.sh', '.test.js', '.spec.mjs', '');
  const dirs = fc.constantFrom('services/payments/src', 'services/payments/src/lib', 'services/payments', 'services/payments/test', 'services/payments/src/test', 'services/payments/src/__tests__', 'services/orders/src', 'packages/lab-common', 'services/gate/src', '.');
  const special = fc.constantFrom(
    'services/payments/package.json',
    'services/payments/pnpm-lock.yaml',
    'services/payments/src/package.json',
    'services/payments/src/PACKAGE.JSON',
    'services/payments/src/.env',
    'services/payments/src/.gitattributes',
    'services/payments/src/.gitignore',
    'services/payments/src/.hidden/a.ts',
    'services/payments/src/test-helper.js',
    'services/payments/src/config.json',
  );
  const file = fc.oneof(
    fc.tuple(dirs, seg, ext).map(([d, s, e]) => `${d}/${s}${e}`),
    special,
  );
  const patchArb: fc.Arbitrary<Patch> = fc.record({
    changed: fc.array(file, { maxLength: 4 }).map((ps) => ps.map((path) => ({ path, content: 'x' }))),
    added: fc.array(file, { maxLength: 3 }).map((ps) => ps.map((path) => ({ path, content: 'x' }))),
    deleted: fc.array(file, { maxLength: 2 }),
    unreadable: fc.array(fc.record({ path: file, why: fc.constantFrom('link', 'binary', 'utf8', 'name', 'special', 'hardlink', 'big' as const) }), { maxLength: 2 }),
  });
  const sparse = fc.oneof(
    patchArb,
    // Mostly clean patches, so the later checks are reached often.
    fc.array(fc.tuple(seg, fc.constantFrom('.js', '.mjs')), { minLength: 1, maxLength: 3 }).map(
      (xs): Patch => ({ changed: xs.map(([s, e]) => ({ path: `services/payments/src/${s}${e}`, content: 'x' })), added: [], deleted: [], unreadable: [] }),
    ),
  );
  const tests: fc.Arbitrary<TestsResult> = fc.record({ ok: fc.boolean(), ran: fc.constantFrom(0, 1, 5), timedOut: fc.boolean() });
  // `binary`: git printed `-` for a count (a binary file or a `-diff` attribute).
  const sizeArb = fc.record({ files: fc.integer({ min: 0, max: 8 }), lines: fc.integer({ min: 0, max: 100 }), binary: fc.boolean() });

  const underService = (p: string): boolean => p.startsWith(`services/${service}/`);
  const names = (p: Patch): string[] => [...p.changed.map((f) => f.path), ...p.added.map((f) => f.path), ...p.deleted, ...p.unreadable.map((u) => u.path)];
  const forbiddenWrite = (path: string): boolean => {
    const parts = path.split('/');
    const base = parts.at(-1) as string;
    if (!path.startsWith('services/payments/src/')) return true;
    // Source files only, and no dot segment anywhere.
    if (!/\.(js|mjs|cjs|ts|mts|cts)$/.test(base) || parts.some((s) => s.startsWith('.'))) return true;
    if (/^(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|npm-shrinkwrap\.json|\.npmrc|\.nvmrc|\.env.*)$/i.test(base)) return true;
    if (/\.(json|ya?ml|toml|ini|env|sh|bash|zsh|ps1|bat|cmd|lock|lockb)$/i.test(base)) return true;
    if (/\.(test|spec)\.[A-Za-z0-9]+$/i.test(base) || /^test[_-]/i.test(base)) return true;
    return parts.slice(0, -1).some((d) => ['test', 'tests', '__tests__', 'spec', 'specs', '__mocks__', '__snapshots__', 'fixtures'].includes(d.toLowerCase()));
  };

  /** The independent oracle: the ordered list of checks as (name, passes) and the reason of the first failure. */
  function oracle(p: Patch, size: { files: number; lines: number; binary: boolean }, syntax: boolean, t: TestsResult, requireTests: boolean) {
    const all = names(p);
    const steps: Array<[string, boolean, string]> = [
      ['non_empty', all.length > 0, 'scope'],
      ['scope', all.every(underService), 'scope'],
      ['forbidden_file', p.unreadable.length === 0 && p.deleted.length === 0 && [...p.changed, ...p.added].every((f) => !forbiddenWrite(f.path)), 'forbidden_file'],
      // Uncountable lines are never read as 0: the size check fails, for the reason forbidden_file.
      ['size', !size.binary && size.files >= 1 && size.files <= MAX_PATCH_FILES && size.lines <= MAX_PATCH_LINES, size.binary ? 'forbidden_file' : 'size'],
      ['syntax', syntax, 'tests_failed'],
      ['tests', !t.timedOut && t.ok && !(t.ran === 0 && requireTests), t.timedOut ? 'timeout' : 'tests_failed'],
    ];
    const ran: Array<[string, boolean]> = [];
    for (const [name, ok, reason] of steps) {
      ran.push([name, ok]);
      if (!ok) return { accepted: false, ran, reason };
    }
    return { accepted: true, ran, reason: null };
  }

  it('holds for any change set, size, syntax result and test result', async () => {
    await fc.assert(
      fc.asyncProperty(sparse, sizeArb, fc.boolean(), tests, fc.boolean(), async (patch, size, syntax, t, requireTests) => {
        const calls: string[] = [];
        const dyn: DynamicChecks = {
          size: () => (calls.push('size'), size),
          syntax: () => (calls.push('syntax'), syntax),
          tests: () => (calls.push('tests'), t),
        };
        const ctx: JudgeContext = { service, requireTests, culpritFiles: [] };
        const got = await judgePatch(patch, ctx, dyn);
        const want = oracle(patch, size, syntax, t, requireTests);
        expect(got.accepted).toBe(want.accepted);
        expect(got.aiFailReason).toBe(want.reason);
        // The checks listed are those that ran, in order, up to and including the first that failed.
        const decided = got.checks.filter((c) => c.name !== 'touches_culprit_files').map((c) => [c.name, c.ok] as [string, boolean]);
        expect(decided).toEqual(want.ran);
        // Nothing that needs a clone or a process is asked for after a check failed.
        const order = ['size', 'syntax', 'tests'];
        const reached = want.ran.map(([n]) => n).filter((n) => order.includes(n));
        expect(calls).toEqual(reached);
        // Every accepted patch has every deciding check ok, and only then.
        expect(got.accepted).toBe(decided.length === 6 && decided.every(([, ok]) => ok));
      }),
      { numRuns: 500 },
    );
  });

  it('refuses every patch that touches a service other than the culprit one, whatever else is true', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...SERVICE_NAMES.filter((s) => s !== service)), seg, async (other, s) => {
        const patch: Patch = { changed: [{ path: 'services/payments/src/a.js', content: 'x' }, { path: `services/${other}/src/${s}.js`, content: 'x' }], added: [], deleted: [], unreadable: [] };
        const got = await judgePatch(patch, { service, requireTests: true, culpritFiles: [] }, { size: () => ({ files: 2, lines: 2 }), syntax: () => true, tests: () => ({ ok: true, ran: 3, timedOut: false }) });
        expect(got).toMatchObject({ accepted: false, aiFailReason: 'scope' });
      }),
      { numRuns: 50 },
    );
  });
});
