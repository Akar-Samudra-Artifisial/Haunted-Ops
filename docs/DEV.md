# Local development

This guide sets up Haunted Ops on a Mac: the API (`apps/api`), the web shell (`apps/web`) and the shared package (`packages/shared`).

## Prerequisites

- Node 26 (see `.nvmrc`).
- pnpm 11.7.0 (pinned in `package.json` through `packageManager`), for example from Homebrew (`brew install pnpm`) or the standalone installer on pnpm.io. pnpm only: npm and yarn are not used.
- PostgreSQL 17 from Homebrew: `brew install postgresql@17`. Podman and Docker are not needed.

## PostgreSQL

The Homebrew service is not running by default.

```sh
brew services start postgresql@17   # start
brew services stop postgresql@17    # stop
brew services list                  # check status
```

The client tools live in `$(brew --prefix postgresql@17)/bin` (`psql`, `createdb`, `pg_isready`). Add that folder to `PATH` or call them by full path.

Create the dev and test databases once:

```sh
createdb haunted_dev
createdb haunted_test
```

## Environment variables

Copy the API block of `.env.example` to `apps/api/.env` and the web block to `apps/web/.env`, then edit the values. Both files are git-ignored. Never put real values in the repo, logs or screenshots.

| Variable | Used by | Required | Notes |
| --- | --- | --- | --- |
| `DATABASE_URL` | API, migrate, seed | yes | `postgres://` or `postgresql://` URL of the dev database |
| `PORT` | API | yes | integer from 1 to 65535 |
| `WEB_ORIGIN` | API (CORS) | yes | exact origin of the web app, for example `http://localhost:5173`, no path |
| `HOST` | API | no | listen address, default `127.0.0.1` (local only); production sets it, for example `0.0.0.0` behind a proxy |
| `SSE_MAX_CLIENTS` | API | no | positive integer, default 100 |
| `SSE_MAX_CLIENTS_PER_IP` | API | no | open streams per client IP, default 5 |
| `RATE_LIMIT_MAX` | API | no | mutating requests per minute per client IP, default 30 |
| `TRUST_PROXY_HOPS` | API | no | integer 0 to 3, default 0. Number of reverse proxies in front of the API whose `X-Forwarded-For` is trusted. 0 trusts none, so the socket address is the client IP. Never set it higher than the real number of proxies: a client could then pick its own IP and dodge the per-IP limits |
| `PROMETHEUS_URL` | API | no | origin of the lab Prometheus: scheme, host, optional port, no path or credentials. Default `http://127.0.0.1:9090`; loopback hosts only unless `PROMETHEUS_ALLOW_REMOTE=true` |
| `PROMETHEUS_ALLOW_REMOTE` | API | no | `true` or `false`, default `false`. Without `true`, `PROMETHEUS_URL` must name a loopback host (`127.0.0.1`, `[::1]` or `localhost`). Link-local hosts (`169.254.0.0/16`, `fe80::/10`) are refused even with `true`, because cloud metadata endpoints live there. Startup fails naming `PROMETHEUS_URL`, never its value |
| `POLL_INTERVAL_MS` | API | no | integer 1000 to 60000, default 5000 |
| `POLL_TIMEOUT_MS` | API | no | integer 100 to 30000 and not above the interval, default `min(3000, interval)` |
| `SIGNAL_RETENTION_H` | API | no | Signals older than this many hours are deleted, 1 to 720, default 24 |
| `API_URL` | `scripts/g1-score.mjs` | no | API base URL, default `http://127.0.0.1:3000` |
| `CHAOS_URL` | `scripts/g1-score.mjs` | no | lab supervisor, default `http://127.0.0.1:4100` |
| `CHAOS_TOKEN` | `scripts/g1-score.mjs` | for the G1 script | bearer token of the lab chaos API (the same value the lab supervisor uses). Only the G1 script reads it; the API never does |
| `TEST_DATABASE_URL` | integration tests | no | separate test database; tests refuse to run if it equals `DATABASE_URL` |
| `VITE_API_BASE_URL` | web | no | API base URL, default `http://localhost:3000` |
| `VITE_DEMO_MODE` | web | no | `true` allows `?demo=` in a production build; in development it always works. Default `false` |

The API checks `DATABASE_URL`, `PORT`, `WEB_ORIGIN` and the optional variables at startup. If any is missing or invalid it prints `Invalid configuration: <NAMES>` (names only, never values) and exits with code 1 before listening.

The client IP (`req.ip`) used by the rate limit and the per-IP stream cap follows `TRUST_PROXY_HOPS`. Event ids on the stream look like `<bootId>-<n>`; the boot id is random per API process, so after a restart every client resyncs instead of resuming from a stale id.

## Install, migrate, seed

```sh
pnpm install                              # also generates the Prisma client
pnpm --filter @haunted-ops/shared build   # the API runtime imports the built shared package
pnpm --filter @haunted-ops/api db:migrate # prisma migrate deploy on DATABASE_URL
pnpm --filter @haunted-ops/api db:seed    # upserts gate, orders, payments, ledger; safe to repeat
```

To change the schema, edit `apps/api/prisma/schema.prisma` and run `pnpm --filter @haunted-ops/api db:migrate:dev --name <change>`. Read the generated SQL before committing it: the hand-written partial index `incident_one_open_per_service` in the first migration must not be dropped.

## Run

In two terminals:

```sh
pnpm build && pnpm --filter @haunted-ops/api start   # API on PORT, reads apps/api/.env
pnpm --filter @haunted-ops/web dev                   # web on http://localhost:5173
```

Check the API with `curl -s http://localhost:3000/healthz` and `curl -s http://localhost:3000/api/services`. Watch the stream with `curl -N http://localhost:3000/api/events`: a `heartbeat` event arrives every 15 seconds.

## Ingest and the haunt score
The API polls Prometheus every `POLL_INTERVAL_MS`, stores the values as Signals, turns them into a haunt level from 0 to 4 for each service (hysteresis: up after 2 polls, down after 3), opens an Incident at level 2 and closes it after 30 s at level 0, and publishes `service.updated` (with `previousLevel`), `incident.opened` (with `level` and `reason`), `incident.closed`, `ingest.polled` (at most every 30 s, and on a change of ingest status) and `ingest.status` on `GET /api/events`.
- `GET /api/services` returns each service with `reason`, `metrics` and `openIncident`. `reason` is the cause at the last change of level or reason kind (the value in it can be older); `metrics` hold the current numbers, and the web table shows the current value of the cause from them. `GET /api/ingest/status` returns `ok` or `stale`: stale means the last poll failed, and levels and incidents stay as they were.
- Run it against the lab: start the lab (see `haunted-lab/docs/DEV.md`: the supervisor and Prometheus on `127.0.0.1:9090`), apply the migrations (`db:migrate`), seed, then start the API. With the defaults no extra variable is needed.
- Thresholds are constants in `packages/shared/src/haunt.ts`: error ratio 0.05, 0.2, 0.5; p95 500, 1000, 3000 ms; `up` below 0.5 is level 4.
- Gate G1 (score): with the lab, the API and the web running, put `CHAOS_URL` and `CHAOS_TOKEN` in `apps/api/.env` (the token is the lab's, never committed) and run
  ```sh
  node --env-file=apps/api/.env scripts/g1-score.mjs
  ```
  `API_URL` (default `http://127.0.0.1:3000`) is the API the script reads: set it in `apps/api/.env` or the environment when port 3000 is busy and the API runs on another port (for example `PORT=3010` and `API_URL=http://127.0.0.1:3010`).
  It waits for a calm baseline, then for `error-spike`, `fog` and `dark-room` it applies the scenario, asserts within 60 s that payments, orders or ledger is at level 2 or higher (ledger 4) with the reason `error_rate`, `p95` or `down` and an open incident, resets, asserts level 0 within 120 s, prints a table and exits 0 or 1. It resets the lab again on failure or Ctrl-C and never prints the token.

## The house scene and the demo
The house (a 2.5D cutaway, one room per service) is drawn with PixiJS 8 in a chunk that loads after the header and the table. All of it lives in `apps/web/src/scene/`. If neither WebGL nor WebGPU can start, the scene shows a short message and the table stays the full view (PixiJS's 2D canvas renderer is not used).
- Demo mode drives the scene and the table from a script, with no API: `http://localhost:5173/?demo=1` (add `&loop=1` to repeat), or a frozen state `?demo=calm`, `payments-haunted`, `payments-possessed`, `orders-fog`, `ledger-dark`, `all-haunted`. The header says "Demo data, not live". It works in development; a production build needs `VITE_DEMO_MODE=true`.
- Keyboard: Tab goes through the rooms in reading order, the arrow keys jump to the nearest room, Home and End to the first and last, Escape clears. A focused room selects its row in the table, and the name button of a row selects the room.
- Reduced motion (`prefers-reduced-motion`) stops drifting, flicker and trembling and applies changes at once. Counts and densities stay the same.
- Smoke test with a real browser (software WebGL, no GPU): install Chromium inside the workspace once, then run it.
  ```sh
  PLAYWRIGHT_BROWSERS_PATH=0 pnpm --filter @haunted-ops/web exec playwright install chromium
  pnpm --filter @haunted-ops/web test:e2e     # opens ?demo=payments-haunted and ?demo=ledger-dark
  ```
  Screenshots go to `apps/web/test-results/screenshots/` (git-ignored). `SCENE_GALLERY=1` also captures every scenario at 360, 1280 and 3840 px in `test-results/gallery/`. Playwright empties `test-results/` at the start of each run, so a run of a single spec file removes the earlier shots. `e2e/no-webgl.spec.ts` checks the fallback by refusing WebGL contexts in the page.
- Bundle check, after `pnpm build`: `node scripts/check-scene-bundle.mjs`. It fails if PixiJS code reaches the entry chunk or a chunk is over its budget (entry 92 KiB, scene 180 KiB, gzip).
- Build manifest: `apps/web/vite.config.ts` sets `build.manifest: true` only so the bundle check can find the scene chunk. The manifest (`apps/web/dist/.vite/`) lists every chunk and source path and is not needed at run time, so the deploy step removes `dist/.vite/` from the published artifact (the `deploy-demo` spec does this).
- The judge deploy sets `VITE_DEMO_MODE=true` on purpose. It is read at build time (`apps/web/src/scene/params.ts`) and only lets a production build accept `?demo=1`, `?demo=1&loop=1` and `?demo=<scenario>`: the page then draws scripted or frozen demo data in the browser, makes no API request, says "Demo data, not live" in the header, and publishes `window.__hauntedScene` (frame time, particle count, quality) for measurement. It turns on nothing else: no admin action, no hunt, no extra endpoint, and without a `demo` parameter the page shows live data as usual. Any other deploy leaves it `false`.
- Visual checklist: all six scenarios at 360, 1280 and 3840 px; reduced motion on (two shots a moment apart must be equal); keyboard only; WebGL off (the message appears and the table works).

## Checks and tests

```sh
pnpm typecheck     # all packages
pnpm lint          # all packages
pnpm test          # unit and property tests (and the G1 script tests), plus integration tests when TEST_DATABASE_URL is set
pnpm build         # deterministic build
pnpm check:build   # builds twice from clean and compares output hashes
```

- Unit and property tests (Vitest and fast-check) never need a database.
- Integration tests that need a database read `TEST_DATABASE_URL` from the environment or `apps/api/.env`.
  - Unset: they are skipped and the run prints `TEST_DATABASE_URL is not set: database integration tests are skipped.`
  - Equal to `DATABASE_URL`: the run stops with `TEST_DATABASE_URL equals DATABASE_URL: refusing to run integration tests.`
  - Set: global setup drops and recreates the `public` schema of the test database, applies the committed migrations, and each suite clears the tables it uses. Only the test database is touched.
- To run without the database even when `apps/api/.env` sets it: `TEST_DATABASE_URL= pnpm test`.
