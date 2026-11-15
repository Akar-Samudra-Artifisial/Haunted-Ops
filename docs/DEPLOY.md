# Deploying the demo server

One small server runs the public demo: the web, the API, PostgreSQL, Prometheus, Caddy and the Haunted Lab, all as native systemd services. A timer plants a lab scenario three times a day, and the API starts a real `kiro-cli` hunt for it. The spec is `.kiro/specs/deploy-demo/`.

Nothing in this repository creates cloud resources. The steps below are run by a person (the orchestrator) with access to the AWS account.

## What it costs

- EC2 `t3.small` on demand in `us-east-1`: about 15 US dollars a month, plus about 1.60 a month for the 20 GB gp3 disk, plus the public IPv4 address (about 3.60 a month, also while attached to a running instance).
- Hunts: at most 3 a day (`HUNT_DAILY_MAX=3`), at most 1.5 Credits each and 4.5 a day.
- Turn the instance off (stop or terminate it) after judging. A stopped instance still pays for the disk and an Elastic IP.

## What is deliberately not on the server

- **The fixer.** `FIX_ENABLED=false` is enforced by `scripts/demo-env-check.mjs` at install and at every start of the API. Fix proposals and pull requests are recorded on the developer's Mac for the video.
- **A GitHub token.** No `GITHUB_TOKEN` exists on the server; the guard refuses a file that names one.
- **Fix deploys of the lab.** The lab runs without `FIX_RUN_AS_USER`, so its `POST /chaos/deploy-fix` answers 503 `isolation_unavailable`. A separate OS user for the fixer and its test run is future work.
- **Admin calls from the internet.** Caddy answers 405 to any method but `GET` and `HEAD` on `/api/*` and `/healthz`. `POST /api/hunts` and the kill switch work only on the server, on `127.0.0.1`, with `HUNT_ADMIN_TOKEN`.
- **SSH.** Port 22 is closed; access is by AWS Systems Manager (SSM) only.
- **A compiler.** The server installs a release tarball built on the Mac and runs no `tsc` or `vite build`.

## Layout on the server

| Path | What |
| --- | --- |
| `/opt/haunted-ops/releases/<id>/` | one unpacked release; `/opt/haunted-ops/current` and `previous` are links to releases |
| `/opt/haunted-lab/` | the lab repository at the pinned commit, owned by `hlab`, read-only at run time |
| `/etc/haunted/api.env`, `lab.env` | environment files, mode 0640, group `hops` and `hlab`; made once from `deploy/server/env/*.example` with generated tokens |
| `/var/lib/hops/` | home of `hops`: the hunt folder `hunts/` (0700) and the kiro-cli state folder of `hops` |
| `/var/lib/haunted-lab/` | lab data, git mirror and worktrees |
| `/var/lib/haunted/scenario-next` | position in the scenario rotation |

Services: `haunted-api` (user `hops`, 1 GiB with the hunt child), `haunted-lab` (user `hlab`, 512 MiB), `prometheus` (127.0.0.1:9090, 24 h, 256 MiB), `postgresql` (127.0.0.1), `caddy` (80 and 443), `nftables`, and `haunted-scenario.timer` at 01:00, 09:00 and 17:00 UTC.

## Runbook

Do these in order.

1. **Build the release on the Mac.** Commit everything first: the script refuses a dirty tree. The domain is the `sslip.io` name of the instance address (step 4), so build after the address is known.
   ```sh
   HAUNTED_DOMAIN=<a-b-c-d>.sslip.io deploy/build-release.sh
   ```
   It writes `deploy/out/haunted-ops-<shortsha>.tar.gz` and `.sha256` (git-ignored). It builds the web with `VITE_DEMO_MODE=true` (set by the script itself, whatever the environment says) and `VITE_API_BASE_URL=https://<domain>`, checks with `scripts/check-demo-build.mjs` that both are in the built scripts, removes `apps/web/dist/.vite/`, and refuses the tree if it finds a native binary, a `.env` file, `spike/`, `.agents/`, a source map, a home path or a token. The tarball is reproducible: folders 0755, files 0644, `deploy/server/*.sh` 0755, owner and group 0, sorted names and the time of the commit, so two builds of one commit have the same sha256 and user `hops` can read every file.
2. **Create the instance.** EC2 `t3.small`, Debian 13 amd64 AMI, `us-east-1`, 20 GB gp3 root disk, a security group with inbound TCP 80 and 443 (and UDP 443) from anywhere and nothing else, no key pair. Not shared with any other project.
3. **Role and metadata.** Attach an instance profile whose role has only `AmazonSSMManagedInstanceCore`. Set the metadata options to IMDSv2 required (`HttpTokens=required`) and hop limit 1 (`HttpPutResponseHopLimit=1`). Debian images ship without the SSM agent in some versions: install it from the AWS documentation (user data) if the instance does not show up in Systems Manager.
4. **Address.** Attach an Elastic IP so the address, and with it the `<a-b-c-d>.sslip.io` name, stays the same across a stop and start. Without one, the public address changes at each start, and the release and the env file must be rebuilt for the new name.
5. **Publish the release.** Put the tarball where the instance can download it over HTTPS (for example a private S3 object with a short presigned URL), or copy it to the instance through an SSM session. Note its sha256 (the first field of the `.sha256` file).
6. **Install kiro-cli** for all users at `/usr/local/bin/kiro-cli`, the version the Mac uses, following the official Kiro CLI install instructions, in an interactive SSM session as root.
7. **Run the install through SSM** as root (a `Run Command` with `AWS-RunShellScript`, or an interactive session). Unpack `deploy/server/` from the tarball first, or copy it from the repository at the same commit.
   ```sh
   HAUNTED_DOMAIN=<a-b-c-d>.sslip.io \
   RELEASE_URL=<https URL or absolute path of the tarball> \
   RELEASE_SHA256=<64 hex> \
   LAB_REPO_URL=https://github.com/<owner>/Haunted-Lab.git \
   LAB_COMMIT=<40 hex commit of the lab main> \
   bash deploy/server/install.sh
   ```
   It creates the swapfile, installs Node 26 (pinned version and sha256 in `deploy/server/versions.env`), pnpm (the version of `packageManager`, from a tarball checked against a pinned sha256), Caddy, PostgreSQL, Prometheus and nftables, creates the users `hops` and `hlab`, writes the env files once with tokens from `openssl rand`, verifies the release sha256, installs the dependencies of the API as `hops` (see "Installs on the server"), runs `prisma migrate deploy`, seeds the four services, clones the lab at the pinned commit (its `main` and `scenario/*` branches on GitHub are never changed), installs the units, the Caddyfile, the Prometheus files and the firewall, and starts everything. A second run with the same release prints `0 change(s)`.
8. **Log `hops` into kiro-cli.** In an interactive SSM session as root:
   ```sh
   runuser -u hops -- env HOME=/var/lib/hops kiro-cli login --use-device-flow
   ```
   Open the printed URL on your own machine and enter the code. The login lives in the kiro-cli state folder of `hops`, under `/var/lib/hops`.
9. **Pre-flight on the server**, as root: `bash /opt/haunted-ops/current/deploy/server/preflight.sh`. It checks that the units are active, swap is on, memory and disk are free, the firewall is loaded, the Caddyfile and the units are valid, the env guard accepts both files, `kiro-cli whoami` succeeds for `hops` (its output is not shown), and the API answers. Every line must say `ok`.
10. **Smoke test from the Mac**: `node scripts/demo-smoke.mjs https://<a-b-c-d>.sslip.io`. It checks the page, the `/hunts/x` fallback, `?demo=1`, `/healthz`, `GET /api/services`, the event stream, that `POST /api/hunts` and the kill switch answer 405, that `/.vite/manifest.json` is 404, and the security headers. It prints a table and exits 0 only when all pass.
11. Put the link in the README line "Live demo".

## Installs on the server

- **No `npm`, no `npx`, no pipe into a shell.** Node and pnpm are downloaded files, each checked against a sha256 kept in `deploy/server/versions.env` (and the release against `RELEASE_SHA256`) before it is used. `versions.env` pins the pnpm version of `packageManager`; a test keeps the two equal, and the install stops when the release asks for another version. Node 26 has no corepack, so the pnpm tarball of the npm registry is the way in.
- **Lifecycle scripts are off** (`--ignore-scripts`) in every `pnpm install` of the script. The one script that runs is the `postinstall` of `@prisma/engines`, started with `pnpm --filter @haunted-ops/api rebuild @prisma/engines`: it downloads the schema engine that `prisma migrate deploy` needs, and Prisma checks its checksum. `hops` may do this because it can reach HTTPS. Nothing else needs a script at run time (the API starts from `apps/api/dist`).
- **The API workspace only.** `pnpm install --frozen-lockfile --ignore-scripts --filter @haunted-ops/api...` installs the API and the workspace packages it needs from `pnpm-lock.yaml`, not the web. The development dependencies of those packages come with it, because the Prisma CLI that applies the migrations is one of them. It is the version in the lockfile; there is no separate Prisma install.
- **No `prisma generate` on the server.** The compiled client is already inside `apps/api/dist` (the API build compiles it), so a generate step would only write unused files into `src/generated`.
- **Who runs what.** The install, `prisma migrate deploy` and the seed run as `hops` (`runuser -u hops`), never as root. The release folder is owned by `hops` while the install runs, then set to owner `root`, group `hops`, nobody can write; Caddy reads the web files as "other". The lab's production install runs as root (the firewall holds `hlab` to loopback), also with scripts off, and the tree is handed to `hlab` afterwards.

## IPv6

The firewall keeps IPv6 working on the default Debian network setup instead of turning it off: it accepts ICMPv6 errors and neighbour discovery, and the DHCPv6 reply (UDP source 547, destination 546) from a link-local address (`fe80::/10`). Every other inbound IPv6 packet is dropped like IPv4.

## Daily check

- `node scripts/demo-smoke.mjs https://<domain>` from the Mac.
- On the server: `bash /opt/haunted-ops/current/deploy/server/preflight.sh`, `systemctl list-timers haunted-scenario.timer` (the next run), `journalctl -u haunted-scenario --since today` (the scenarios applied and reset) and `journalctl -u haunted-api --since today` (the hunts and their results; the log holds no secret).
- Credits: the hunt detail (`GET /api/hunts/<id>`) has the Credits of each hunt; the day stops at 4.5.

## Kill switch

Three layers, from the quickest to the most lasting. All are run on the server, as root, in an SSM session.

1. **The API endpoint** (stops new hunts at once, until the API restarts):
   ```sh
   set -a; . /etc/haunted/api.env; set +a
   curl -s -X POST -H "Authorization: Bearer $HUNT_ADMIN_TOKEN" http://127.0.0.1:3000/api/hunts/kill-switch
   ```
2. **No more scenarios**: `systemctl stop haunted-scenario.timer` (and `systemctl disable` to keep it off after a reboot). A running scenario is stopped with `systemctl stop haunted-scenario.service`, which resets the lab.
3. **Hunts off in the environment**: set `HUNTS_ENABLED=false` in `/etc/haunted/api.env` and `systemctl restart haunted-api`. The guard accepts `false`.

## Rollback

`bash /opt/haunted-ops/current/deploy/server/rollback.sh` points `current` at the previous release and restarts the API. Running it again goes forward. It does not undo database migrations.

## Teardown

1. Stop the timer and the services (`systemctl stop haunted-scenario.timer haunted-api haunted-lab`).
2. Terminate the instance, release the Elastic IP, delete the disk if it was kept, the instance profile and role, the security group and the published tarball.
3. Revoke the kiro-cli login of `hops` in the Kiro account if the account allows it.
4. Remove the link from the README.

## Notes

- The `hops` user may reach loopback, TCP 443 and DNS. `hlab`, `prometheus` and `postgres` may reach loopback only. No user but root may reach the instance metadata address.
- The scenario timer causes the only hunts: each scenario opens an incident, the API waits `HUNT_SETTLE_MS` and hunts the most downstream service once. The public cannot start a hunt.
- If the API or the lab is down, `https://<domain>/?demo=1` still plays the scripted incident in the browser.
