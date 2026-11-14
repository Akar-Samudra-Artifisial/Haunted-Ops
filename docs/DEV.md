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
- Demo mode drives the scene and the table from a script, with no API: `http://localhost:5173/?demo=1` (add `&loop=1` to repeat), or a frozen state `?demo=calm`, `payments-haunted`, `payments-possessed`, `orders-fog`, `ledger-dark`, `all-haunted`, or the hunt states `payments-hunting`, `payments-sealed`, `payments-fizzled`, or the fix states `payments-fixing`, `payments-fix-open`, `payments-fix-deployed`. The timeline also runs a Hunt on payments (queued 9 s, started 10 s, a step every 3 s from 12 s, the diagnosis at 26 s). The header says "Demo data, not live". It works in development; a production build needs `VITE_DEMO_MODE=true`.
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
- Visual checklist: all twelve scenarios at 360, 1280 and 3840 px; reduced motion on (two shots a moment apart must be equal); keyboard only; WebGL off (the message appears and the table works).

## Hunts (the Exorcist agent)

When an Incident opens at level 2 or higher, the API can run a Hunt: a headless `kiro-cli` with the committed agent `.kiro/agents/exorcist.json` reads the lab through six read-only MCP tools (`packages/exorcist-mcp`), submits one diagnosis, and the API checks it against the lab before it publishes it. Hunts are **off by default** and a live Hunt spends Credits (about 1 per Hunt on the pinned model).

| Variable | Default | Notes |
| --- | --- | --- |
| `HUNTS_ENABLED` | `false` | Must be `true` for any Hunt to start. This is the environment half of the Kill switch |
| `LAB_URL` | `http://127.0.0.1:4100` | origin of the lab supervisor (`/lab/*`); loopback unless `LAB_ALLOW_REMOTE=true`, never link-local |
| `LAB_READ_TOKEN` | none | bearer for `/lab/*`, 24+ characters, required when hunts are on. Must differ from `HUNT_ADMIN_TOKEN`. The same value is handed to the MCP server, never to the model |
| `LAB_ALLOW_REMOTE` | `false` | allow a `LAB_URL` that is not loopback |
| `HUNT_ADMIN_TOKEN` | none | bearer for `POST /api/hunts` and `POST /api/hunts/kill-switch`, 24+ characters, required when hunts are on. Compared in constant time |
| `KIRO_CLI_PATH` | `kiro-cli` | the `kiro-cli` to run; with hunts on it must resolve to an executable file. Point it at a fake to run with no Credits (below) |
| `EXORCIST_MODEL` | `claude-sonnet-5.5` | pinned model; `auto` is refused |
| `HUNT_CREDIT_CAP` | `1.5` | per Hunt. `kiro-cli` reports Credits once per turn, so the cap acts when the report arrives (after the run); the tool limit and the timeout bound a run |
| `HUNT_DAILY_CREDIT_CAP` | `30` | per UTC day. A Hunt starts only if the day's total plus `HUNT_CREDIT_CAP` fits |
| `HUNT_TIMEOUT_MS` | `90000` | wall clock; SIGTERM to the process group, SIGKILL after 2 s |
| `HUNT_COOLDOWN_MS` | `120000` | an automatic Hunt for a Service that finished a Hunt less than this ago is cancelled (`cooldown`); an operator request is not held back |
| `HUNT_SETTLE_MS` | `10000` | integer 0 to 60000. After an Incident opens at level 2 or higher, an automatic Hunt waits this long, then hunts only the most downstream Service among the Open Incidents (see below). An operator request does not wait |
| `HUNT_DAILY_MAX` | `40` | integer 1 to 500. Hunts that may start per UTC day, automatic and operator together. A request beyond it is recorded `cancelled` with the reason `daily_limit` |
| `HUNT_MAX_TOOL_CALLS` | `20` | a Hunt with more tool calls (including `Tool Load`) is stopped (`tool_limit`) |
| `HUNT_WORKDIR` | `<tmp>/haunted-ops-hunts` (development only) | with `NODE_ENV=production` and hunts on it is required, and an existing folder must belong to the server user with mode 0700. The Hunt's working directory. It must be outside every git repository and `.kiro/steering` folder; the API copies the agent file into it and removes everything else, so no project steering, hooks or files reach the agent. A folder with files that this API did not make is refused |

Startup fails naming the variable (never the value) when one is invalid, and the API exits 1 if the working folder is refused.

Review notes (task 14):

- **Estimated credits.** `kiro-cli` reports Credits once, at the end. A Hunt that started and ended without that report (timeout, foreign tool, kill switch, crash) is recorded with `HUNT_CREDIT_CAP` as its Credits and `creditsEstimated: true` in `GET /api/hunts/:id`; it counts in the daily budget. A Hunt whose process never started records 0.
- **Pid notes.** While a Hunt runs, `<HUNT_WORKDIR>/<huntId>.pid` holds its pid and process group. At start the API kills the group of any note whose process still runs `kiro-cli` (SIGTERM, SIGKILL after 2 s) before it marks stale Hunts `api_restart`, then deletes the notes. A pid that is not a `kiro-cli` process is never touched.
- **A diagnosis before a stop.** A valid diagnosis that arrived before a `credit_cap` or `tool_limit` stop still counts: the Hunt ends `succeeded` and the stop is in `stopDetail`.
- **Model text.** The summary (400 characters) and the fix hint (300) have control and direction characters, URLs, markdown links and HTML tags removed. The web shows them as plain text with an "AI generated" label.
- **Fixtures.** `tools/sanitize-replay/sanitize-hunt-stream.mjs` drops agent messages by default; `--keep-messages` keeps the final one. The recorded live fixtures hold no message text.

- **Cascades.** The lab is one call chain: `gate` calls `orders`, `orders` calls `payments`, `payments` calls `ledger` (`SERVICE_DEPENDENCIES` in `packages/shared`). A fault in one Service breaks every caller upstream, so one fault opens two or three Incidents within seconds. The runner waits `HUNT_SETTLE_MS`, then starts one `auto` Hunt for the most downstream Service with an Open Incident; the others are linked to it (one `hunt linked` log line each) and get no Hunt. A queued automatic Hunt of an upstream Service is withdrawn (`cancelled`, reason `downstream`) when a downstream one is requested; a running Hunt is never stopped. A Hunt may name a culprit deploy of its own Service or of any Service downstream of it; the diagnosis then carries `culpritService`, and the table and scene say "caused by <service>".
- **The `Tool Call` wrapper and late Incidents.** kiro-cli 3.3.0 sometimes calls an MCP tool through a generic `Tool Call` with `rawInput { tool_id: "tool::exorcist::<tool>", arguments: {...} }` instead of `@exorcist/<tool>`; the allow-list accepts exactly that form for the six tools and refuses any other `tool_id` (the `stopDetail` then reads `Tool Call tool_id=<id>`). A Service can open its Incident later than the settle window (`ledger` needs the scrape and the hysteresis, about 25 s). When a Hunt on one Service names another Service as the cause, a queued automatic Hunt of that Service is withdrawn, and so is a request for an Incident that opened after the first Hunt's Incident and no later than `HUNT_SETTLE_MS` after the diagnosis: both end as `cancelled` with the reason `diagnosed_upstream`, `diagnosedBy` (the Service of that Hunt) and `linkedHuntId` in `GET /api/hunts/<id>`, and the table says "diagnosed by the <service> hunt". Operator requests are never withdrawn.
- **When a live Hunt stops for a tool.** `GET /api/hunts/<id>` shows `stopDetail`: for `foreign_tool` the refused tool title and, for a `Tool Load`, its ids (cleaned, at most 200 characters), also in one log line. Each Hunt also leaves its reduced stream in `HUNT_WORKDIR/<huntId>.stream.jsonl` (mode 0600, the newest 20 are kept): tool calls with title and input, updates without the tool output, Credits and run ends; no model text and no secret. To make a fixture of a failed live run, run `node tools/sanitize-replay/sanitize-hunt-stream.mjs <that file> <fixture>.stream.jsonl` and read the result before committing it.
- **Operator routes** (the only ways to start or stop Hunts by hand), with `Authorization: Bearer $HUNT_ADMIN_TOKEN`:
  ```sh
  curl -s -X POST localhost:3000/api/hunts -H "authorization: Bearer $HUNT_ADMIN_TOKEN" -H 'content-type: application/json' -d '{"service":"payments"}'   # 202 { huntId, status, reason }, 5 per minute
  curl -s -X POST localhost:3000/api/hunts/kill-switch -H "authorization: Bearer $HUNT_ADMIN_TOKEN" -H 'content-type: application/json' -d '{"enabled":false}'   # stops a running Hunt now
  curl -s localhost:3000/api/hunts/<huntId>    # the Hunt, its steps, evidence and diagnosis (no auth)
  ```
  The Kill switch can turn Hunts off at any time. It can turn them on again only when `HUNTS_ENABLED=true`. A request that cannot run (busy, cooldown, off) still answers 202 and is recorded as `cancelled` with its reason.
- **With no Credits (fake kiro-cli).** `tools/fake-kiro-cli` accepts the same arguments as the real one and drives the real MCP server through scripted tool calls against `tools/fake-kiro-cli/fake-lab.mjs`. `KIRO_CLI_PATH` points at a one-line wrapper that sets `FAKE_KIRO_FIXTURE` (a name in `tools/fake-kiro-cli/fixtures/`, for example `error-spike`, `foreign-tool`, `over-cap`, `timeout`); `createFakeKiroCli({ fixture })` in `tools/fake-kiro-cli/wrapper.mjs` makes one. The API integration tests (`apps/api/test/hunts.int.test.ts`) run every fixture end to end this way. The agent allow-list is checked twice, by the agent file and by `--trust-tools`, and again by the API on every tool call in the stream.
- **Allow-list probe** (spends about 0.1 Credit): run the real `kiro-cli chat --no-interactive --agent exorcist` from an empty folder holding only `.kiro/agents/exorcist.json`, ask it to run `ls` and read a file, and see that it makes no tool call and says its only tools are the six `exorcist` ones. The result of the last probe is in `.kiro/specs/exorcist-agent/tasks.md` (Task 3 outcome).
- **Opt-in live test** (one real Hunt, about 1 Credit, never part of `pnpm test`): with the lab running, hunts enabled and a real `kiro-cli`,
  ```sh
  HUNT_LIVE=1 pnpm --filter @haunted-ops/api test:live
  ```
  It needs `LAB_URL`, `LAB_READ_TOKEN`, `HUNT_ADMIN_TOKEN`, `KIRO_CLI_PATH`, `PROMETHEUS_URL`, `CHAOS_URL`, `CHAOS_TOKEN` and `TEST_DATABASE_URL`, applies `error-spike`, and expects a Valid diagnosis with the planted commit. Without `HUNT_LIVE=1` it is skipped.
- **Gate G2** (three live Hunts, about 3 Credits): with the lab, the API (`HUNTS_ENABLED=true`, real `KIRO_CLI_PATH`) and Prometheus running, put `CHAOS_TOKEN` in `apps/api/.env` and run
  ```sh
  node --env-file=apps/api/.env scripts/g2-hunt.mjs
  ```
  For `error-spike`, `fog` and `dark-room` it applies the scenario and watches the latest Hunt of every Service (up to 180 s, and until no Hunt has changed for 25 s). The scenario PASSES when exactly one Hunt succeeded with the planted SHA from `../haunted-lab/scripts/scenario-shas.json` (`SCENARIO_SHAS` overrides the path) and `culpritService` equal to the root Service (`payments`, `orders`, `ledger`), whichever Service was hunted, and no Hunt failed. The table lists the hunted Service, the Service of the culprit, the other Hunts as `service:reason` (for example `ledger:diagnosed_upstream`), the Credits of all Hunts and the duration of the successful one. It then resets and waits (at most 120 s) until every Incident is closed, and exits 0 or 1. It resets on failure and Ctrl-C and never prints the token. The pure parts are unit tested with a fake lab (`scripts/g2-hunt.test.mjs`).
- Nothing in the repo, the logs, the events or the HTTP answers carries a token, the prompt, a host path or the agent's text; the stream is parsed for a few fields and dropped.

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
