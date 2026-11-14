import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { FIX_VARS, FixConfigError, FIX_DEFAULTS, isGithubToken, nodeMajor, parseFixConfig, type FixConfigDeps, type FixVar } from './fix-config.js';

// A dummy token that only has the right form. It is not a real credential.
const TOKEN = 'github_pat_DUMMYdummyDUMMYdummy0123456789';
const CHAOS = 'chaos-token-0123456789-abcdefghij';
const hunts = { enabled: true, adminToken: 'hunt-admin-token-0123456789-abcd', labReadToken: 'lab-read-token-0123456789-abcdef', workdir: '/tmp/h', kiroCliPath: '/opt/kiro-cli', labAllowRemote: false };
const deps: FixConfigDeps = { resolveExecutable: (n) => (n === 'git' ? '/usr/bin/git' : null), tmpDir: () => '/tmp', currentUid: () => 501, statDir: () => null };
const on = { FIX_ENABLED: 'true', GITHUB_TOKEN: TOKEN, LAB_GITHUB_REPO: 'Akar-Samudra-Artifisial/Haunted-Lab', CHAOS_TOKEN: CHAOS, WEB_ORIGIN: 'http://localhost:5173' };

const errorOf = (env: Record<string, string | undefined>, h = hunts, d = deps): FixConfigError => {
  try {
    parseFixConfig(env, h, d);
  } catch (err) {
    if (err instanceof FixConfigError) return err;
    throw err;
  }
  throw new Error('expected a FixConfigError');
};

describe('parseFixConfig', () => {
  it('is off with safe defaults and needs nothing when off', () => {
    const c = parseFixConfig({}, { ...hunts, enabled: false }, deps);
    expect(c).toEqual({
      enabled: false,
      githubToken: null,
      repo: null,
      chaosUrl: FIX_DEFAULTS.chaosUrl,
      chaosToken: null,
      webOrigin: null,
      gitPath: 'git',
      model: 'claude-sonnet-5.5',
      creditCap: 1.5,
      timeoutMs: 120_000,
      maxToolCalls: 30,
      testTimeoutMs: 90_000,
      requireTests: true,
      pollMs: 30_000,
      branchTtlDays: 7,
      deployConfirmMs: 300_000,
      workdir: '/tmp/haunted-ops-fix',
    });
    expect(Object.isFrozen(c)).toBe(true);
  });

  it('turns on with everything set and resolves git', () => {
    const c = parseFixConfig({ ...on, FIX_CREDIT_CAP: '2', FIX_TIMEOUT_MS: '60000', FIX_MAX_TOOL_CALLS: '10', FIX_REQUIRE_TESTS: 'false', FIX_WORKDIR: '/var/fix' }, hunts, deps);
    expect(c).toMatchObject({ enabled: true, githubToken: TOKEN, repo: 'Akar-Samudra-Artifisial/Haunted-Lab', chaosToken: CHAOS, gitPath: '/usr/bin/git', creditCap: 2, timeoutMs: 60_000, maxToolCalls: 10, requireTests: false, workdir: '/var/fix', webOrigin: 'http://localhost:5173' });
  });

  it('requires the Hunt settings, the token, the repository, the chaos token, WEB_ORIGIN and git when on', () => {
    expect(errorOf({ ...on }, { ...hunts, enabled: false }).variables).toEqual(['FIX_ENABLED']);
    expect(errorOf({ FIX_ENABLED: 'true' }).variables).toEqual(['GITHUB_TOKEN', 'LAB_GITHUB_REPO', 'CHAOS_TOKEN', 'WEB_ORIGIN']);
    expect(errorOf(on, hunts, { ...deps, resolveExecutable: () => null }).variables).toEqual(['FIX_ENABLED']);
  });

  it('reads FIX_DEPLOY_CONFIRM_MS, five minutes by default', () => {
    expect(parseFixConfig(on, hunts, deps).deployConfirmMs).toBe(300_000);
    expect(parseFixConfig({ ...on, FIX_DEPLOY_CONFIRM_MS: '120000' }, hunts, deps).deployConfirmMs).toBe(120_000);
  });

  it('refuses FIX_ENABLED=true on a Node without the network gate of --permission (before 25), and says nothing when off', () => {
    expect(nodeMajor('24.11.0')).toBe(24);
    expect(nodeMajor('v26.7.0')).toBe(26);
    expect(errorOf(on, hunts, { ...deps, nodeVersion: '24.11.0' }).variables).toEqual(['FIX_ENABLED']);
    expect(parseFixConfig(on, hunts, { ...deps, nodeVersion: '25.0.0' }).enabled).toBe(true);
    expect(parseFixConfig({}, { ...hunts, enabled: false }, { ...deps, nodeVersion: '22.0.0' }).enabled).toBe(false);
  });

  it('accepts only a fine-grained token, even when off', () => {
    expect(isGithubToken(TOKEN)).toBe(true);
    for (const bad of ['ghp_' + 'a'.repeat(36), 'gho_' + 'a'.repeat(36), 'ghs_' + 'a'.repeat(36), 'github_pat_short', 'change-me-use-a-github-token', `${TOKEN} x`, 'github_pat_' + 'a'.repeat(300), '']) {
      expect(isGithubToken(bad), bad).toBe(false);
    }
    expect(errorOf({ GITHUB_TOKEN: 'ghp_' + 'a'.repeat(36) }, { ...hunts, enabled: false }).variables).toEqual(['GITHUB_TOKEN']);
  });

  it('checks the repository, the chaos URL and the chaos token', () => {
    for (const bad of ['owner', 'a/b/c', '../x', 'a b/c', 'https://github.com/a/b']) expect(errorOf({ ...on, LAB_GITHUB_REPO: bad }).variables, bad).toEqual(['LAB_GITHUB_REPO']);
    expect(errorOf({ ...on, CHAOS_URL: 'http://lab.internal:4100' }).variables).toEqual(['CHAOS_URL']);
    expect(parseFixConfig({ ...on, CHAOS_URL: 'http://lab.internal:4100' }, { ...hunts, labAllowRemote: true }, deps).chaosUrl).toBe('http://lab.internal:4100');
    expect(errorOf({ ...on, CHAOS_URL: 'http://169.254.169.254' }, { ...hunts, labAllowRemote: true }).variables).toEqual(['CHAOS_URL']);
    for (const bad of ['short', 'change-me-use-the-lab-chaos-token', hunts.adminToken, hunts.labReadToken]) expect(errorOf({ ...on, CHAOS_TOKEN: bad }).variables, bad).toEqual(['CHAOS_TOKEN']);
  });

  it('pins the model and bounds every number', () => {
    for (const bad of ['auto', 'Claude Sonnet', 'a', '-bad']) expect(errorOf({ FIX_MODEL: bad }, { ...hunts, enabled: false }).variables).toEqual(['FIX_MODEL']);
    const cases: Array<[FixVar, string]> = [
      ['FIX_CREDIT_CAP', '0'],
      ['FIX_CREDIT_CAP', '10.5'],
      ['FIX_TIMEOUT_MS', '9999'],
      ['FIX_TIMEOUT_MS', '300001'],
      ['FIX_MAX_TOOL_CALLS', '2'],
      ['FIX_MAX_TOOL_CALLS', '61'],
      ['FIX_TEST_TIMEOUT_MS', '9999'],
      ['FIX_TEST_TIMEOUT_MS', '1.5'],
      ['FIX_POLL_MS', '4999'],
      ['FIX_POLL_MS', '300001'],
      ['FIX_BRANCH_TTL_DAYS', '0'],
      ['FIX_BRANCH_TTL_DAYS', '61'],
      ['FIX_DEPLOY_CONFIRM_MS', '9999'],
      ['FIX_DEPLOY_CONFIRM_MS', '3600001'],
      ['FIX_REQUIRE_TESTS', 'yes'],
      ['FIX_ENABLED', 'maybe'],
      ['FIX_WORKDIR', 'relative'],
      ['FIX_WORKDIR', '/a/../b'],
    ];
    for (const [name, value] of cases) expect(errorOf({ [name]: value }, { ...hunts, enabled: false }).variables, `${name}=${value}`).toEqual([name]);
  });

  describe('the folder in production', () => {
    const prod = { ...on, NODE_ENV: 'production' };
    it('is required and must be private and ours when an existing folder', () => {
      expect(errorOf(prod).variables).toEqual(['FIX_WORKDIR']);
      expect(parseFixConfig({ ...prod, FIX_WORKDIR: '/srv/fix' }, hunts, deps).workdir).toBe('/srv/fix');
      expect(parseFixConfig({ ...prod, FIX_WORKDIR: '/srv/fix' }, hunts, { ...deps, statDir: () => ({ uid: 501, mode: 0o40700 }) }).workdir).toBe('/srv/fix');
      for (const st of [{ uid: 0, mode: 0o40700 }, { uid: 501, mode: 0o40755 }]) {
        const e = errorOf({ ...prod, FIX_WORKDIR: '/srv/fix' }, hunts, { ...deps, statDir: () => st });
        expect(e.variables).toEqual(['FIX_WORKDIR']);
        expect(e.message).not.toContain('/srv/fix');
      }
      expect(parseFixConfig({ NODE_ENV: 'production' }, { ...hunts, enabled: false }, deps).enabled).toBe(false);
    });
  });

  it('lists every bad variable in a stable order and never a value', () => {
    const e = errorOf({ FIX_ENABLED: 'maybe', GITHUB_TOKEN: 'ghp_secretsecretsecretsecretsecretsecret', FIX_TIMEOUT_MS: 'abc', FIX_MODEL: 'auto' }, { ...hunts, enabled: false });
    expect(e.variables).toEqual(['FIX_ENABLED', 'GITHUB_TOKEN', 'FIX_MODEL', 'FIX_TIMEOUT_MS']);
    expect(e.message).toBe('Invalid configuration: FIX_ENABLED, GITHUB_TOKEN, FIX_MODEL, FIX_TIMEOUT_MS');
    expect(e.message).not.toContain('secretsecret');
  });
});

describe('.env.example', () => {
  it('lists every fix variable with a placeholder and no real-looking secret', () => {
    const text = readFileSync('../../.env.example', 'utf8');
    for (const name of FIX_VARS) {
      if (name === 'WEB_ORIGIN') continue;
      expect(new RegExp(`^(# )?${name}=`, 'm').test(text), name).toBe(true);
    }
    expect(/^GITHUB_TOKEN=|^# GITHUB_TOKEN=github_pat_change-me$/m.test(text)).toBe(true);
    expect(isGithubToken('github_pat_change-me')).toBe(false);
    expect(/github_pat_[A-Za-z0-9_]{22,}/.test(text)).toBe(false);
    expect(/^FIX_ENABLED=false$/m.test(text)).toBe(true);
  });
});

// Feature: fix-proposal-flow, Property 15
describe('Property 15: the token setting accepts only a fine-grained token and names variables, not values', () => {
  const body = fc.stringMatching(/^[A-Za-z0-9_]{22,60}$/);
  it('accepts exactly the fine-grained form', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          body.map((b) => `github_pat_${b}`),
          body.map((b) => `ghp_${b}`),
          body.map((b) => `gho_${b}`),
          fc.string({ maxLength: 50 }),
          body.map((b) => `github_pat_${b} `),
          body.map((b) => `change-me-${b}`),
        ),
        (value) => {
          const expected = /^github_pat_[A-Za-z0-9_]{22,255}$/.test(value);
          expect(isGithubToken(value)).toBe(expected);
          let accepted: boolean;
          let message = '';
          try {
            accepted = parseFixConfig({ GITHUB_TOKEN: value }, { ...hunts, enabled: false }, deps).githubToken === value;
          } catch (err) {
            accepted = false;
            message = (err as Error).message;
          }
          // The value is read as "unset" when blank; every other value is accepted iff it has the form.
          if (value.trim() !== '') expect(accepted).toBe(expected);
          if (!accepted && value.trim() !== '' && value.length >= 6) expect(message.includes(value)).toBe(false);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('holds for any environment: valid configurations respect the bounds, errors name variables in order', () => {
    const value = fc.oneof(fc.string({ maxLength: 40 }), fc.constantFrom('true', 'false', '1', '0', 'auto', '', ' ', '/tmp/x', '30', '1.5', 'owner/name'));
    fc.assert(
      fc.property(fc.record(Object.fromEntries(FIX_VARS.map((v) => [v, fc.option(value, { nil: undefined })]))), (env) => {
        try {
          const c = parseFixConfig(env, hunts, deps);
          expect(c.creditCap).toBeGreaterThanOrEqual(0.1);
          expect(c.timeoutMs).toBeGreaterThanOrEqual(10_000);
          expect(c.model).not.toBe('auto');
          if (c.enabled) expect(c.githubToken !== null && c.repo !== null && c.chaosToken !== null && c.webOrigin !== null).toBe(true);
          if (c.githubToken !== null) expect(isGithubToken(c.githubToken)).toBe(true);
        } catch (err) {
          expect(err).toBeInstanceOf(FixConfigError);
          const e = err as FixConfigError;
          expect(e.message).toBe(`Invalid configuration: ${e.variables.join(', ')}`);
          expect([...e.variables]).toEqual(FIX_VARS.filter((v) => e.variables.includes(v)));
          for (const v of Object.values(env)) if (typeof v === 'string' && v.length >= 6) expect(e.message.includes(v)).toBe(false);
        }
      }),
      { numRuns: 300 },
    );
  });
});
