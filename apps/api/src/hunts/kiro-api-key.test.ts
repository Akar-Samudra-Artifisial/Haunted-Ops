import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCheckEnv } from '../fix/check-run.js';
import { buildFixEnv } from '../fix/fix-env.js';
import { GitClient, authEnv, type GitExec } from '../fix/git-client.js';
import { buildInstallEnv } from '../fix/lab-deps.js';
import { buildHuntEnv } from './hunt-env.js';
// An obvious fake. It is never a real key.
const KEY = 'kiro-test-SENTINEL-0123456789abcdefghij';
const SRC = fileURLToPath(new URL('..', import.meta.url));
afterEach(() => vi.unstubAllEnvs());
const huntInput = (parentEnv: Record<string, string | undefined>): Parameters<typeof buildHuntEnv>[0] => ({
  cfg: { labUrl: 'http://127.0.0.1:4100', labReadToken: 'lab-read-token-0123456789-abcdef', labAllowRemote: false, kiroCliPath: '/opt/kiro/bin/kiro-cli' },
  prometheusUrl: 'http://127.0.0.1:9090',
  prometheusAllowRemote: false,
  huntId: 'cmhuntaaaaaaaaaaaaaaaaaaa',
  ledgerPath: '/tmp/haunted-ops-hunts/ledgers/cmhuntaaaaaaaaaaaaaaaaaaa.jsonl',
  mcpBinDir: '/repo/packages/exorcist-mcp/bin',
  parentEnv,
  nodeDir: '/usr/local/node/bin',
});
describe('KIRO_API_KEY reaches the hunt child and no other child', () => {
  it('gives the hunt child the same value, and nothing when it is absent or empty', () => {
    expect(buildHuntEnv(huntInput({ HOME: '/home/x', KIRO_API_KEY: KEY })).KIRO_API_KEY).toBe(KEY);
    expect('KIRO_API_KEY' in buildHuntEnv(huntInput({ HOME: '/home/x' }))).toBe(false);
    expect('KIRO_API_KEY' in buildHuntEnv(huntInput({ HOME: '/home/x', KIRO_API_KEY: '' }))).toBe(false);
  });
  it('keeps the key out of every other environment builder, with the key in the API environment', async () => {
    vi.stubEnv('KIRO_API_KEY', KEY);
    const parentEnv = { HOME: '/home/x', LANG: 'en_US.UTF-8', KIRO_API_KEY: KEY };
    const calls: Array<Record<string, string>> = [];
    const exec: GitExec = async (_f, _a, opts) => {
      calls.push(opts.env);
      return { stdout: Buffer.alloc(0) };
    };
    const git = new GitClient({ gitPath: '/usr/bin/git', repo: 'o/n', token: 'dummy-token-for-tests-0123456789', exec, home: '/tmp/h' });
    await git.push('/tmp/x', 'incident', 'cmhuntaaaaaaaaaaaaaaaaaaa', 'a'.repeat(40)).catch(() => undefined);
    await git.fetchBase('/tmp/x').catch(() => undefined);
    expect(calls.length).toBeGreaterThan(0);
    const envs: Array<[string, Record<string, string>]> = [
      ['fixer', buildFixEnv({ cfg: { kiroCliPath: '/opt/kiro/bin/kiro-cli' }, parentEnv, nodeDir: '/n' })],
      ['check run', buildCheckEnv('/opt/node/bin/node')],
      ['lab dependencies', buildInstallEnv('/opt/pnpm/bin/pnpm', parentEnv, { home: '/tmp/h', storeDir: '/tmp/store' })],
      ['git auth', authEnv('dummy-token-for-tests-0123456789')],
      ...calls.map((env, i): [string, Record<string, string>] => [`git call ${i}`, env]),
    ];
    for (const [name, env] of envs) {
      expect(Object.keys(env), name).not.toContain('KIRO_API_KEY');
      expect(JSON.stringify(env), name).not.toContain(KEY);
    }
  });
  // Feature: deploy-demo, Property 4
  it('Property 4: for any key and parent environment, the hunt child has the key exactly when it is non-empty, and no other environment holds it', () => {
    const keyArb = fc.oneof(fc.constant(''), fc.constant(undefined), fc.stringMatching(/^[\x21-\x7e]{20,80}$/));
    const parentArb = fc.dictionary(fc.stringMatching(/^[A-Z][A-Z0-9_]{1,14}$/), fc.string({ maxLength: 20 }), { maxKeys: 10 });
    fc.assert(
      fc.property(keyArb, parentArb, (key, other) => {
        const parentEnv: Record<string, string | undefined> = { ...other, HOME: '/home/x', KIRO_API_KEY: key };
        const hunt = buildHuntEnv(huntInput(parentEnv));
        if (key === undefined || key === '') expect('KIRO_API_KEY' in hunt).toBe(false);
        else expect(hunt.KIRO_API_KEY).toBe(key);
        const others = [
          buildFixEnv({ cfg: { kiroCliPath: '/opt/kiro/bin/kiro-cli' }, parentEnv, nodeDir: '/n' }),
          buildCheckEnv('/opt/node/bin/node'),
          buildInstallEnv('/opt/pnpm/bin/pnpm', parentEnv, { home: '/tmp/h', storeDir: '/tmp/store' }),
        ];
        for (const env of others) {
          expect(Object.keys(env)).not.toContain('KIRO_API_KEY');
          if (key !== undefined && key.length >= 20) expect(JSON.stringify(env).includes(key)).toBe(false);
        }
      }),
      { numRuns: 200 },
    );
  });
  it('is named in no other source file of the API (child environments are built from lists, so a new builder cannot inherit it)', () => {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(dir, e.name));
        else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) files.push(join(dir, e.name));
      }
    };
    walk(SRC);
    const named = files.filter((f) => readFileSync(f, 'utf8').includes('KIRO_API_KEY')).map((f) => relative(SRC, f));
    expect(named.sort()).toEqual(['hunts/hunt-config.ts', 'hunts/hunt-env.ts']);
    // No child of the API is started with the whole environment of the API.
    const inherit = files.filter((f) => /env:\s*process\.env|\.\.\.process\.env/.test(readFileSync(f, 'utf8'))).map((f) => relative(SRC, f));
    expect(inherit).toEqual([]);
  });
});
