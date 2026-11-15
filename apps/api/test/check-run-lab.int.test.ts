import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectRunner, findTestFiles, runChecks, type CheckRunLog } from '../src/fix/check-run.js';
import { GitClient } from '../src/fix/git-client.js';
import { LabDeps } from '../src/fix/lab-deps.js';
import { buildBaseline, type ServiceBaseline } from '../src/fix/test-baseline.js';

/** Filled in from the first run (see the design, task 15). */
// `inventory.test.ts` imports `scripts/scenario-copy.mjs`, which writes a patched copy into `services/orders/`: the
// sandbox only lets a test write in `.fix-tmp`, so the run is refused there.
const INVENTORY_DETAIL = /--allow-fs-write/;
import { resolveExecutable } from '../src/hunts/hunt-config.js';

/**
 * The real test runner against the real lab (fix-proposal-flow task 14). The lab services test with vitest; the API
 * installs the lab tree once (pnpm, `--frozen-lockfile --ignore-scripts`) and runs the payments tests of a clone
 * under the two `--permission` fences. Skipped when `../haunted-lab` or `pnpm` is not on this machine. No network is
 * needed when the pnpm store already holds the lab's packages (`--prefer-offline`).
 */
const LAB = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../haunted-lab');
const CULPRIT = '65c0fca31d0df62c4bab40d2d854c81b1044c650';
const PNPM = resolveExecutable('pnpm', process.env.PATH);
const HAVE_LAB = existsSync(join(LAB, '.git')) && PNPM !== null && spawnSync('git', ['-C', LAB, 'cat-file', '-e', `${CULPRIT}^{commit}`]).status === 0;

describe.skipIf(!HAVE_LAB)('the vitest runner on the real lab payments service', () => {
  let tmp: string;
  let mirror: string;
  let deps: string | null;
  /** The sandbox-green set of payments at the lab's `main`, as the API makes it at startup. */
  let set: ServiceBaseline;
  /** The sets of every vitest service at `main`. */
  let all: Map<string, ServiceBaseline>;
  const logs: CheckRunLog[] = [];
  const depLogs: string[] = [];
  const git = new GitClient({ gitPath: '/usr/bin/git', repo: 'o/n', token: null, home: tmpdir() });

  beforeAll(async () => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'check-run-lab-')));
    mirror = join(tmp, 'lab.git');
    execFileSync('git', ['clone', '--quiet', '--bare', '--no-hardlinks', LAB, mirror]);
    const labDeps = new LabDeps({ root: join(tmp, 'deps'), pnpmPath: PNPM, parentEnv: process.env, git, log: (level, msg, fields) => void depLogs.push(JSON.stringify({ level, msg, ...fields })) });
    const main = execFileSync('git', ['-C', mirror, 'rev-parse', 'main'], { encoding: 'utf8' }).trim();
    const mainDeps = await labDeps.ensure(mirror, main);
    deps = await labDeps.ensure(mirror, CULPRIT);
    const atMain = join(tmp, 'baseline');
    execFileSync('git', ['clone', '--quiet', '--no-hardlinks', mirror, atMain]);
    execFileSync('git', ['-C', atMain, 'checkout', '--quiet', '--detach', main]);
    all = mainDeps === null ? new Map() : await buildBaseline(atMain, mainDeps, 120_000);
    set = all.get('payments') ?? { included: [], excluded: [] };
  }, 900_000);

  it('makes the sets of every lab service at main: payments has its refunds test, orders and gate have none', () => {
    const view = Object.fromEntries([...all].map(([s, b]) => [s, b]));
    expect(all.get('orders')?.included, JSON.stringify(view)).toEqual([]);
    expect(all.get('gate')?.included, JSON.stringify(view)).toEqual([]);
    const inventory = all.get('orders')?.excluded.find((e) => e.file === 'services/orders/test/inventory.test.ts');
    expect(inventory?.reason, JSON.stringify(view)).toBe('failed');
    // The first error line explains the failure, with no absolute path.
    expect(inventory?.detail ?? '', JSON.stringify(view)).toMatch(INVENTORY_DETAIL);
    expect(JSON.stringify(view)).not.toContain(tmp);
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  /** A fresh clone at the culprit, as the Proposal runner makes one; `edit` runs before the tests. */
  const candidate = (name: string, edit: (dir: string) => void): string => {
    const dir = join(tmp, name);
    execFileSync('git', ['clone', '--quiet', '--no-hardlinks', mirror, dir]);
    execFileSync('git', ['-C', dir, 'checkout', '--quiet', '--detach', CULPRIT]);
    edit(dir);
    return dir;
  };
  const revertCulprit = (dir: string): void => {
    execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'revert', '--no-edit', CULPRIT], { stdio: 'ignore' });
  };
  /** The `tests` check of a candidate: the sandbox-green set of payments, as the Proposal runner runs it. */
  const run = async (dir: string, files?: string[]) =>
    runChecks({
      clone: dir,
      testFiles: files ?? (await findTestFiles(dir, 'payments')).filter((f) => set.included.includes(f)),
      timeoutMs: 120_000,
      runner: await detectRunner(dir, 'payments'),
      service: 'payments',
      deps,
      log: (f) => void logs.push(f),
    });

  it('selects the sandbox-green set at main: the refunds unit test is in, the loopback HTTP routes test is out', () => {
    expect(set.included).toContain('services/payments/test/refunds.test.ts');
    expect(set.excluded).toContainEqual({ file: 'services/payments/test/routes.test.ts', reason: 'needs_network' });
    expect(set.included).not.toContain('services/payments/test/routes.test.ts');
  });

  it('installs the lab tree once and reuses it for the same lockfile', async () => {
    expect(deps, depLogs.join('\n')).not.toBeNull();
    expect(existsSync(join(deps as string, 'node_modules', 'vitest', 'vitest.mjs'))).toBe(true);
    const again = new LabDeps({ root: join(tmp, 'deps'), pnpmPath: '/nonexistent/pnpm', parentEnv: {}, git, log: () => undefined });
    expect(await again.ensure(mirror, CULPRIT)).toBe(deps);
  });

  it('passes the tests check at the culprit with the culprit reverted', async () => {
    const dir = candidate('reverted', revertCulprit);
    expect(await detectRunner(dir, 'payments')).toBe('vitest');
    logs.length = 0;
    const result = await run(dir);
    expect(result, JSON.stringify(logs)).toMatchObject({ ok: true, timedOut: false });
    expect(result.ran).toBeGreaterThanOrEqual(2);
    // The links are gone after the run: the tree that is pushed is the tree that was tested.
    expect(existsSync(join(dir, 'node_modules'))).toBe(false);
    expect(existsSync(join(dir, 'services', 'payments', 'node_modules'))).toBe(false);
    expect(execFileSync('git', ['-C', dir, 'status', '--porcelain', '--ignored'], { encoding: 'utf8' }).split('\n').filter((l) => l !== '' && !l.includes('.fix-tmp'))).toEqual([]);
  }, 180_000);

  it('fails the tests check with a deliberately broken refund, and logs a diagnostics line without paths', async () => {
    const dir = candidate('broken', (d) => {
      revertCulprit(d);
      const file = join(d, 'services/payments/src/refunds.ts');
      writeFileSync(file, readFileSync(file, 'utf8').replace('return DEFAULT_TERMS;', 'return { windowDays: 1, feeCents: 999 };'));
    });
    logs.length = 0;
    const result = await run(dir);
    expect(result.ok).toBe(false);
    expect(result.ran).toBeGreaterThan(0);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ runner: 'vitest', code: 'tests_failed' });
    expect(logs[0]?.fail).toBeGreaterThan(0);
    expect(JSON.stringify(logs[0])).not.toContain(tmp);
  }, 180_000);

  it('fails the culprit itself (the planted bug)', async () => {
    const result = await run(candidate('culprit', () => undefined));
    expect(result.ok).toBe(false);
  }, 180_000);

  it('runs the test in a forked child that keeps --permission without --allow-net: network, child processes and outside reads are denied', async () => {
    const outside = join(tmp, 'outside-secret.txt');
    writeFileSync(outside, 'secret');
    let connections = 0;
    const server: Server = createServer((s) => {
      connections += 1;
      s.destroy();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      const dir = candidate('fence', (d) => {
        revertCulprit(d);
        writeFileSync(
          join(d, 'services/payments/test/fence.test.ts'),
          `import { expect, it } from 'vitest';
import net from 'node:net';
import cp from 'node:child_process';
import fs from 'node:fs';
import { Worker } from 'node:worker_threads';
const code = (fn: () => unknown): string => { try { fn(); return 'allowed'; } catch (e) { return String((e as { code?: string }).code); } };
it('cannot connect', async () => {
  const r = await new Promise<string>((res) => { const s = net.connect(${port}, '127.0.0.1'); s.on('error', (e: NodeJS.ErrnoException) => res(String(e.code))); s.on('connect', () => { s.destroy(); res('connected'); }); });
  expect(r).toBe('ERR_ACCESS_DENIED');
});
it('cannot fetch', async () => {
  const r = await fetch('http://127.0.0.1:${port}/').then(() => 'fetched', (e: { cause?: { code?: string }; code?: string }) => String(e.cause?.code ?? e.code));
  expect(r).not.toBe('fetched');
});
it('cannot spawn', () => {
  expect(code(() => cp.spawnSync('/bin/sh', ['-c', 'true']))).toBe('ERR_ACCESS_DENIED');
  expect(code(() => cp.execFileSync('/bin/ls'))).toBe('ERR_ACCESS_DENIED');
});
it('cannot start a worker', () => {
  expect(code(() => new Worker('1', { eval: true, execArgv: [] }))).toBe('ERR_ACCESS_DENIED');
});
it('cannot read outside the clone or the tree', () => {
  expect(code(() => fs.readFileSync(${JSON.stringify(outside)}))).toBe('ERR_ACCESS_DENIED');
  expect(code(() => fs.readFileSync('/etc/hosts'))).toBe('ERR_ACCESS_DENIED');
});
it('cannot write in the source folder', () => {
  expect(code(() => fs.writeFileSync(process.cwd() + '/src/x.ts', 'x'))).toBe('ERR_ACCESS_DENIED');
});
`,
        );
      });
      logs.length = 0;
      const result = await run(dir, ['services/payments/test/fence.test.ts']);
      expect(result, JSON.stringify(logs)).toMatchObject({ ok: true });
      expect(result.ran).toBe(6);
      expect(connections).toBe(0);
      expect(existsSync(join(dir, 'services/payments/src/x.ts'))).toBe(false);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 180_000);

  it('a worker thread with an execArgv of its own leaves the permission model on this Node (why the forks pool is used)', () => {
    const script = join(tmp, 'worker-escape.cjs');
    writeFileSync(script, `const { Worker } = require('node:worker_threads');\nconst w = new Worker("let r; try { require('fs').readFileSync('/etc/hosts'); r = 'read'; } catch (e) { r = e.code; } require('worker_threads').parentPort.postMessage(r);", { eval: true, execArgv: [] });\nw.on('message', (m) => { console.log(m); process.exit(0); });\n`);
    const out = spawnSync(process.execPath, ['--permission', `--allow-fs-read=${script}`, '--allow-worker', script], { encoding: 'utf8' }).stdout.trim();
    // If a later Node keeps the fence in such a worker, this says so, and the threads pool can be considered again.
    expect(out).toBe('read');
  });
});
