# Design Document
## Overview
`deploy-demo` adds files and local tests. It adds no web code, no API code and no dependency. The Mac builds one tarball; the server installs it, runs it under systemd and keeps it behind Caddy and nftables.
```
Mac:  deploy/build-release.sh --> build (VITE_DEMO_MODE=true) --> stage --> release-check --> tar.gz + sha256
                                                                                          |
                                                                          (upload by the orchestrator)
                                                                                          v
Server (Debian 13, t3.small, SSM only):  install.sh  --verify sha256--> /opt/haunted-ops/releases/<sha> --> current
   internet --443--> Caddy --GET/HEAD /api/*, /healthz--> API 127.0.0.1:3000 --> PostgreSQL 127.0.0.1
                       |                                         |--> Prometheus 127.0.0.1:9090 --scrape 5 s--> Lab 127.0.0.1:4001-4004
                       +--static files (web dist)                +--> Lab supervisor 127.0.0.1:4100
   timer (01:00, 09:00, 17:00 UTC) --> haunted-scenario.service --> Lab chaos API on 127.0.0.1 --> API auto-hunt (kiro-cli, at most 3 a day)
```
Key decisions:
- **Nothing is compiled on the server.** The tarball holds the built `dist` folders. The server runs `pnpm install --frozen-lockfile --ignore-scripts --filter @haunted-ops/api...` as `hops` (the Prisma CLI of the lockfile comes with it), nothing else. A smaller server and a smaller attack surface follow from it.
- **One tarball, checked twice.** `release-check` runs on the staged tree before the tarball exists, and the Install script checks the sha256 before it unpacks. The check is a plain Node module so tests can feed it fixture trees.
- **The internet is read-only, by two layers.** Caddy refuses every method but `GET` and `HEAD` on `/api/*` and `/healthz` with 405 before the API sees it; the Admin calls need `HUNT_ADMIN_TOKEN` and are made on `127.0.0.1` on the server. The API keeps its own token check.
- **The fixer is not on the server.** `FIX_ENABLED=false` is enforced by the Env guard, no `GITHUB_TOKEN` exists and the units carry none. The proposal flow is recorded on the Mac for the video. This replaces the plan of a separate OS user for the fixer.
- **Spending is capped three times.** The Env guard holds `HUNT_DAILY_MAX=3`, `HUNT_CREDIT_CAP=1.5`, `HUNT_DAILY_CREDIT_CAP=4.5`; only the Scenario timer causes Hunts (three Scenarios a day); the Kill switch has three layers.
- **Fences by user.** `hops` runs the API and the Hunts, `hlab` runs the Lab; each service has a memory ceiling, `NoNewPrivileges` and a read-only file system except its own folders. nftables limits each user's outbound traffic and denies the metadata address to every user but root.
- **Idempotent by comparison.** The Install script writes a file only when its content differs, restarts a service only when something it uses changed, and never rewrites an existing secret.
## Architecture
All paths are in this repository unless they start with `/`.
| File | Kind | Content |
| --- | --- | --- |
| `deploy/build-release.sh` | new, Mac | builds, stages, runs the Release check, writes the tarball and the `.sha256`; refuses a dirty tree |
| `scripts/release-check.mjs` | new, Node | `checkTree(dir)` and a CLI; finds forbidden items; prints path and kind, never the match |
| `scripts/demo-env-check.mjs` | new, Node | `parseEnvText`, `checkEnv(vars, profile)`, a CLI; names only |
| `scripts/demo-smoke.mjs` | new, Node | `runSmoke(origin, options)`, `formatTable`, a CLI |
| `deploy/server/install.sh` | new, bash | the install of the Demo server, idempotent |
| `deploy/server/rollback.sh` | new, bash | Current link to the previous release, API restart |
| `deploy/server/preflight.sh` | new, bash | state checks on the server |
| `deploy/server/scenario.sh` | new, bash | one Scenario: apply the next, wait, reset |
| `deploy/server/seed.mjs` | new, Node | seeds the four Services from the compiled API (`dist/prisma/seed.js`) |
| `deploy/server/prisma.config.mjs` | new, Node | a plain Prisma config for the server (no `prisma/config` import, no TypeScript) |
| `deploy/server/versions.env` | new | pinned Node version and its sha256 |
| `deploy/server/Caddyfile`, `nftables.conf` | new | web front and firewall |
| `deploy/server/systemd/*.service`, `*.timer` | new | `haunted-api`, `haunted-lab`, `haunted-scenario` and its timer |
| `deploy/server/systemd/dropins/` | new | `prometheus.service.d`, `caddy.service.d` |
| `deploy/server/postgres/haunted.conf` | new | memory and listen settings for PostgreSQL |
| `deploy/server/prometheus/` | new | `prometheus.yml` (5 s scrape) and `targets/lab.json` for `127.0.0.1` |
| `deploy/server/env/api.env.example`, `lab.env.example` | new | names and placeholders |
| `scripts/*.test.mjs` | new | tests below |
| `docs/DEPLOY.md` | new | cost and runbook |
Changed: `package.json` (`test:scripts`), `.gitignore` (`deploy/out/`), `.kiro/steering/security.md`, `.kiro/steering/structure.md`, `README.md`, `docs/DEV.md` (two sentences), `docs/KIRO_USAGE.md`.
## Components and Interfaces
### Release check (`scripts/release-check.mjs`)
```ts
type Finding = { path: string; kind: FindingKind };
type FindingKind = 'native_binary' | 'env_file' | 'forbidden_path' | 'source_map' | 'vite_dir' | 'home_path' | 'token';
function checkTree(root: string): Finding[];   // sorted by path then kind, never holds matched text
```
It walks the tree without following symlinks (a symlink is itself a finding of kind `forbidden_path`). A file is read for the magic number (ELF `7f 45 4c 46`, Mach-O `fe ed fa ce`, `fe ed fa cf`, `ce fa ed fe`, `cf fa ed fe`, fat `ca fe ba be`) and, when it is text (no NUL byte, under 8 MiB), scanned for the home path and token patterns. `.example` files are exempt from the `.env` rule but not from the token rules. The CLI is `node scripts/release-check.mjs <dir>`: exit 0 and `release-check: ok`, or exit 1 with one line per finding.
Token patterns: `ghp_`/`github_pat_`/`gho_`/`ghs_` followed by 20 or more characters of `[A-Za-z0-9_]`, `AKIA` or `ASIA` followed by 16 upper-case letters or digits, `xox[abprs]-` followed by 10 or more characters, a `-----BEGIN ... PRIVATE KEY-----` block header, an `Authorization: Bearer` header with 24 or more token characters, and a `sk-` key of 32 or more characters. Home paths: `/Users/` or `/home/` followed by a name and `/`, and `C:\Users\`. The pattern list is data in the module, and its entries are written so that the module does not match itself.
### Build script (`deploy/build-release.sh`)
Order: check tools, refuse a dirty tree (`git status --porcelain` not empty), read `HAUNTED_DOMAIN` (a DNS name, required), run `pnpm install --frozen-lockfile`, build `@haunted-ops/shared`, `@haunted-ops/exorcist-mcp` and `@haunted-ops/api`, and build the Web with `VITE_DEMO_MODE=true VITE_API_BASE_URL=https://$HAUNTED_DOMAIN`. The script sets `VITE_DEMO_MODE=true` itself on that command line, so the environment of the caller cannot change it. It then runs `node scripts/check-demo-build.mjs apps/web/dist <domain>`, which reads every `.js` file of the build and fails unless an object literal holds the properties `VITE_DEMO_MODE` with `true` and `VITE_API_BASE_URL` with `https://<domain>` (Vite inlines both into the object that replaces `import.meta.env`; the pattern takes any quote style and a property after `{` or `,`, so the code that only reads the variable does not match). `scripts/check-demo-build.test.mjs` proves it on real `vite build` output (about a second, no network): a build with the settings, one without, and one with `VITE_DEMO_MODE=false`. The script stages the tree in a temporary folder, removes `.vite/`, writes `RELEASE-INFO` (`built_at` is the time of the commit, so the file does not change between builds), runs `node scripts/release-check.mjs` on the stage, calls `deploy/pack-release.sh <stage> <tarball> <commit time>`, and writes `<name>.tar.gz.sha256` as `<hash>  <name>`. The short sha is `git rev-parse --short=12 HEAD`. A trap removes the staging folder. The script never runs `git commit`, `add`, `stash` or `checkout`.
### Env guard (`scripts/demo-env-check.mjs`)
```ts
type Profile = 'api' | 'lab';
function parseEnvText(text: string): { vars: Record<string, string>; badLines: number[] };
function checkEnv(vars: Record<string, string>, profile: Profile): string[]; // refused names, in a fixed order, no values
```
Parsing follows systemd `EnvironmentFile`: `KEY=VALUE` lines, `#` and `;` comments, blank lines, optional matching quotes, the last duplicate wins. A line it cannot read adds `line <n>` to the refusal list. The CLI prints `demo-env-check: ok (<profile>)` or `demo-env-check: refused: NAME, NAME` to stderr and exits 0, 1 or 2. Rules of the `api` profile, in order: `NODE_ENV`, `DATABASE_URL`, `PORT`, `HOST`, `WEB_ORIGIN`, `TRUST_PROXY_HOPS`, `FIX_ENABLED`, `GITHUB_TOKEN`, `HUNTS_ENABLED`, `LAB_URL`, `PROMETHEUS_URL`, `LAB_READ_TOKEN`, `HUNT_ADMIN_TOKEN`, `KIRO_CLI_PATH`, `HUNT_WORKDIR`, `HUNT_DAILY_MAX`, `HUNT_CREDIT_CAP`, `HUNT_DAILY_CREDIT_CAP`. The two token rules apply to each token (24 characters or more, no `CHANGE_ME`), and equal tokens refuse `HUNT_ADMIN_TOKEN`. `HUNTS_ENABLED` may be `true` or `false`, because `false` is the third layer of the Kill switch.
### Smoke test (`scripts/demo-smoke.mjs`)
```ts
type Result = { name: string; status: number | string; ok: boolean };
function runSmoke(origin: string, options?: { fetchImpl?: typeof fetch; sseTimeoutMs?: number }): Promise<Result[]>;
```
It uses the built-in `fetch` with `redirect: 'manual'` and a 10 s timeout per request, and for the stream an `AbortController` that closes the connection once the headers have arrived. The origin must be `http:` or `https:` with no path. The table is printed by `formatTable`; the exit code is 0 only when every `ok` is true.
### Scenario timer
`scenario.sh` reads `CHAOS_TOKEN` from the environment of the unit, reads `/var/lib/haunted/scenario-next` (default `0`), writes the next index first (so a failing Scenario does not stick), applies `POST /chaos/scenarios/<name>/apply` on `127.0.0.1:4100` with the bearer, sleeps 1200 s and calls `POST /chaos/reset`. The token goes to curl through a header file in the private runtime folder of the unit (`mode 0600`, removed on exit), never through an argument. `ExecStopPost` calls `scenario.sh reset`.
### Firewall (`deploy/server/nftables.conf`)
One table `inet haunted` created with `add table`, `delete table`, then the definition, so a reload replaces it without touching other tables. Hooks: `input` (policy drop) and `output` (policy accept, with the user rules). Users are named (`meta skuid "hlab"`), so the install creates users first. `hops` needs DNS to reach the model service; the rule allows UDP and TCP 53 for it, which is a small widening of "loopback plus TCP 443" that the decision overlooked.
### Caddy (`deploy/server/Caddyfile`)
Order of handlers: log; headers; `@hidden` (`/.vite*`) answers 404; `@apiwrite` (path `/api/*` or `/healthz`, method not `GET` or `HEAD`) answers 405 with `Allow`; `handle /api/*` and `handle /healthz` proxy with `flush_interval -1`; `handle /assets/*` serves files with long cache and 404 on a miss; the last `handle` serves the Web with `try_files {path} /index.html`. `encode` is applied only to the static handler, so the event stream is never compressed. The log filter removes the query string from `request>uri` and deletes `request>headers`.
CSP: `default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`. `'unsafe-eval'` is there because PixiJS 8 builds shader sync functions with `new Function` (seen in the built scene chunk); the other fix, importing `pixi.js/unsafe-eval`, changes web code and is out of scope. `style-src` allows inline style attributes that the room buttons use.
### Install script (`deploy/server/install.sh`)
Stages, each a function that reports `changed` or `unchanged`: `preflight_args`, `swap`, `packages`, `node_and_pnpm`, `users_and_dirs`, `postgres`, `release` (download, verify, unpack with `--no-same-owner`, hand the folder to `hops`, `pnpm install --frozen-lockfile --ignore-scripts --filter @haunted-ops/api...` as `hops`, `pnpm rebuild @prisma/engines`, `migrate deploy` with the workspace `prisma`, seed, lock the folder as `root:hops` read-only, link), `lab`, `env_files`, `configs` (units, drop-ins, Caddyfile, Prometheus, nftables, PostgreSQL), `enable_start`. A helper `put <src> <dst> <mode> <owner>` writes through a temporary file only when `cmp` says the content differs and sets a global change flag. Services restart only when the Current link moved or one of their files changed. Failure of any command stops the script (`set -e`); a `trap` prints the stage that failed.
Prisma on the server: the API `dist` already holds the generated client (the API build compiles it into `dist/generated`), so there is no `prisma generate` on the server and the release carries no `src/generated`. The Prisma CLI is the version of `pnpm-lock.yaml`, installed by the workspace install (`--filter @haunted-ops/api...` without `--prod`, because `prisma` is a development dependency of the API, so the development dependencies of the API and its workspace packages come along). It runs as `hops` from `apps/api/node_modules/.bin/prisma` with `deploy/server/prisma.config.mjs`, a plain-object config with absolute schema and migrations paths (so the TypeScript config of the repository is not loaded). Lifecycle scripts are off for every install; the one script that runs is the `postinstall` of `@prisma/engines` (`pnpm --filter @haunted-ops/api rebuild @prisma/engines`), which fetches the schema engine for `migrate deploy` and which Prisma checks by checksum. The release folder is owned by `hops` during the install and then `root:hops`, read-only (`chmod -R u-w,go-w,a+rX`).
Node 26 does not bundle corepack, and `npm install -g` has no lockfile or checksum, so pnpm is downloaded as the registry tarball `pnpm-<version>.tgz` (a bundle that runs on Node alone), checked against `PNPM_SHA256` of `deploy/server/versions.env`, unpacked to `/opt/pnpm-v<version>` and linked as `/usr/local/bin/pnpm`. A test keeps `PNPM_VERSION` equal to `packageManager`, and the install stops when the release names another version. There is no `npm`, `npx` or download piped into a shell in the script; a test checks that every `curl` output file is verified against a pinned sha256 before it is used.
The `apt` guard: the temporary `/usr/sbin/policy-rc.d` is removed after `apt-get install` and, through a flag, by the `EXIT` trap when `apt` fails.
Release files: `deploy/pack-release.sh <stage> <tarball> <epoch>` sets folders 0755, files 0644, `deploy/server/*.sh` 0755 and every time to the commit time (UTC), then writes the archive with owner and group 0 (`--owner=0 --group=0 --numeric-owner` for GNU tar, `--uid 0 --gid 0 --uname root --gname root --no-xattrs` for bsdtar), sorted names and `gzip -n`. Its test packs fixture stages with 0600 and 0700 entries and different times and creation order, reads the tar headers and compares the sha256 of two packs.
IPv6: the firewall keeps it enabled. Besides the ICMPv6 errors and neighbour discovery, input accepts the DHCPv6 reply (`ip6 saddr fe80::/10 udp sport 547 udp dport 546`), so the default Debian network configuration keeps its lease.
Lab: `git clone` of `LAB_REPO_URL` (HTTPS, no credentials), `git checkout --detach <commit>`, and a local branch for `main` and each `scenario/*` created from the remote refs, because the supervisor copies local heads into its mirror. The clone is owned by `hlab` (git refuses a foreign owner) and is read-only at run time through `ProtectSystem=strict`. Nothing is pushed or planted.
### Preflight (`deploy/server/preflight.sh`)
Prints one line per check (`ok` or `FAIL`) and exits 1 on any failure: `systemctl is-active` for the API, Lab, Caddy, PostgreSQL, Prometheus, nftables and the timer; `swapon --show` not empty; `MemAvailable` above 300 MiB; free disk above 3 GiB; `nft list table inet haunted` succeeds; `runuser -u hops -- kiro-cli whoami` exit status only, output discarded; the Env guard on both files; `LAB_READ_TOKEN` equal in both files (compared in Node, prints `ok` or `FAIL`).
## Data Models
No API, Prisma or shared type changes. Files on the server:
- `/etc/haunted/api.env`, `/etc/haunted/lab.env`: mode 0640, owner root, group `hops` and `hlab`. `/etc/caddy/haunted.env` holds `HAUNTED_DOMAIN` only (0644).
- `/opt/haunted-ops/releases/<sha>/`, `/opt/haunted-ops/current`, `/opt/pnpm-v<version>/`, `/opt/haunted-lab/`.
- `/var/lib/hops/` (home of `hops`, holds `hunts/` mode 0700 and the kiro-cli state), `/var/lib/haunted-lab/{data,worktrees}`, `/var/lib/haunted/scenario-next`.
- `RELEASE-INFO` in each release: `commit`, `domain`, `demo_mode`, `built_at`. No secret.
## Correctness Properties
*A property is a statement that must hold for all valid inputs. Each one below is checked by a property-based test with fast-check, at least 100 runs, with the comment `// Feature: deploy-demo, Property N`.*
### Property 1: The Env guard accepts only maps that satisfy every rule
For any map of variables built by taking a valid `api` map and replacing, deleting or adding values, `checkEnv` returns no refusal exactly when an independent oracle (written from the rule table, not from the module) finds every rule satisfied, and the refused names are exactly the names the oracle finds.
**Validates: Requirements 6.1, 6.3, 9.3**
### Property 2: The Env guard never prints a value
For any map, the text of the CLI result (the line printed for the refusal or the acceptance) contains no value of the map that is longer than 5 characters and not a part of a variable name.
**Validates: Requirements 6.3, 9.3**
### Property 3: The Release check refuses every forbidden item and nothing clean
For any tree of harmless files, `checkTree` returns no finding; adding one forbidden item (any kind of requirement 1.4, at any depth) gives a finding of that kind at that path, and no finding holds a part of the matched text.
**Validates: Requirements 1.4, 1.5**
## Error Handling
- **Dirty tree or missing tool**: the build script stops before it builds anything and says which.
- **Wrong sha256 or a download error**: the Install script stops before it unpacks; the previous release stays active.
- **Migration fails**: the Current link is not switched; the API of the previous release keeps running (a migration is applied before the switch, so a destructive one needs its own plan).
- **Env guard refuses**: the service does not start (`ExecStartPre`); the journal shows names only.
- **API crashes**: `Restart=on-failure` with a start limit; the Web still works in Demo mode (`?demo=1`).
- **Lab down**: the API shows the ingest as stale; the Smoke test still passes, because it checks the API, not the Lab.
- **Scenario service hangs**: `RuntimeMaxSec=30min` ends it and `ExecStopPost` resets the Lab.
- **Out of memory**: each service has a cgroup ceiling and the swapfile absorbs the peak of a Hunt; Prometheus and PostgreSQL are small.
- **Certificate not issued**: Caddy keeps retrying; ports 80 and 443 must be open from the internet and the `sslip.io` name must match the IP.
## Testing Strategy
- **Unit tests** (`node --test`): `demo-env-check.test.mjs` (each refusal and a valid file, parsing, no value in the output, the CLI exit codes), `demo-smoke.test.mjs` (a local fake server for the passing case and each failing case, the table), `release-check.test.mjs` (each forbidden kind, a clean tree, `.example` exemption, symlink), `deploy-files.test.mjs` (units, timer, Caddyfile, nftables, env examples, `bash -n`, `shellcheck` when installed, no forbidden string in tracked deploy files).
- **Property tests** (fast-check): `demo-env-check.property.test.mjs` for Properties 1 and 2, `release-check.property.test.mjs` for Property 3.
- **Not covered here**: a run of the Install script (it needs root and a Debian host), `caddy validate`, `nft -c` and `systemd-analyze verify` (the tools are not on the Mac). The orchestrator runs them on the server: `systemd-analyze verify`, `caddy validate`, `nft -c -f` are in the Pre-flight and the runbook.
