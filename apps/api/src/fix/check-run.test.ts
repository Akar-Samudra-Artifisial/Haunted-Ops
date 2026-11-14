import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SERVICE_NAMES } from '@haunted-ops/shared';
import { CHECK_TMP, buildCheckArgv, buildCheckEnv, checkSyntax, findTestFiles, parseTap, runChecks } from './check-run.js';
import { GitClient } from './git-client.js';
import { BROKEN_CHARGE, HEALTHY_CHARGE, makeLabRepo, type LabRepo } from '../../test/support/lab-repo.js';

const FORBIDDEN_FLAGS = ['--allow-child-process', '--allow-worker', '--allow-addons', '--allow-wasi', '--allow-net'];

// Feature: fix-proposal-flow, Property 12: the test run is fixed and bounded
describe('Property 12: the test run is fixed and bounded', () => {
  const seg = fc.stringMatching(/^[A-Za-z0-9._-]{1,12}$/).filter((s) => s !== '.' && s !== '..');
  it('has the same argument vector for any clone, files and timeout, and no flag that widens the fence', () => {
    fc.assert(
      fc.property(fc.array(seg, { minLength: 1, maxLength: 4 }).map((s) => `/tmp/${s.join('/')}`), fc.array(fc.constantFrom(...SERVICE_NAMES), { maxLength: 3 }), fc.integer({ min: 10_000, max: 300_000 }), (clone, services, timeoutMs) => {
        const files = services.map((s) => `services/${s}/test/a.test.js`);
        const argv = buildCheckArgv({ clone, testFiles: files, timeoutMs });
        expect(argv.slice(0, 7)).toEqual(['--permission', `--allow-fs-read=${clone}`, `--allow-fs-write=${join(clone, CHECK_TMP)}`, '--test', '--test-isolation=none', '--test-reporter=tap', `--test-timeout=${timeoutMs - 5000}`]);
        expect(argv.slice(7)).toEqual(files);
        for (const flag of FORBIDDEN_FLAGS) expect(argv.some((a) => a === flag || a.startsWith(`${flag}=`)), flag).toBe(false);
        // Only these two grants exist, and neither is wider than the clone.
        expect(argv.filter((a) => a.startsWith('--allow-'))).toHaveLength(2);
        expect(buildCheckEnv('/opt/node/bin/node')).toEqual({ PATH: '/opt/node/bin' });
      }),
      { numRuns: 100 },
    );
  });

  it('reads the counts of a TAP report', () => {
    expect(parseTap('TAP version 13\n# tests 5\n# suites 0\n# pass 4\n# fail 1\n')).toEqual({ tests: 5, pass: 4, fail: 1 });
    expect(parseTap('')).toEqual({ tests: 0, pass: 0, fail: 0 });
  });
});

describe('the test run, with real node --permission in a throwaway clone', () => {
  let lab: LabRepo;
  let tmp: string;
  let mirror: string;
  let git: GitClient;
  let n = 0;

  beforeAll(async () => {
    lab = makeLabRepo();
    tmp = mkdtempSync(join(tmpdir(), 'check-run-'));
    git = new GitClient({ gitPath: '/usr/bin/git', repo: 'o/n', token: null, remoteUrl: () => `file://${lab.remote}`, allowFileProtocol: true, home: tmp });
    mirror = join(tmp, 'm.git');
    await git.ensureMirror(mirror);
  });
  afterAll(() => {
    lab.cleanup();
    rmSync(tmp, { recursive: true, force: true });
  });

  const clone = async (): Promise<string> => {
    const dir = join(tmp, `c${++n}`);
    await git.cloneAt(mirror, dir, lab.base);
    return dir;
  };
  const put = (dir: string, rel: string, text: string): void => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };

  it('finds the test files of the service and only those', async () => {
    const dir = await clone();
    put(dir, 'services/payments/test/other.spec.mjs', 'x');
    put(dir, 'services/payments/test/-rf.test.js', 'x');
    put(dir, 'services/payments/node_modules/dep/a.test.js', 'x');
    put(dir, 'services/orders/test/o.test.js', 'x');
    expect(await findTestFiles(dir, 'payments')).toEqual(['services/payments/test/-rf.test.js', 'services/payments/test/charge.test.js', 'services/payments/test/other.spec.mjs']);
    expect(await findTestFiles(dir, 'orders')).toEqual(['services/orders/test/o.test.js']);
    expect(await findTestFiles(dir, 'ledger').catch(() => 'none')).toBe('none');
  });

  it('fails the broken service and passes the healthy one, with the counts', async () => {
    const dir = await clone();
    const files = await findTestFiles(dir, 'payments');
    expect(await runChecks({ clone: dir, testFiles: files, timeoutMs: 30_000 })).toEqual({ ok: false, ran: 2, timedOut: false });
    put(dir, 'services/payments/src/charge.js', HEALTHY_CHARGE);
    expect(await runChecks({ clone: dir, testFiles: files, timeoutMs: 30_000 })).toEqual({ ok: true, ran: 2, timedOut: false });
    expect(BROKEN_CHARGE).not.toBe(HEALTHY_CHARGE);
  }, 40_000);

  it('runs nothing when there is no test file', async () => {
    const dir = await clone();
    expect(await runChecks({ clone: dir, testFiles: [], timeoutMs: 30_000 })).toEqual({ ok: true, ran: 0, timedOut: false });
  });

  it('keeps the test code inside the fence: no read outside the clone, no child process, no secret in the environment', async () => {
    const dir = await clone();
    put(dir, 'services/payments/src/charge.js', HEALTHY_CHARGE);
    put(
      dir,
      'services/payments/test/fence.test.js',
      `import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

test('cannot read a file outside the clone', () => {
  assert.throws(() => readFileSync('/etc/hosts', 'utf8'), (e) => e.code === 'ERR_ACCESS_DENIED');
});
test('cannot write outside the clone', () => {
  assert.throws(() => writeFileSync('/tmp/haunted-fence-should-not-exist', 'x'), (e) => e.code === 'ERR_ACCESS_DENIED');
});
test('cannot start a process', () => {
  assert.throws(() => execFileSync('/bin/ls', ['/']), (e) => e.code === 'ERR_ACCESS_DENIED');
});
test('has an empty environment', () => {
  // Only PATH was given; the runtime itself adds a few names of its own (for example NODE_TEST_WORKER_ID).
  assert.ok(Object.keys(process.env).every((k) => ['PATH', 'NODE_TEST_WORKER_ID', '__CF_USER_TEXT_ENCODING'].includes(k)));
  assert.equal(process.env.HOME, undefined);
});
test('can write in its own temporary folder', () => {
  writeFileSync(process.cwd() + '/${CHECK_TMP}/ok.txt', 'x');
});
`,
    );
    const files = await findTestFiles(dir, 'payments');
    const result = await runChecks({ clone: dir, testFiles: files, timeoutMs: 30_000 });
    expect(result).toEqual({ ok: true, ran: 7, timedOut: false });
  }, 40_000);

  it('keeps the test code off the network: no socket and no fetch reach a listener the test opened (Node >= 25 gate)', async () => {
    let connections = 0;
    const server = createServer((socket) => {
      connections++;
      socket.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const dir = await clone();
      put(dir, 'services/payments/src/charge.js', HEALTHY_CHARGE);
      put(
        dir,
        'services/payments/test/net.test.js',
        `import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

test('cannot open a socket', async () => {
  const code = await new Promise((resolve) => {
    try {
      const s = net.connect(${port}, '127.0.0.1');
      s.on('connect', () => { s.end(); resolve('connected'); });
      s.on('error', (e) => resolve(e.code));
    } catch (e) {
      resolve(e.code);
    }
  });
  assert.equal(code, 'ERR_ACCESS_DENIED');
});
test('cannot fetch', async () => {
  await assert.rejects(fetch('http://127.0.0.1:${port}/'), (e) => (e.code ?? e.cause?.code) === 'ERR_ACCESS_DENIED');
});
`,
      );
      const result = await runChecks({ clone: dir, testFiles: ['services/payments/test/net.test.js'], timeoutMs: 30_000 });
      expect(result).toEqual({ ok: true, ran: 2, timedOut: false });
      expect(connections).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 40_000);

  it('stops a run that does not end, killing the group, and says so', async () => {
    const dir = await clone();
    put(dir, 'services/payments/test/loop.test.js', "import test from 'node:test';\ntest('never ends', () => { for (;;) {} });\n");
    const started = Date.now();
    const result = await runChecks({ clone: dir, testFiles: ['services/payments/test/loop.test.js'], timeoutMs: 1500 });
    expect(result).toMatchObject({ ok: false, timedOut: true });
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 20_000);

  it('checks the syntax of a file, and refuses a name that is not a plain path', async () => {
    const dir = await clone();
    put(dir, 'services/payments/src/ok.js', HEALTHY_CHARGE);
    put(dir, 'services/payments/src/bad.js', 'export function (\n');
    expect(await checkSyntax(dir, 'services/payments/src/ok.js')).toBe(true);
    expect(await checkSyntax(dir, 'services/payments/src/bad.js')).toBe(false);
    for (const bad of ['../x.js', '-e', 'a b.js', '/etc/hosts', '']) expect(await checkSyntax(dir, bad), bad).toBe(false);
  });
});
