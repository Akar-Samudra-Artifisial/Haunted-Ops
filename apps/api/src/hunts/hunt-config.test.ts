import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  HUNT_DEFAULTS,
  HUNT_VARS,
  HuntConfigError,
  isSafeWorkdir,
  isTokenValid,
  parseHuntConfig,
  resolveExecutable,
  type HuntConfigDeps,
  type HuntVar,
} from './hunt-config.js';

const TOKEN_A = 'lab-read-token-0123456789-abcdef';
const TOKEN_B = 'hunt-admin-token-0123456789-abcd';
const deps: HuntConfigDeps = { resolveExecutable: (name) => (name === 'kiro-cli' ? '/opt/kiro/kiro-cli' : name.startsWith('/') && !name.includes('missing') ? name : null), tmpDir: () => '/tmp' };
const on = { HUNTS_ENABLED: 'true', LAB_READ_TOKEN: TOKEN_A, HUNT_ADMIN_TOKEN: TOKEN_B };

const errorOf = (env: Record<string, string | undefined>, d: HuntConfigDeps = deps): HuntConfigError => {
  try {
    parseHuntConfig(env, d);
  } catch (err) {
    if (err instanceof HuntConfigError) return err;
    throw err;
  }
  throw new Error('expected a HuntConfigError');
};

describe('parseHuntConfig', () => {
  it('has safe defaults with nothing set: off, no tokens, the documented caps', () => {
    const c = parseHuntConfig({}, deps);
    expect(c).toEqual({
      enabled: false,
      labUrl: HUNT_DEFAULTS.labUrl,
      labAllowRemote: false,
      labReadToken: null,
      adminToken: null,
      kiroCliPath: 'kiro-cli',
      model: 'claude-sonnet-5.5',
      creditCap: 1.5,
      dailyCreditCap: 30,
      timeoutMs: 90_000,
      cooldownMs: 120_000,
      settleMs: 10_000,
      maxToolCalls: 20,
      dailyMax: 40,
      workdir: '/tmp/haunted-ops-hunts',
    });
    expect(Object.isFrozen(c)).toBe(true);
  });

  it('turns on with two tokens and an executable, and resolves the CLI path', () => {
    const c = parseHuntConfig({ ...on, HUNT_CREDIT_CAP: '2', HUNT_DAILY_CREDIT_CAP: '10.5', HUNT_TIMEOUT_MS: '120000', HUNT_COOLDOWN_MS: '0', HUNT_SETTLE_MS: '0', HUNT_MAX_TOOL_CALLS: '30', HUNT_WORKDIR: '/var/hunts' }, deps);
    expect(c).toMatchObject({ enabled: true, labReadToken: TOKEN_A, adminToken: TOKEN_B, kiroCliPath: '/opt/kiro/kiro-cli', creditCap: 2, dailyCreditCap: 10.5, timeoutMs: 120_000, cooldownMs: 0, settleMs: 0, maxToolCalls: 30, workdir: '/var/hunts' });
  });

  it('requires both tokens and an executable KIRO_CLI_PATH when enabled, and nothing when off', () => {
    expect(errorOf({ HUNTS_ENABLED: 'true' }).variables).toEqual(['LAB_READ_TOKEN', 'HUNT_ADMIN_TOKEN']);
    expect(errorOf({ ...on, KIRO_CLI_PATH: '/missing/kiro-cli' }).variables).toEqual(['KIRO_CLI_PATH']);
    expect(errorOf({ ...on, KIRO_CLI_PATH: 'other' }).variables).toEqual(['KIRO_CLI_PATH']);
    expect(parseHuntConfig({ KIRO_CLI_PATH: '/missing/kiro-cli' }, deps).enabled).toBe(false);
  });

  it('refuses short, placeholder and equal tokens, even when off', () => {
    for (const bad of ['short', 'change-me-use-a-long-random-token-1', 'CHANGE-ME-use-a-long-random-token-1', `${TOKEN_A} with space`]) {
      expect(errorOf({ LAB_READ_TOKEN: bad }).variables).toEqual(['LAB_READ_TOKEN']);
      expect(errorOf({ HUNT_ADMIN_TOKEN: bad }).variables).toEqual(['HUNT_ADMIN_TOKEN']);
    }
    expect(errorOf({ ...on, HUNT_ADMIN_TOKEN: TOKEN_A }).variables).toEqual(['HUNT_ADMIN_TOKEN']);
    expect(isTokenValid(TOKEN_A)).toBe(true);
    expect(isTokenValid('x'.repeat(23))).toBe(false);
    expect(isTokenValid('x'.repeat(24))).toBe(true);
  });

  it('keeps LAB_URL on loopback unless LAB_ALLOW_REMOTE, and never link-local', () => {
    expect(parseHuntConfig({ LAB_URL: 'http://localhost:4100' }, deps).labUrl).toBe('http://localhost:4100');
    expect(parseHuntConfig({ LAB_URL: 'http://[::1]:4100' }, deps).labUrl).toBe('http://[::1]:4100');
    expect(errorOf({ LAB_URL: 'http://lab.internal:4100' }).variables).toEqual(['LAB_URL']);
    expect(parseHuntConfig({ LAB_URL: 'http://lab.internal:4100', LAB_ALLOW_REMOTE: 'true' }, deps).labUrl).toBe('http://lab.internal:4100');
    expect(errorOf({ LAB_URL: 'http://169.254.169.254', LAB_ALLOW_REMOTE: 'true' }).variables).toEqual(['LAB_URL']);
    expect(errorOf({ LAB_URL: 'http://127.0.0.1:4100/lab' }).variables).toEqual(['LAB_URL']);
    expect(errorOf({ LAB_ALLOW_REMOTE: 'yes' }).variables).toEqual(['LAB_ALLOW_REMOTE']);
    expect(errorOf({ HUNTS_ENABLED: '1' }).variables).toEqual(['HUNTS_ENABLED']);
  });

  it('pins the model: a name, never auto', () => {
    expect(parseHuntConfig({ EXORCIST_MODEL: 'claude-haiku-4.5' }, deps).model).toBe('claude-haiku-4.5');
    for (const bad of ['auto', 'Claude Sonnet', 'a', '../x', '-bad']) expect(errorOf({ EXORCIST_MODEL: bad }).variables).toEqual(['EXORCIST_MODEL']);
  });

  it('bounds the caps, the timeout, the cooldown and the tool limit', () => {
    const cases: Array<[HuntVar, string]> = [
      ['HUNT_CREDIT_CAP', '0'],
      ['HUNT_CREDIT_CAP', '10.5'],
      ['HUNT_CREDIT_CAP', '-1'],
      ['HUNT_DAILY_CREDIT_CAP', '501'],
      ['HUNT_TIMEOUT_MS', '9999'],
      ['HUNT_TIMEOUT_MS', '300001'],
      ['HUNT_COOLDOWN_MS', '3600001'],
      ['HUNT_SETTLE_MS', '60001'],
      ['HUNT_SETTLE_MS', '-1'],
      ['HUNT_SETTLE_MS', '1.5'],
      ['HUNT_MAX_TOOL_CALLS', '2'],
      ['HUNT_MAX_TOOL_CALLS', '31'],
      ['HUNT_MAX_TOOL_CALLS', '1.5'],
      ['HUNT_WORKDIR', 'relative/dir'],
      ['HUNT_WORKDIR', '/a/../b'],
    ];
    for (const [name, value] of cases) expect(errorOf({ [name]: value }).variables, `${name}=${value}`).toEqual([name]);
    // The per-hunt cap may not be above the daily cap.
    expect(errorOf({ HUNT_CREDIT_CAP: '5', HUNT_DAILY_CREDIT_CAP: '4' }).variables).toEqual(['HUNT_CREDIT_CAP']);
    expect(parseHuntConfig({ HUNT_CREDIT_CAP: '4', HUNT_DAILY_CREDIT_CAP: '4' }, deps).creditCap).toBe(4);
    expect(isSafeWorkdir('/tmp/a b')).toBe(true);
    expect(isSafeWorkdir('/tmp/\0x')).toBe(false);
  });

  it('bounds HUNT_DAILY_MAX to 1 to 500 and reads it', () => {
    for (const bad of ['0', '501', '-1', '1.5', 'many']) expect(errorOf({ HUNT_DAILY_MAX: bad }).variables, bad).toEqual(['HUNT_DAILY_MAX']);
    expect(parseHuntConfig({ HUNT_DAILY_MAX: '1' }, deps).dailyMax).toBe(1);
    expect(parseHuntConfig({ HUNT_DAILY_MAX: '500' }, deps).dailyMax).toBe(500);
    expect(parseHuntConfig({}, deps).dailyMax).toBe(40);
  });

  describe('the working folder in production', () => {
    const prod = { ...on, NODE_ENV: 'production' };
    const me = { currentUid: () => 501 };
    const withStat = (st: { uid: number; mode: number } | null): HuntConfigDeps => ({ ...deps, ...me, statDir: () => st });

    it('needs HUNT_WORKDIR set when Hunts are on, and takes the temp default only in development', () => {
      expect(errorOf(prod, withStat(null)).variables).toEqual(['HUNT_WORKDIR']);
      expect(parseHuntConfig({ ...on, NODE_ENV: 'development' }, deps).workdir).toBe('/tmp/haunted-ops-hunts');
      expect(parseHuntConfig(on, deps).workdir).toBe('/tmp/haunted-ops-hunts');
    });

    it('takes a folder that does not exist yet, and one owned by this user with mode 0700', () => {
      expect(parseHuntConfig({ ...prod, HUNT_WORKDIR: '/srv/hunts' }, withStat(null)).workdir).toBe('/srv/hunts');
      expect(parseHuntConfig({ ...prod, HUNT_WORKDIR: '/srv/hunts' }, withStat({ uid: 501, mode: 0o40700 })).workdir).toBe('/srv/hunts');
    });

    it('refuses a folder of another user or with looser permissions, and names only the variable', () => {
      for (const st of [{ uid: 0, mode: 0o40700 }, { uid: 501, mode: 0o40755 }, { uid: 501, mode: 0o40770 }, { uid: 501, mode: 0o40500 }]) {
        const e = errorOf({ ...prod, HUNT_WORKDIR: '/srv/hunts' }, withStat(st));
        expect(e.variables).toEqual(['HUNT_WORKDIR']);
        expect(e.message).not.toContain('/srv/hunts');
      }
    });

    it('is not enforced when Hunts are off', () => {
      expect(parseHuntConfig({ NODE_ENV: 'production' }, withStat(null)).enabled).toBe(false);
    });
  });

  it('lists every bad variable in a stable order and never a value', () => {
    const e = errorOf({ HUNTS_ENABLED: 'maybe', LAB_URL: 'ftp://secret-host', HUNT_TIMEOUT_MS: 'abc', EXORCIST_MODEL: 'auto' });
    expect(e.variables).toEqual(['LAB_URL', 'HUNTS_ENABLED', 'EXORCIST_MODEL', 'HUNT_TIMEOUT_MS']);
    expect(e.message).toBe('Invalid configuration: LAB_URL, HUNTS_ENABLED, EXORCIST_MODEL, HUNT_TIMEOUT_MS');
    expect(e.message).not.toContain('secret-host');
  });
});

describe('.env.example', () => {
  it('lists every hunt variable with a placeholder, and no real-looking secret', () => {
    const text = readFileSync('../../.env.example', 'utf8');
    for (const name of HUNT_VARS) expect(new RegExp(`^(# )?${name}=`, 'm').test(text), name).toBe(true);
    for (const name of ['LAB_READ_TOKEN', 'HUNT_ADMIN_TOKEN']) expect(new RegExp(`^${name}=change-me`, 'm').test(text), name).toBe(true);
    // The example tokens must fail the validator, so a copied example cannot turn hunts on.
    const example = (name: string): string => (new RegExp(`^${name}=(.*)$`, 'm').exec(text)?.[1] ?? '').trim();
    expect(isTokenValid(example('LAB_READ_TOKEN'))).toBe(false);
    expect(isTokenValid(example('HUNT_ADMIN_TOKEN'))).toBe(false);
    expect(parseHuntConfig({ HUNTS_ENABLED: example('HUNTS_ENABLED'), LAB_URL: example('LAB_URL'), EXORCIST_MODEL: example('EXORCIST_MODEL') }, deps).enabled).toBe(false);
  });
});

describe('resolveExecutable', () => {
  it('finds an executable on PATH and refuses relative paths, folders and missing files', () => {
    const node = resolveExecutable('node', process.env.PATH);
    expect(node).not.toBeNull();
    expect(resolveExecutable(node as string, undefined)).toBe(node);
    expect(resolveExecutable('./node', process.env.PATH)).toBeNull();
    expect(resolveExecutable('/tmp', undefined)).toBeNull();
    expect(resolveExecutable('definitely-not-a-program-0123', process.env.PATH)).toBeNull();
    expect(resolveExecutable('node', 'relative/dir:')).toBeNull();
  });
});

// Feature: exorcist-agent, settings never leak a value
describe('Property: configuration errors name variables and never values', () => {
  const value = fc.oneof(fc.string({ maxLength: 40 }), fc.constantFrom('true', 'false', '1', '0', 'auto', '', ' ', 'http://127.0.0.1:4100', '/tmp/x', '30', '1.5'));
  const secretish = fc.stringMatching(/^[A-Za-z0-9]{24,40}$/).map((s) => `SECRET${s}`);
  it('holds for any environment', () => {
    fc.assert(
      fc.property(
        fc.record({ ...Object.fromEntries(HUNT_VARS.map((v) => [v, fc.option(value, { nil: undefined })])), LAB_READ_TOKEN: fc.option(secretish, { nil: undefined }), HUNT_ADMIN_TOKEN: fc.option(secretish, { nil: undefined }) }),
        (env) => {
          try {
            const c = parseHuntConfig(env, deps);
            // A valid configuration respects every bound.
            expect(c.creditCap).toBeLessThanOrEqual(c.dailyCreditCap);
            expect(c.timeoutMs).toBeGreaterThanOrEqual(10_000);
            expect(c.model).not.toBe('auto');
            if (c.enabled) expect(c.labReadToken !== null && c.adminToken !== null && c.labReadToken !== c.adminToken).toBe(true);
          } catch (err) {
            expect(err).toBeInstanceOf(HuntConfigError);
            const e = err as HuntConfigError;
            expect(e.variables.length).toBeGreaterThan(0);
            expect(e.message).toBe(`Invalid configuration: ${e.variables.join(', ')}`);
            for (const v of Object.values(env)) if (typeof v === 'string' && v.length >= 6) expect(e.message.includes(v)).toBe(false);
            const order = HUNT_VARS.filter((v) => e.variables.includes(v));
            expect([...e.variables]).toEqual(order);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
