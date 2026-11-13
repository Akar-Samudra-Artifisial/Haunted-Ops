import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startFakeLab, type FakeLab } from '../../../../tools/fake-kiro-cli/fake-lab.mjs';
import { createFakeKiroCli, type FakeKiroCli } from '../../../../tools/fake-kiro-cli/wrapper.mjs';
import { buildHuntArgv, buildHuntEnv, defaultMcpBinDir } from './hunt-env.js';
import { HuntProcess, type HuntExit, type HuntProcessOptions } from './hunt-process.js';
import { HuntWorkdir } from './hunt-workdir.js';

const TOKEN = 'lab-read-token-0123456789-abcdef';
const HUNT_ID = 'cmprocesstestaaaaaaaaaaaa';
const FACTS = { incidentId: 'cmincidentaaaaaaaaaaaaaaa', service: 'payments' as const, level: 2 as const, reasonKind: 'error_rate' as const, openedAt: new Date('2026-11-13T10:41:00Z') };

let lab: FakeLab;
let root: string;
let workdir: HuntWorkdir;
const fakes: FakeKiroCli[] = [];

beforeAll(async () => {
  lab = await startFakeLab({ token: TOKEN });
  root = mkdtempSync(join(tmpdir(), 'hunt-process-'));
  workdir = new HuntWorkdir(join(root, 'hunts'));
  await workdir.prepare();
});
afterAll(async () => {
  await lab.close();
  rmSync(root, { recursive: true, force: true });
});
afterEach(() => {
  for (const f of fakes.splice(0)) f.cleanup();
});

async function setup(fixture: string, over: Partial<HuntProcessOptions> = {}) {
  const fake = createFakeKiroCli({ fixture });
  fakes.push(fake);
  const ledger = await workdir.createLedger(HUNT_ID);
  const output: string[] = [];
  const env = buildHuntEnv({
    cfg: { labUrl: lab.url, labReadToken: TOKEN, labAllowRemote: false, kiroCliPath: fake.path },
    prometheusUrl: lab.url,
    prometheusAllowRemote: false,
    huntId: HUNT_ID,
    ledgerPath: ledger,
    mcpBinDir: defaultMcpBinDir(),
    parentEnv: { HOME: root },
  });
  const proc = new HuntProcess({
    executable: fake.path,
    argv: buildHuntArgv({ model: 'claude-sonnet-5.5' }, FACTS),
    env,
    cwd: workdir.path,
    timeoutMs: 60_000,
    maxOutputBytes: 8 * 1024 * 1024,
    killAfterMs: 400,
    onStdout: (c) => output.push(c),
    ...over,
  });
  return { proc, output, fake };
}

/** True when no process of the group is left; waits up to 2 s for the system to reap the last ones. */
const groupGone = async (pid: number): Promise<boolean> => {
  for (let i = 0; i < 40; i++) {
    try {
      process.kill(-pid, 0);
    } catch {
      return true;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

describe('HuntProcess', () => {
  it('runs a whole hunt with a fixed argv and environment, and leaves nothing behind', async () => {
    const { proc, output } = await setup('error-spike');
    proc.start();
    const pid = proc.pid as number;
    const exit = await proc.done;
    expect(exit).toMatchObject({ code: 0, signal: null, stoppedBy: null, spawnFailed: false });
    expect(exit.stdoutBytes).toBeGreaterThan(1000);
    expect(output.join('')).toContain('runFinished');
    expect(await groupGone(pid)).toBe(true);
    await workdir.removeLedger(HUNT_ID);
  });

  it('stops a hunt that runs too long: SIGTERM to the group, exit 143, and no process of the group is left', async () => {
    const { proc } = await setup('timeout', { timeoutMs: 1500 });
    const started = Date.now();
    proc.start();
    const pid = proc.pid as number;
    const exit = await proc.done;
    expect(exit.stoppedBy).toBe('timeout');
    expect(exit.code === 143 || exit.signal === 'SIGTERM' || exit.signal === 'SIGKILL').toBe(true);
    expect(Date.now() - started).toBeLessThan(8000);
    expect(await groupGone(pid)).toBe(true);
  });

  it('stops on request, keeps the first reason, and ignores a second stop and what arrives after', async () => {
    const seen: string[] = [];
    const { proc } = await setup('foreign-tool', {
      onStdout: (chunk) => {
        seen.push(chunk);
        if (chunk.includes('fs_read')) {
          proc.stop('foreign_tool');
          proc.stop('credit_cap');
          proc.stop('shutdown');
        }
      },
    });
    proc.start();
    const exit = await proc.done;
    expect(exit.stoppedBy).toBe('foreign_tool');
    proc.stop('timeout');
    expect(await proc.done).toBe(exit);
    expect(seen.join('')).toContain('fs_read');
  });

  it('exits with code 3 when the MCP server cannot start, with no stop reason', async () => {
    const { proc } = await setup('mcp-fail');
    proc.start();
    const exit = await proc.done;
    expect(exit).toMatchObject({ code: 3, stoppedBy: null, spawnFailed: false });
  });

  it('reports a program that cannot be started', async () => {
    const { proc } = await setup('error-spike', { executable: join(root, 'does-not-exist') });
    proc.start();
    const exit: HuntExit = await proc.done;
    expect(exit).toMatchObject({ code: null, spawnFailed: true, stoppedBy: null });
  });

  it('stops with stream_error when the output passes the limit', async () => {
    const { proc } = await setup('error-spike', { maxOutputBytes: 600 });
    proc.start();
    const exit = await proc.done;
    expect(exit.stoppedBy).toBe('stream_error');
    expect(exit.stdoutBytes).toBeGreaterThan(600);
  });

  it('ends a process that ignores SIGTERM with SIGKILL after the grace time', async () => {
    const dir = mkdtempSync(join(root, 'stubborn-'));
    const script = join(dir, 'kiro-cli');
    writeFileSync(script, "#!/bin/sh\ntrap '' TERM\nwhile true; do sleep 1; done\n");
    chmodSync(script, 0o755);
    const { proc } = await setup('error-spike', { executable: script, timeoutMs: 800, killAfterMs: 500 });
    proc.start();
    const pid = proc.pid as number;
    const exit = await proc.done;
    expect(exit.stoppedBy).toBe('timeout');
    expect(exit.signal).toBe('SIGKILL');
    expect(await groupGone(pid)).toBe(true);
  });

  it('stopping before the start only records the reason', async () => {
    const { proc } = await setup('error-spike');
    proc.stop('shutdown');
    proc.start();
    const exit = await proc.done;
    expect(exit.stoppedBy).toBe('shutdown');
    expect(exit.stdoutBytes).toBe(0);
  });
});
