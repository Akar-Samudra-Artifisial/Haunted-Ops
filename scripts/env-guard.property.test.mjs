// deploy/server/env-guard.sh passes only when the guard exits 0 AND prints `env ok: <profile>`, through a symlinked release.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
const REPO = fileURLToPath(new URL('..', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'env-guard-prop-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const real = join(dir, 'release');
mkdirSync(join(real, 'deploy/server'), { recursive: true });
mkdirSync(join(real, 'scripts'), { recursive: true });
writeFileSync(join(real, 'deploy/server/env-guard.sh'), readFileSync(join(REPO, 'deploy/server/env-guard.sh'), 'utf8'), { mode: 0o755 });
// A stand-in guard: it prints the lines and exits with the status it is given (through the environment, never a file value).
writeFileSync(join(real, 'scripts/demo-env-check.mjs'), "for (const l of JSON.parse(process.env.STUB_LINES)) process.stderr.write(`${l}\\n`);\nprocess.exit(Number(process.env.STUB_STATUS));\n");
const link = join(dir, 'current');
symlinkSync(real, link);
const envFile = join(dir, 'x.env');
writeFileSync(envFile, 'A=1\n');
const PROFILES = ['api', 'lab', 'kiro'];
const lineArb = fc.oneof(
  fc.constantFrom(...PROFILES).map((p) => `env ok: ${p}`),
  fc.constantFrom(...PROFILES).map((p) => ` env ok: ${p}`),
  fc.constantFrom(...PROFILES).map((p) => `env ok: ${p}x`),
  fc.constantFrom('demo-env-check: ok (api)', 'demo-env-check: refused: EXTRA', ''),
);
// Feature: deploy-demo, Property 5
test('Property 5: env-guard.sh exits 0 exactly when the guard exits 0 and prints the ok line of the profile', () => {
  fc.assert(
    fc.property(fc.constantFrom(...PROFILES), fc.array(lineArb, { maxLength: 3 }), fc.constantFrom(0, 0, 1, 2), (profile, lines, status) => {
      const res = spawnSync('bash', [join(link, 'deploy/server/env-guard.sh'), '--node', process.execPath, envFile, profile], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '', STUB_LINES: JSON.stringify(lines), STUB_STATUS: String(status) },
      });
      const expected = status === 0 && lines.includes(`env ok: ${profile}`) ? 0 : 1;
      assert.equal(res.status, expected, `${profile} ${status} ${JSON.stringify(lines)}: ${res.stderr}`);
    }),
    { numRuns: 100 },
  );
});
// Feature: deploy-demo, Property 6
test('Property 6: the key reading of the pre-flight run under bash -x prints no key', () => {
  const pre = readFileSync(join(REPO, 'deploy/server/preflight.sh'), 'utf8');
  const fn = /^kiro_whoami_key\(\) \([\s\S]*?\n\)\n/m.exec(pre)?.[0];
  assert.ok(fn, 'kiro_whoami_key is in the pre-flight');
  const body = fn.replaceAll('/usr/local/bin/node', `'${process.execPath}'`);
  // kiro-cli (runuser) is a function that does nothing; the real reader reads the key file. No network, no kiro-cli.
  const script = `CURRENT='${REPO.replace(/\/$/, '')}'\nKIRO_ENV='${join(dir, 'kiro.env')}'\nrunuser() { :; }\n${body}kiro_whoami_key\n`;
  // A key the guard accepts: printable ASCII without quotes, a backslash or spaces; a fixed prefix keeps it from matching trace text by chance.
  const keyArb = fc.stringMatching(/^[A-Za-z0-9._~+/=:@%^*-]{20,80}$/).map((s) => `kt-${s}`);
  fc.assert(
    fc.property(keyArb, (key) => {
      writeFileSync(join(dir, 'kiro.env'), `KIRO_API_KEY=${key}\n`);
      const res = spawnSync('bash', ['-x', '-c', script], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
      assert.equal(res.status, 0, res.stderr);
      assert.ok(!res.stderr.includes(key) && !res.stdout.includes(key), 'the key is in the trace');
    }),
    { numRuns: 100 },
  );
});
