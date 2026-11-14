import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** A local stand-in for the Lab repo: a bare "remote", `main`, a scenario branch whose head is the culprit commit. */
export interface LabRepo {
  root: string;
  /** The bare repository that plays GitHub's git side. */
  remote: string;
  work: string;
  /** Head of `main` (the healthy commit). */
  main: string;
  /** The culprit commit C: removes a guard in `services/payments/src/charge.js`. It is also the scenario head D. */
  culprit: string;
  /** The deployed commit D: the head of `scenario/error-spike`. */
  base: string;
  /** A second scenario commit that changes another service, for chain tests. */
  other: string;
  cleanup(): void;
}

const HEALTHY = `export function chargeAmount(order) {
  if (!order || typeof order.amount !== 'number') return 0;
  return Math.round(order.amount * 100);
}
`;
const BROKEN = `export function chargeAmount(order) {
  return Math.round(order.amount * 100);
}
`;
const TEST = `import test from 'node:test';
import assert from 'node:assert/strict';
import { chargeAmount } from '../src/charge.js';

test('a missing order charges nothing', () => {
  assert.equal(chargeAmount(undefined), 0);
});

test('an amount is charged in cents', () => {
  assert.equal(chargeAmount({ amount: 1.5 }), 150);
});
`;

export const HEALTHY_CHARGE = HEALTHY;
export const BROKEN_CHARGE = BROKEN;
export const CHARGE_TEST = TEST;

/** Fixed authors and dates, so every SHA is the same on every run. */
const AT = (n: number): string => new Date(Date.UTC(2026, 10, 10, 10, n, 0)).toISOString();

export function makeLabRepo(): LabRepo {
  const root = mkdtempSync(join(tmpdir(), 'lab-repo-'));
  const remote = join(root, 'remote.git');
  const work = join(root, 'work');
  const git = (cwd: string, args: string[], date?: string): string =>
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
      cwd,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: root,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'Lab Author',
        GIT_AUTHOR_EMAIL: 'lab@example.invalid',
        GIT_COMMITTER_NAME: 'Lab Author',
        GIT_COMMITTER_EMAIL: 'lab@example.invalid',
        ...(date === undefined ? {} : { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }),
      },
    }).trim();
  const put = (rel: string, text: string): void => {
    mkdirSync(dirname(join(work, rel)), { recursive: true });
    writeFileSync(join(work, rel), text);
  };
  mkdirSync(work);
  git(work, ['init', '--quiet', '--initial-branch=main']);
  put('services/payments/package.json', '{ "name": "payments", "type": "module" }\n');
  put('services/payments/src/charge.js', HEALTHY);
  put('services/payments/src/index.js', "export { chargeAmount } from './charge.js';\n");
  put('services/payments/test/charge.test.js', TEST);
  put('services/orders/src/index.js', "export const name = 'orders';\n");
  put('packages/lab-common/index.js', "export const version = 1;\n");
  git(work, ['add', '-A']);
  git(work, ['commit', '--quiet', '-m', 'healthy lab'], AT(0));
  const main = git(work, ['rev-parse', 'HEAD']);
  git(work, ['checkout', '--quiet', '-b', 'scenario/error-spike']);
  put('services/payments/src/charge.js', BROKEN);
  git(work, ['add', '-A']);
  git(work, ['commit', '--quiet', '-m', 'simplify charge lookup'], AT(1));
  const culprit = git(work, ['rev-parse', 'HEAD']);
  git(work, ['checkout', '--quiet', '-b', 'scenario/other', main]);
  put('services/orders/src/index.js', "export const name = 'orders v2';\n");
  git(work, ['add', '-A']);
  git(work, ['commit', '--quiet', '-m', 'rename orders'], AT(2));
  const other = git(work, ['rev-parse', 'HEAD']);
  git(work, ['init', '--quiet', '--bare', '--initial-branch=main', remote]);
  git(work, ['push', '--quiet', remote, 'main:refs/heads/main', 'scenario/error-spike:refs/heads/scenario/error-spike', 'scenario/other:refs/heads/scenario/other']);
  return { root, remote, work, main, culprit, base: culprit, other, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** `syncRefs` for the fake GitHub: its branches are the heads of the local bare repository. */
export function syncRefsFrom(remote: string): (refs: Map<string, string>) => void {
  return (refs) => {
    const out = execFileSync('git', ['-C', remote, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null' } });
    refs.clear();
    for (const line of out.trim().split('\n')) {
      const [name, sha] = line.split(' ');
      if (name !== undefined && sha !== undefined) refs.set(name.slice('refs/heads/'.length), sha);
    }
  };
}

/** `onDeleteRef` for the fake GitHub: deletes the branch from the local bare repository. */
export function deleteRefIn(remote: string): (name: string) => void {
  return (name) => {
    execFileSync('git', ['-C', remote, 'update-ref', '-d', `refs/heads/${name}`], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null' } });
  };
}

/** Runs git in a repository with fixed authors, for tests that build more history. */
export function gitIn(cwd: string, args: string[], date = AT(5)): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: cwd,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Lab Author',
      GIT_AUTHOR_EMAIL: 'lab@example.invalid',
      GIT_COMMITTER_NAME: 'Lab Author',
      GIT_COMMITTER_EMAIL: 'lab@example.invalid',
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    },
  }).trim();
}
