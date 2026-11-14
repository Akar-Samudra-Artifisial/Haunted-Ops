import { execFileSync } from 'node:child_process';
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_PATCH_FILE_BYTES, isForbiddenName, judgePatch, readPatch, type DynamicChecks, type JudgeContext, type Patch } from './patch-checks.js';

describe('readPatch', () => {
  let tmp: string;
  let exp: string;
  let work: string;
  const put = (root: string, rel: string, text: string | Buffer): void => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  };

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'read-patch-'));
    exp = join(tmp, 'export');
    work = join(tmp, 'work');
    for (const root of [exp, work]) {
      put(root, 'services/payments/src/charge.js', 'old\n');
      put(root, 'services/payments/src/same.js', 'same\n');
      put(root, 'services/payments/test/charge.test.js', 'test\n');
      put(root, 'packages/lab-common/index.js', 'common\n');
    }
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it('reports changed, added and deleted files, and nothing that is the same', async () => {
    put(work, 'services/payments/src/charge.js', 'new\n');
    put(work, 'services/payments/src/extra.js', 'extra\n');
    rmSync(join(work, 'services/payments/test/charge.test.js'));
    mkdirSync(join(work, 'services/payments/src/empty-dir'));
    // The agent copy is part of the folder and is not part of the patch.
    put(work, '.kiro/agents/exorcist-fixer.json', '{}');
    const p = await readPatch(exp, work);
    expect(p.changed).toEqual([{ path: 'services/payments/src/charge.js', content: 'new\n' }]);
    expect(p.added).toEqual([{ path: 'services/payments/src/extra.js', content: 'extra\n' }]);
    expect(p.deleted).toEqual(['services/payments/test/charge.test.js']);
    expect(p.unreadable).toEqual([]);
  });

  it('never follows a link: a symlink, a hard link, a fifo, a binary file, bad UTF-8, a big file and odd names are unreadable', async () => {
    symlinkSync('/etc/hosts', join(work, 'services/payments/src/link.js'));
    linkSync(join(work, 'services/payments/src/same.js'), join(work, 'services/payments/src/hard.js'));
    execFileSync('mkfifo', [join(work, 'services/payments/src/pipe.js')]);
    put(work, 'services/payments/src/bin.js', Buffer.from([0x61, 0x00, 0x62]));
    put(work, 'services/payments/src/bad.js', Buffer.from([0xff, 0xfe, 0x41]));
    put(work, 'services/payments/src/big.js', 'x'.repeat(MAX_PATCH_FILE_BYTES + 1));
    put(work, 'services/payments/src/a b.js', 'x');
    put(work, 'services/payments/src/e\u0301.js', 'x');
    put(work, '.kiro/hooks/x.json', '{}');
    const p = await readPatch(exp, work);
    const why = Object.fromEntries(p.unreadable.map((u) => [u.path, u.why]));
    expect(why['services/payments/src/link.js']).toBe('link');
    expect(why['services/payments/src/hard.js']).toBe('hardlink');
    // `same.js` is the other name of that hard link: it is flagged too, because its link count is 2.
    expect(why['services/payments/src/same.js']).toBe('hardlink');
    expect(why['services/payments/src/pipe.js']).toBe('special');
    expect(why['services/payments/src/bin.js']).toBe('binary');
    expect(why['services/payments/src/bad.js']).toBe('utf8');
    expect(why['services/payments/src/big.js']).toBe('big');
    expect(why['services/payments/src/a b.js']).toBe('name');
    expect(why['services/payments/src/e\u0301.js']).toBe('name');
    expect(why['.kiro/hooks/x.json']).toBe('name');
    // The link target was never read: nothing of /etc/hosts is in the patch.
    expect(JSON.stringify(p)).not.toContain('localhost');
  });
});

describe('isForbiddenName', () => {
  it('forbids package files, configuration, scripts and tests, and nothing else', () => {
    for (const p of ['services/payments/package.json', 'services/payments/src/package.json', 'services/payments/pnpm-lock.yaml', 'services/payments/src/config.json', 'services/payments/src/a.yaml', 'services/payments/src/run.sh', 'services/payments/src/.env', 'services/payments/src/a.test.js', 'services/payments/src/a.spec.mjs', 'services/payments/src/test/a.js', 'services/payments/src/__tests__/a.js', 'services/payments/src/test-utils.js', 'services/payments/src/.npmrc']) {
      expect(isForbiddenName(p), p).toBe(true);
    }
    for (const p of ['services/payments/src/charge.js', 'services/payments/src/lib/refund.mjs', 'services/payments/src/contest.js', 'services/payments/src/latest.js']) expect(isForbiddenName(p), p).toBe(false);
  });

  it('allows only source files, no dot segment, and compares package names in any case', () => {
    // The lab services are TypeScript; the test lab is JavaScript.
    for (const ext of ['js', 'mjs', 'cjs', 'ts', 'mts', 'cts']) expect(isForbiddenName(`services/payments/src/a.${ext}`), ext).toBe(false);
    for (const p of [
      'services/payments/src/.gitattributes',
      'services/payments/src/.gitignore',
      'services/payments/src/.npmrc',
      'services/payments/src/.env',
      'services/payments/src/.hidden/a.ts',
      'services/payments/src/.a.ts',
      'services/payments/src/PACKAGE.JSON',
      'services/payments/src/Package.Json',
      'services/payments/src/PNPM-LOCK.YAML',
      'services/payments/src/data.json',
      'services/payments/src/README.md',
      'services/payments/src/notes.txt',
      'services/payments/src/Makefile',
      'services/payments/src/a.JS',
      'services/payments/src/a.Test.ts',
      'services/payments/src/Tests/a.ts',
    ]) {
      expect(isForbiddenName(p), p).toBe(true);
    }
  });

  it('refuses a patch that writes .gitignore, PACKAGE.JSON, a .json or a .md file in src/', async () => {
    const dyn: DynamicChecks = { size: () => ({ files: 1, lines: 2 }), syntax: () => true, tests: () => ({ ok: true, ran: 2, timedOut: false }) };
    const ctx: JudgeContext = { service: 'payments', requireTests: true, culpritFiles: [] };
    for (const path of ['services/payments/src/.gitignore', 'services/payments/src/PACKAGE.JSON', 'services/payments/src/config.json', 'services/payments/src/NOTES.md', 'services/payments/src/.gitattributes']) {
      const patch: Patch = { changed: [], added: [{ path, content: 'x\n' }], deleted: [], unreadable: [] };
      expect(await judgePatch(patch, ctx, dyn), path).toMatchObject({ accepted: false, aiFailReason: 'forbidden_file' });
    }
    // A plain TypeScript source file still passes.
    const good: Patch = { changed: [{ path: 'services/payments/src/refunds.ts', content: 'export {};\n' }], added: [], deleted: [], unreadable: [] };
    expect(await judgePatch(good, ctx, dyn)).toMatchObject({ accepted: true });
  });
});

describe('judgePatch', () => {
  const ctx: JudgeContext = { service: 'payments', requireTests: true, culpritFiles: ['services/payments/src/charge.js'] };
  const good: Patch = { changed: [{ path: 'services/payments/src/charge.js', content: 'x' }], added: [], deleted: [], unreadable: [] };
  const dyn = (over: Partial<{ size: { files: number; lines: number }; syntax: boolean; tests: { ok: boolean; ran: number; timedOut: boolean } }> = {}): DynamicChecks & { calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      size: () => (calls.push('size'), over.size ?? { files: 1, lines: 3 }),
      syntax: () => (calls.push('syntax'), over.syntax ?? true),
      tests: () => (calls.push('tests'), over.tests ?? { ok: true, ran: 2, timedOut: false }),
    };
  };
  const reasonOf = async (patch: Patch, d = dyn(), c = ctx): Promise<[string | null, string[]]> => {
    const j = await judgePatch(patch, c, d);
    return [j.aiFailReason, j.checks.map((x) => `${x.name}:${x.ok}`)];
  };

  it('accepts a small patch in src that passes the syntax and the tests, and records every check in order', async () => {
    const d = dyn();
    expect(await judgePatch(good, ctx, d)).toEqual({
      accepted: true,
      aiFailReason: null,
      checks: [
        { name: 'non_empty', ok: true },
        { name: 'scope', ok: true },
        { name: 'forbidden_file', ok: true },
        { name: 'size', ok: true },
        { name: 'syntax', ok: true },
        { name: 'tests', ok: true },
        { name: 'touches_culprit_files', ok: true },
      ],
    });
    expect(d.calls).toEqual(['size', 'syntax', 'tests']);
    // Not touching the culprit's files is information, not a failure.
    const other = { ...good, changed: [{ path: 'services/payments/src/other.js', content: 'x' }] };
    expect((await judgePatch(other, ctx, dyn())).accepted).toBe(true);
    expect((await judgePatch(other, ctx, dyn())).checks.at(-1)).toEqual({ name: 'touches_culprit_files', ok: false });
  });

  it('names the first check that fails, with the reason, and asks for nothing after it', async () => {
    const empty: Patch = { changed: [], added: [], deleted: [], unreadable: [] };
    expect(await reasonOf(empty)).toEqual(['scope', ['non_empty:false']]);
    const orders: Patch = { ...good, added: [{ path: 'services/orders/src/a.js', content: 'x' }] };
    expect(await reasonOf(orders)).toEqual(['scope', ['non_empty:true', 'scope:false']]);
    const lab: Patch = { ...good, added: [{ path: 'packages/lab-common/a.js', content: 'x' }] };
    expect((await reasonOf(lab))[0]).toBe('scope');
    const pkg: Patch = { ...good, changed: [{ path: 'services/payments/package.json', content: '{}' }] };
    expect(await reasonOf(pkg)).toEqual(['forbidden_file', ['non_empty:true', 'scope:true', 'forbidden_file:false']]);
    const top: Patch = { ...good, added: [{ path: 'services/payments/new.js', content: 'x' }] };
    expect((await reasonOf(top))[0]).toBe('forbidden_file');
    const del: Patch = { ...good, deleted: ['services/payments/test/charge.test.js'] };
    expect((await reasonOf(del))[0]).toBe('forbidden_file');
    const link: Patch = { ...good, unreadable: [{ path: 'services/payments/src/link.js', why: 'link' }] };
    expect((await reasonOf(link))[0]).toBe('forbidden_file');
    const test: Patch = { ...good, added: [{ path: 'services/payments/src/a.test.js', content: 'x' }] };
    expect((await reasonOf(test))[0]).toBe('forbidden_file');
    const d1 = dyn();
    await reasonOf(pkg, d1);
    expect(d1.calls).toEqual([]);
    expect((await reasonOf(good, dyn({ size: { files: 6, lines: 10 } })))[0]).toBe('size');
    expect((await reasonOf(good, dyn({ size: { files: 1, lines: 61 } })))[0]).toBe('size');
    expect((await reasonOf(good, dyn({ size: { files: 5, lines: 60 } })))[0]).toBeNull();
    const d2 = dyn({ syntax: false });
    expect(await reasonOf(good, d2)).toEqual(['tests_failed', ['non_empty:true', 'scope:true', 'forbidden_file:true', 'size:true', 'syntax:false']]);
    expect(d2.calls).toEqual(['size', 'syntax']);
    expect((await reasonOf(good, dyn({ tests: { ok: false, ran: 2, timedOut: false } })))[0]).toBe('tests_failed');
    expect((await reasonOf(good, dyn({ tests: { ok: false, ran: 1, timedOut: true } })))[0]).toBe('timeout');
  });

  it('fails a run with no test unless tests are not required', async () => {
    const none = dyn({ tests: { ok: true, ran: 0, timedOut: false } });
    expect((await reasonOf(good, none))[0]).toBe('tests_failed');
    expect((await reasonOf(good, dyn({ tests: { ok: true, ran: 0, timedOut: false } }), { ...ctx, requireTests: false }))[0]).toBeNull();
  });
});
