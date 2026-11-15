// Static checks of the deploy files: systemd units, the timer, the Caddyfile, nftables, the env examples and the shell files.
// Nothing here runs a unit, Caddy or nft; those are checked on the server (deploy/server/preflight.sh).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseEnvText } from './demo-env-check.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEPLOY = join(ROOT, 'deploy');
const SERVER = join(DEPLOY, 'server');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
/** The commands of a shell file: whole-line comments and trailing comments removed. */
const commands = (rel) => read(rel).replace(/^\s*#.*$/gm, '').replace(/\s#\s.*$/gm, '');

function walk(dir) {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const full = join(dir, name);
      if (name === 'out') return [];
      return statSync(full).isDirectory() ? walk(full) : [full];
    });
}
const deployFiles = walk(DEPLOY);
const shellFiles = deployFiles.filter((f) => f.endsWith('.sh'));

/** Parses a systemd unit into { section: [[key, value], ...] }. */
function parseUnit(text) {
  const out = {};
  let section = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const m = /^\[(.+)\]$/.exec(line);
    if (m) {
      section = m[1];
      out[section] ??= [];
      continue;
    }
    const eq = line.indexOf('=');
    out[section].push([line.slice(0, eq), line.slice(eq + 1)]);
  }
  return out;
}
const values = (unit, section, key) => (unit[section] ?? []).filter(([k]) => k === key).map(([, v]) => v);
const one = (unit, section, key) => {
  const v = values(unit, section, key);
  return v[v.length - 1];
};

const SERVICES = ['haunted-api.service', 'haunted-lab.service', 'haunted-scenario.service'];

test('every service unit has a non-root User, MemoryMax, NoNewPrivileges and ProtectSystem=strict', () => {
  const found = readdirSync(join(SERVER, 'systemd')).filter((f) => f.endsWith('.service'));
  assert.deepEqual(found.sort(), [...SERVICES].sort());
  for (const name of SERVICES) {
    const unit = parseUnit(read(`deploy/server/systemd/${name}`));
    const user = one(unit, 'Service', 'User');
    assert.ok(user && user !== 'root' && user !== '0', `${name}: User`);
    assert.match(one(unit, 'Service', 'MemoryMax') ?? '', /^\d+[KMG]$/, `${name}: MemoryMax`);
    assert.equal(one(unit, 'Service', 'NoNewPrivileges'), 'yes', `${name}: NoNewPrivileges`);
    assert.equal(one(unit, 'Service', 'ProtectSystem'), 'strict', `${name}: ProtectSystem`);
    assert.equal(one(unit, 'Service', 'ProtectHome'), 'yes', `${name}: ProtectHome`);
    assert.equal(one(unit, 'Service', 'PrivateTmp'), 'yes', `${name}: PrivateTmp`);
    const settings = read(`deploy/server/systemd/${name}`).replace(/^\s*#.*$/gm, '');
    assert.ok(!/GITHUB_TOKEN|FIX_ENABLED=true|FIX_RUN_AS_USER/.test(settings), `${name}: no fix setting`);
  }
});

test('the API unit: user hops, production, env file, guard first, 1G, 256 tasks, writes only in the home of hops', () => {
  const unit = parseUnit(read('deploy/server/systemd/haunted-api.service'));
  assert.equal(one(unit, 'Service', 'User'), 'hops');
  assert.ok(values(unit, 'Service', 'Environment').includes('NODE_ENV=production'));
  // api.env first, then the optional Kiro API key file (the "-" makes it optional). Only the API unit loads it.
  assert.deepEqual(values(unit, 'Service', 'EnvironmentFile'), ['/etc/haunted/api.env', '-/etc/haunted/kiro.env']);
  for (const other of ['haunted-lab.service', 'haunted-scenario.service']) {
    assert.ok(!read(`deploy/server/systemd/${other}`).includes('kiro.env'), `${other} does not load the key file`);
    assert.ok(!values(parseUnit(read(`deploy/server/systemd/${other}`)), 'Service', 'EnvironmentFile').some((f) => f.includes('kiro')), `${other}: EnvironmentFile`);
  }
  assert.equal(one(unit, 'Service', 'MemoryMax'), '1G');
  assert.equal(one(unit, 'Service', 'TasksMax'), '256');
  assert.equal(one(unit, 'Service', 'Restart'), 'on-failure');
  assert.deepEqual(values(unit, 'Service', 'ReadWritePaths'), ['/var/lib/hops']);
  const pre = values(unit, 'Service', 'ExecStartPre');
  assert.equal(pre.length, 2);
  assert.match(pre[0] ?? '', /^\/usr\/local\/bin\/node \S+\/demo-env-check\.mjs \/etc\/haunted\/api\.env api$/);
  // The key file is root:root 0600, so its guard runs as root ("+"); hops could not read it.
  assert.match(pre[1] ?? '', /^\+\/usr\/local\/bin\/node \S+\/demo-env-check\.mjs \/etc\/haunted\/kiro\.env kiro$/);
  assert.match(one(unit, 'Service', 'ExecStart') ?? '', /apps\/api\/dist\/main\.js$/);
  const home = values(unit, 'Service', 'Environment').find((e) => e.startsWith('HOME='));
  assert.equal(home, 'HOME=/var/lib/hops');
});

test('the lab unit: user hlab, 512M, production, guard first, writes only in its state folder', () => {
  const unit = parseUnit(read('deploy/server/systemd/haunted-lab.service'));
  assert.equal(one(unit, 'Service', 'User'), 'hlab');
  assert.equal(one(unit, 'Service', 'MemoryMax'), '512M');
  assert.ok(values(unit, 'Service', 'Environment').includes('NODE_ENV=production'));
  assert.deepEqual(values(unit, 'Service', 'ReadWritePaths'), ['/var/lib/haunted-lab']);
  assert.match(one(unit, 'Service', 'ExecStartPre') ?? '', /demo-env-check\.mjs \/etc\/haunted\/lab\.env lab$/);
});

test('the scenario service: apply, wait and reset, at most 30 minutes, reset on stop', () => {
  const unit = parseUnit(read('deploy/server/systemd/haunted-scenario.service'));
  assert.equal(one(unit, 'Service', 'RuntimeMaxSec'), '30min');
  assert.match(one(unit, 'Service', 'ExecStart') ?? '', /scenario\.sh run$/);
  assert.match(one(unit, 'Service', 'ExecStopPost') ?? '', /scenario\.sh reset$/);
  const script = read('deploy/server/scenario.sh');
  assert.match(script, /SCENARIOS=\(error-spike fog dark-room\)/);
  assert.match(script, /\/var\/lib\/haunted\/scenario-next/);
  assert.match(script, /WAIT_SECONDS:-1200/);
  assert.match(script, /\/chaos\/reset/);
  assert.ok(!/Bearer \$CHAOS_TOKEN"? *\\?$/m.test(script.split('\n').filter((l) => l.includes('curl')).join('\n')), 'the token is not a curl argument');
});

test('the timer fires exactly 3 times a day at 01:00, 09:00 and 17:00 UTC, not persistent, no random delay', () => {
  const unit = parseUnit(read('deploy/server/systemd/haunted-scenario.timer'));
  const calendars = values(unit, 'Timer', 'OnCalendar');
  assert.deepEqual(calendars, ['*-*-* 01:00:00 UTC', '*-*-* 09:00:00 UTC', '*-*-* 17:00:00 UTC']);
  // Each expression names one hour and one minute: one fire each, three a day.
  const fires = new Set(calendars.map((c) => /^\*-\*-\* (\d{2}):(\d{2}):00 UTC$/.exec(c)).map((m) => `${m[1]}:${m[2]}`));
  assert.equal(fires.size, 3);
  assert.equal(one(unit, 'Timer', 'Persistent'), 'false');
  assert.equal(one(unit, 'Timer', 'RandomizedDelaySec'), '0');
  for (const key of ['OnBootSec', 'OnUnitActiveSec', 'OnActiveSec', 'OnStartupSec', 'OnUnitInactiveSec']) {
    assert.deepEqual(values(unit, 'Timer', key), [], `no ${key}`);
  }
});

test('Prometheus listens on loopback with 24 h retention and 256M; the scrape stays at 5 s on 127.0.0.1', () => {
  const dropin = read('deploy/server/systemd/dropins/prometheus.service.d/haunted.conf');
  assert.match(dropin, /--web\.listen-address=127\.0\.0\.1:9090/);
  assert.match(dropin, /--storage\.tsdb\.retention\.time=24h/);
  assert.match(dropin, /^MemoryMax=256M$/m);
  const yml = read('deploy/server/prometheus/prometheus.yml');
  assert.match(yml, /scrape_interval: 5s/);
  const targets = JSON.parse(read('deploy/server/prometheus/targets/lab.json'));
  assert.deepEqual(
    targets.map((t) => [t.targets[0], t.labels.service]),
    [
      ['127.0.0.1:4001', 'gate'],
      ['127.0.0.1:4002', 'orders'],
      ['127.0.0.1:4003', 'payments'],
      ['127.0.0.1:4004', 'ledger'],
    ],
  );
  const pg = read('deploy/server/postgres/haunted.conf');
  assert.match(pg, /^listen_addresses = '127\.0\.0\.1'$/m);
  assert.match(pg, /^shared_buffers = \d+MB$/m);
});

test('the Caddyfile: method block, SSE proxy, fallback, no browse, headers, log without queries', () => {
  const caddy = read('deploy/server/Caddyfile');
  assert.match(caddy, /^\{\$HAUNTED_DOMAIN\} \{$/m);
  assert.match(caddy, /@write \{\s*path \/api\/\* \/healthz\s*not method GET HEAD\s*\}/);
  assert.match(caddy, /handle @write \{[^}]*respond "method not allowed" 405/);
  assert.match(caddy, /header Allow "GET, HEAD"/);
  assert.match(caddy, /reverse_proxy 127\.0\.0\.1:\{\$HAUNTED_API_PORT:3000\} \{\s*flush_interval -1\s*\}/);
  assert.match(caddy, /try_files \{path\} \/index\.html/);
  assert.match(caddy, /root \* \/opt\/haunted-ops\/current\/apps\/web\/dist/);
  assert.ok(!/\bbrowse\b/.test(caddy.replace(/#.*$/gm, '')), 'no directory listing');
  assert.match(caddy, /@hidden path \/\.vite \/\.vite\/\*/);
  for (const h of ['Content-Security-Policy', 'X-Content-Type-Options', 'Referrer-Policy', 'Strict-Transport-Security', 'X-Frame-Options', 'Permissions-Policy']) {
    assert.match(caddy, new RegExp(`^\\t\\t${h} "`, 'm'), h);
  }
  assert.match(caddy, /request>uri regexp `\\\?\.\*` ""/);
  assert.match(caddy, /request>headers delete/);
  // The method block comes before the proxy, so Caddy answers first.
  assert.ok(caddy.indexOf('handle @write') < caddy.indexOf('handle @api'));
});

test('the Caddyfile header block: Caddy 2.6 form (defer, plain field names, no ">" prefix) and the pinned minimum version', () => {
  const caddy = read('deploy/server/Caddyfile');
  const block = /^\theader \{\n([\s\S]*?)\n\t\}$/m.exec(caddy)?.[1];
  assert.ok(block, 'the header block is found');
  const lines = block.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  assert.equal(lines[0], 'defer', 'the header operations are deferred, so they replace the headers of the API');
  for (const line of lines) assert.ok(!line.startsWith('>'), `no ">" prefix (Caddy 2.6 does not know it): ${line}`);
  assert.ok(lines.includes('-Server'));
  assert.equal(lines.filter((l) => /^[A-Z][A-Za-z-]+ "/.test(l)).length, 6, 'the six security headers');
  const min = parseEnvText(read('deploy/server/versions.env')).vars.CADDY_MIN_VERSION ?? '';
  assert.match(min, /^2\.6\.\d+$/, 'versions.env names the Caddy version the Caddyfile is written for');
  const pre = commands('deploy/server/preflight.sh');
  assert.match(pre, /CADDY_MIN_VERSION/);
  assert.match(pre, /caddy version/);
  assert.match(pre, /check "Caddy is at least the version of the Caddyfile" caddy_recent/);
});
test('Prometheus: the storage path of the drop-in is the folder install.sh hands to the prometheus user, on every run', () => {
  const dropin = read('deploy/server/systemd/dropins/prometheus.service.d/haunted.conf');
  const path = /--storage\.tsdb\.path=(\/var\/lib\/[^\s]+)/.exec(dropin)?.[1];
  assert.ok(path, 'the drop-in names a storage path');
  const sh = commands('deploy/server/install.sh');
  // install.sh reads the path from the drop-in itself, so the two cannot differ.
  assert.match(sh, /PROM_DIR="\$\(sed -n 's\|\^\.\*--storage\\\.tsdb\\\.path=.*"\$SRC\/systemd\/dropins\/prometheus\.service\.d\/haunted\.conf"/);
  assert.match(sh, /install -d -m 0750 -o prometheus -g prometheus "\$PROM_DIR"/);
  assert.match(sh, /"\$\(stat -c '%U:%G %a' "\$PROM_DIR"\)" != "prometheus:prometheus 750"/);
  assert.ok(sh.indexOf('install -d -m 0750 -o prometheus') < sh.indexOf('systemctl restart prometheus'), 'the folder is handed over before Prometheus starts');
  // The sed of install.sh gives the same answer as the test reads from the drop-in.
  const res = spawnSync('sed', ['-n', 's|^.*--storage\\.tsdb\\.path=\\([^ ]*\\).*$|\\1|p', join(SERVER, 'systemd/dropins/prometheus.service.d/haunted.conf')], { encoding: 'utf8' });
  assert.equal(res.stdout.trim(), path);
  assert.match(commands('deploy/server/preflight.sh'), /check "Prometheus answers \/-\/ready" curl --fail --silent --max-time 5 http:\/\/127\.0\.0\.1:9090\/-\/ready/);
});
test('Kiro API key file: install.sh only fixes owner and mode, never writes or prints it; preflight checks the method and the mode', () => {
  const sh = commands('deploy/server/install.sh');
  const block = /if \[ -f \/etc\/haunted\/kiro\.env \][\s\S]*?\nfi\n/.exec(sh)?.[0] ?? '';
  assert.ok(block, 'install.sh has a block for kiro.env that runs only when the file exists');
  assert.match(block, /chmod 0600 \/etc\/haunted\/kiro\.env/);
  assert.match(block, /chown root:root \/etc\/haunted\/kiro\.env/);
  assert.match(block, /demo-env-check\.mjs" \/etc\/haunted\/kiro\.env kiro/);
  // No write, copy, redirect into, echo or template of the file anywhere in the script.
  assert.ok(!/>\s*\/etc\/haunted\/kiro\.env|put [^\n]*kiro\.env|install [^\n]*kiro\.env|tee [^\n]*kiro\.env|cp [^\n]*kiro\.env|KIRO_API_KEY=/.test(sh), 'install.sh never writes the key file');
  assert.ok(!/cat [^\n]*kiro\.env|echo [^\n]*KIRO_API_KEY|printf [^\n]*KIRO_API_KEY/.test(sh), 'install.sh never prints the key');
  const pre = commands('deploy/server/preflight.sh');
  assert.match(pre, /check "kiro\.env is root:root 0600" kiro_env_mode/);
  assert.match(pre, /check "kiro-cli can authenticate for hops \(api key\)" kiro_whoami_key/);
  assert.match(pre, /check "kiro-cli can authenticate for hops \(login\)" kiro_whoami_login/);
  assert.match(pre, /stat -c '%U:%G %a' "\$KIRO_ENV"\)" = "root:root 600"/);
  assert.match(pre, /export KIRO_API_KEY="\$key"/);
  assert.ok(!/echo [^\n]*\$key|printf [^\n]*\$key|-x\b/.test(pre), 'the key is not echoed and the script does not trace');
  assert.ok(!/env [^\n]*KIRO_API_KEY=/.test(pre), 'the key is never an argument (ps would show it)');
});
test('install.sh: the nftables unit is enabled and started (restart when the file changed, start otherwise), after nft -c', () => {
  const sh = commands('deploy/server/install.sh');
  assert.match(sh, /systemctl enable nftables /);
  assert.match(sh, /if \[ "\$RELOAD_NFT" -eq 1 \]; then systemctl restart nftables; else systemctl start nftables; fi/);
  assert.ok(sh.indexOf('nft -c -f /etc/nftables.conf') < sh.indexOf('systemctl restart nftables'), 'the file is checked first');
});
test('docs/DEPLOY.md: SSM runs commands with /bin/sh, so install.sh is started with bash and a wrapper has no bash syntax', () => {
  const doc = read('docs/DEPLOY.md');
  assert.match(doc, /\/bin\/sh/);
  assert.match(doc, /dash/);
  assert.match(doc, /bash deploy\/server\/install\.sh/);
});
test('nftables: inbound 80 and 443 only, no port 22, IMDS dropped for non-root users, users held to loopback', () => {
  const nft = read('deploy/server/nftables.conf');
  const rules = nft.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  assert.ok(!rules.some((r) => /\b22\b/.test(r) && /accept/.test(r)), 'no accept for port 22');
  assert.ok(!/\bssh\b/i.test(rules.join('\n')), 'no ssh rule');
  assert.match(nft, /type filter hook input priority filter; policy drop;/);
  assert.match(nft, /^\s*tcp dport \{ 80, 443 \} accept$/m);
  assert.match(nft, /^\s*meta skuid != 0 ip daddr 169\.254\.169\.254 drop$/m);
  assert.match(nft, /^\s*meta skuid \{ hlab, prometheus, postgres \} oifname != "lo" drop$/m);
  assert.match(nft, /^\s*meta skuid hops oifname "lo" accept$/m);
  assert.match(nft, /^\s*meta skuid hops tcp dport 443 accept$/m);
  assert.match(nft, /^\s*meta skuid hops drop$/m);
  // IPv6 keeps working on the default Debian network setup: neighbour discovery and the DHCPv6 reply from a link-local server.
  assert.match(nft, /^\s*ip6 nexthdr icmpv6 icmpv6 type \{[^}]*nd-neighbor-solicit[^}]*nd-neighbor-advert[^}]*nd-router-advert[^}]*\} accept$/m);
  assert.match(nft, /^\s*ip6 saddr fe80::\/10 udp sport 547 udp dport 546 accept$/m);
  // IMDS drop comes before any accept of the output chain.
  const out = nft.slice(nft.indexOf('chain output')).split('\n').filter((l) => !l.trim().startsWith('#') && !l.includes('policy'));
  const firstAccept = out.findIndex((l) => l.includes('accept'));
  assert.ok(out.findIndex((l) => l.includes('169.254.169.254')) < firstAccept);
  // Every rule line has a comment right above it (or above the group it belongs to).
  const lines = nft.split('\n');
  const inChains = lines.slice(lines.findIndex((l) => l.includes('chain input')));
  let commented = false;
  for (const raw of inChains) {
    const line = raw.trim();
    if (line.startsWith('#')) commented = true;
    else if (line === '' || line.startsWith('chain') || line.startsWith('}') || line.startsWith('type ')) commented = line === '' ? false : commented;
    else assert.ok(commented, `rule without a comment: ${line}`);
  }
});

test('the env examples: FIX_ENABLED=false, no GITHUB_TOKEN, decided caps, nothing that looks like a secret', () => {
  for (const rel of ['deploy/server/env/api.env.example', 'deploy/server/env/lab.env.example']) {
    const text = read(rel);
    const { vars, badLines } = parseEnvText(text);
    assert.deepEqual(badLines, [], rel);
    assert.ok(!('GITHUB_TOKEN' in vars), `${rel}: GITHUB_TOKEN`);
    assert.ok(!/GITHUB_TOKEN/.test(text), `${rel}: GITHUB_TOKEN mentioned as a key`);
    for (const [k, v] of Object.entries(vars)) {
      if (/TOKEN|PASSWORD|SECRET/.test(k)) assert.match(v, /^CHANGE_ME_[A-Z_]+$/, `${rel}: ${k} is a placeholder`);
      assert.ok(!/[A-Za-z0-9+/_-]{32,}/.test(v), `${rel}: ${k} looks like a secret`);
    }
  }
  const api = parseEnvText(read('deploy/server/env/api.env.example')).vars;
  assert.equal(api.FIX_ENABLED, 'false');
  assert.equal(api.HUNT_DAILY_MAX, '3');
  assert.equal(api.HUNT_CREDIT_CAP, '1.5');
  assert.equal(api.HUNT_DAILY_CREDIT_CAP, '4.5');
  assert.equal(api.HOST, '127.0.0.1');
  assert.match(api.DATABASE_URL, /^postgresql:\/\/hops:__DB_PASSWORD__@127\.0\.0\.1:5432\/haunted$/);
  const lab = parseEnvText(read('deploy/server/env/lab.env.example')).vars;
  assert.ok(!('FIX_RUN_AS_USER' in lab));
  assert.equal(lab.NODE_ENV, 'production');
});

test('every shell file passes bash -n, and shellcheck when it is installed', (t) => {
  assert.ok(shellFiles.length >= 5, 'the shell files are found');
  for (const file of shellFiles) {
    const res = spawnSync('bash', ['-n', file], { encoding: 'utf8' });
    assert.equal(res.status, 0, `bash -n ${relative(ROOT, file)}: ${res.stderr}`);
    assert.match(readFileSync(file, 'utf8'), /^#!\/usr\/bin\/env bash\n/, `${relative(ROOT, file)}: shebang`);
    assert.ok(statSync(file).mode & 0o100, `${relative(ROOT, file)} is executable`);
  }
  const probe = spawnSync('shellcheck', ['--version'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    t.diagnostic('shellcheck is not installed: skipped');
    return;
  }
  const res = spawnSync('shellcheck', ['-x', ...shellFiles], { encoding: 'utf8', cwd: SERVER });
  assert.equal(res.status, 0, res.stdout + res.stderr);
});

test('the scripts with a strict mode: set -euo pipefail', () => {
  for (const file of shellFiles.filter((f) => !f.endsWith('preflight.sh'))) {
    assert.match(readFileSync(file, 'utf8'), /^set -euo pipefail$/m, relative(ROOT, file));
  }
  // The pre-flight runs every check even when one fails, so it has no -e.
  assert.match(read('deploy/server/preflight.sh'), /^set -uo pipefail$/m);
});

test('install.sh: root only, verifies the sha256 before unpacking, never compiles, secrets only when missing', () => {
  const sh = read('deploy/server/install.sh');
  assert.match(sh, /\[ "\$\(id -u\)" -eq 0 \] \|\| fail "run as root"/);
  const verify = sh.indexOf('sha256sum --check --status || fail "the release does not match');
  const unpack = sh.indexOf('tar -xzf "$REL_FILE" -C');
  assert.ok(verify > 0 && unpack > verify, 'sha256 is checked before the tarball is unpacked');
  assert.ok(!/\btsc\b|vite build|pnpm (run )?build/.test(sh.replace(/#.*$/gm, '')), 'nothing is compiled');
  assert.match(sh, /migrate deploy/);
  assert.match(sh, /openssl rand -hex 24/);
  assert.match(sh, /if \[ ! -f \/etc\/haunted\/api\.env \]/);
  assert.match(sh, /demo-env-check\.mjs" \/etc\/haunted\/api\.env api/);
  assert.match(sh, /demo-env-check\.mjs" \/etc\/haunted\/lab\.env lab/);
  assert.match(sh, /--shell \/usr\/sbin\/nologin/);
  assert.ok(!/git push|git commit/.test(sh), 'the lab is never written');
  assert.match(read('deploy/server/rollback.sh'), /there is no previous release/);
});

test('build-release.sh: refuses a dirty tree, builds in demo mode, checks the build, removes .vite, runs the release check, packs', () => {
  const sh = read('deploy/build-release.sh');
  assert.match(sh, /git status --porcelain/);
  assert.match(sh, /VITE_DEMO_MODE=true VITE_API_BASE_URL="https:\/\/\$\{HAUNTED_DOMAIN\}" pnpm --filter @haunted-ops\/web build/);
  assert.ok(!/\$\{?VITE_DEMO_MODE/.test(sh), 'the demo mode is set by the script, never read from the environment');
  assert.match(sh, /scripts\/check-demo-build\.mjs" "\$ROOT\/apps\/web\/dist" "\$HAUNTED_DOMAIN"/);
  assert.match(sh, /deploy\/pack-release\.sh" "\$STAGE" "\$TARBALL" "\$COMMIT_EPOCH"/);
  assert.ok(!/\$\(date -u \+|\$\(date\)/.test(sh.replace(/#.*$/gm, '')), 'no build time that changes between builds');
  assert.match(sh, /rm -r -- "\$STAGE\/apps\/web\/dist\/\.vite"/);
  assert.match(sh, /scripts\/release-check\.mjs" "\$STAGE"/);
  assert.ok(!/git (commit|add|stash|checkout|reset)/.test(sh.replace(/#.*$/gm, '')));
  assert.match(read('.gitignore'), /^deploy\/out\/$/m);
});

test('install.sh: no npm, npx or pipe to a shell; every download is checked against a pinned sha256 before use', () => {
  const sh = commands('deploy/server/install.sh');
  assert.ok(!/\bnpm\b/.test(sh), 'no npm');
  assert.ok(!/\bnpx\b/.test(sh), 'no npx');
  assert.ok(!/\bcorepack\b/.test(sh), 'no corepack');
  assert.ok(!/\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/.test(sh), 'nothing is piped into a shell');
  const downloads = [...sh.matchAll(/\bcurl\b[^\n]*-o "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(downloads, ['$WORK/node.tar.xz', '$WORK/pnpm.tgz', '$REL_FILE']);
  const pinned = { '$WORK/node.tar.xz': 'NODE_SHA256', '$WORK/pnpm.tgz': 'PNPM_SHA256', $REL_FILE: 'RELEASE_SHA256' };
  const uses = { '$WORK/node.tar.xz': 'tar -xJf "$WORK/node.tar.xz"', '$WORK/pnpm.tgz': 'tar -xzf "$WORK/pnpm.tgz"', $REL_FILE: 'tar -xzf "$REL_FILE"' };
  for (const file of downloads) {
    const check = sh.indexOf(`echo "\${${pinned[file]}}  ${file}" | sha256sum --check --status || fail`);
    assert.ok(check > sh.indexOf(`-o "${file}"`), `${file} is checked against ${pinned[file]}`);
    assert.ok(check < sh.indexOf(uses[file]), `${file} is used only after its check`);
  }
  // The pinned values exist and have the right shape, and the pnpm version is the one of packageManager.
  const versions = parseEnvText(read('deploy/server/versions.env')).vars;
  assert.match(versions.NODE_SHA256 ?? '', /^[0-9a-f]{64}$/);
  assert.match(versions.PNPM_SHA256 ?? '', /^[0-9a-f]{64}$/);
  assert.equal(JSON.parse(read('package.json')).packageManager, `pnpm@${versions.PNPM_VERSION}`);
});
test('install.sh: every install runs with scripts off; the one script that runs is named in DEPLOY.md', () => {
  const sh = commands('deploy/server/install.sh');
  const installs = sh.split('\n').filter((l) => /\bpnpm\b.*\binstall\b/.test(l));
  assert.equal(installs.length, 2, 'the release and the lab');
  for (const line of installs) {
    assert.match(line, /--frozen-lockfile/);
    assert.match(line, /--ignore-scripts/);
  }
  assert.ok(!/--no-ignore-scripts|ignore-scripts=false|--ignore-scripts[= ]false/.test(sh), 'scripts are never switched back on');
  const others = sh.split('\n').filter((l) => /\bpnpm\b.*\b(rebuild|rb|run|exec|dlx|add|update|approve-builds)\b/.test(l));
  assert.deepEqual(
    others.map((l) => l.trim()),
    ['as_hops pnpm --filter @haunted-ops/api rebuild @prisma/engines'],
  );
  assert.match(read('docs/DEPLOY.md'), /`@prisma\/engines`[^\n]*postinstall|postinstall[^\n]*`@prisma\/engines`/);
});
test('install.sh: the release install is the API workspace only, as hops, with the workspace prisma, no generate, then locked', () => {
  const sh = commands('deploy/server/install.sh');
  assert.match(sh, /as_hops pnpm install --frozen-lockfile --ignore-scripts --filter @haunted-ops\/api\.\.\. /);
  assert.match(sh, /as_hops "\$REL_DIR\/apps\/api\/node_modules\/\.bin\/prisma" migrate deploy --config/);
  assert.match(sh, /as_hops \/usr\/local\/bin\/node "\$REL_DIR\/deploy\/server\/seed\.mjs"/);
  assert.ok(!/prisma"? generate\b/.test(sh), 'the compiled client is in apps/api/dist: no prisma generate on the server');
  assert.ok(!/prisma-cli/.test(sh), 'no separate Prisma install');
  assert.match(sh, /as_hops\(\) \{ runuser -u hops --/);
  assert.match(sh, /tar -xzf "\$REL_FILE" -C "\$REL_DIR" --no-same-owner/);
  assert.match(sh, /chown -R root:hops "\$REL_DIR"\n\s*chmod -R u-w,go-w,a\+rX "\$REL_DIR"/);
  assert.ok(sh.indexOf('migrate deploy') < sh.indexOf('chown -R root:hops'), 'the release is locked after the installs');
  // Prisma comes from the lockfile of the repository, at the version the API names.
  const api = JSON.parse(read('apps/api/package.json'));
  assert.match(api.devDependencies.prisma, /^\d+\.\d+\.\d+$/);
  assert.ok(read('pnpm-lock.yaml').includes(`prisma@${api.devDependencies.prisma}`));
});
test('install.sh: the temporary policy-rc.d is removed in the exit trap too', () => {
  const sh = read('deploy/server/install.sh');
  const trap = /on_exit\(\) \{[\s\S]*?\n\}/.exec(sh)?.[0] ?? '';
  assert.match(trap, /if \[ "\$POLICY_RC_SET" -eq 1 \]; then\s+rm -f -- \/usr\/sbin\/policy-rc\.d\s+fi/);
  // The flag is set before the file is written and cleared only after the removal.
  assert.equal([...sh.matchAll(/>\/usr\/sbin\/policy-rc\.d/g)].length, 1);
  assert.ok(sh.indexOf('POLICY_RC_SET=1') < sh.indexOf('>/usr/sbin/policy-rc.d'));
  assert.ok(sh.indexOf('rm -f -- /usr/sbin/policy-rc.d\n  POLICY_RC_SET=0') > sh.indexOf('apt-get install'));
});
test('no deploy file holds a home path, a real address, a forbidden string or a secret', () => {
  const forbidden = [
    ['home path', new RegExp(`/${'Users'}/|/${'home'}/[a-z]`)],
    ['kiro-cli state path', new RegExp(['local', 'share', 'kiro-cli'].join('/'))],
    ['GitHub token', new RegExp(`${'gh'}p_|${'github'}_pat_`)],
    ['cloud key', new RegExp(`${'AK'}IA[A-Z0-9]{16}`)],
    ['account id', /\b\d{12}\b/],
  ];
  // Addresses that may appear: loopback, the metadata address that is blocked, the unspecified one in a test of the guard.
  const allowedIps = new Set(['127.0.0.1', '169.254.169.254', '0.0.0.0']);
  for (const file of deployFiles) {
    const text = readFileSync(file, 'utf8');
    for (const [what, re] of forbidden) assert.ok(!re.test(text), `${relative(ROOT, file)}: ${what}`);
    for (const ip of text.match(/\b\d{1,3}(\.\d{1,3}){3}\b/g) ?? []) assert.ok(allowedIps.has(ip), `${relative(ROOT, file)}: address ${ip}`);
  }
});
