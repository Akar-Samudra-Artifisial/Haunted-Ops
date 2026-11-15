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
- Build manifest: `apps/web/vite.config.ts` sets `build.manifest: true` only so the bundle check can find the scene chunk. The manifest (`apps/web/dist/.vite/`) lists every chunk and source path and is not needed at run time, so `deploy/build-release.sh` removes `dist/.vite/` from the release, and Caddy answers 404 for `/.vite/` (see `docs/DEPLOY.md`).
- The judge deploy sets `VITE_DEMO_MODE=true` on purpose. It is read at build time (`apps/web/src/scene/params.ts`) and only lets a production build accept `?demo=1`, `?demo=1&loop=1` and `?demo=<scenario>`: the page then draws scripted or frozen demo data in the browser, makes no API request, says "Demo data, not live" in the header, and publishes `window.__hauntedScene` (frame time, particle count, quality) for measurement. It turns on nothing else: no admin action, no hunt, no extra endpoint, and without a `demo` parameter the page shows live data as usual. Any other deploy leaves it `false`.
- Visual checklist: all twelve scenarios at 360, 1280 and 3840 px; reduced motion on (two shots a moment apart must be equal); keyboard only; WebGL off (the message appears and the table works).

## Accessible mode
A page-level switch (`apps/web/src/a11y/`). On, the scene is not mounted and its chunk is never requested; the table, the hunt detail and the live announcer stay.
- Turn it on with the header button "Accessible mode" (`aria-pressed`), or `?mode=accessible`. `?mode=scene` turns it off for the session without changing the saved choice. Order of precedence: `?mode=scene`, `?mode=accessible`, the saved choice, `prefers-reduced-motion`, off. It combines with demo mode: `/?demo=payments-haunted&mode=accessible`.
- The saved choice is `{"mode":"on"}` or `{"mode":"off"}` in `localStorage` under `haunted-ops.a11y.v1`. A missing, blocked or broken storage counts as no choice. To reset: delete that key.
- The announcer (`components/LiveAnnouncer.tsx`) is the only live region of the page body. Its queue drops a sentence repeated within 10 s, releases one per 2 s, and keeps at most 5 waiting (oldest dropped).
- `data-a11y="on"` on `<html>` stops every animation and transition (the same rule as `prefers-reduced-motion`). The colours of `styles.css` are custom properties, and `a11y/contrast.test.ts` lists every pair with its minimum (4.5 text, 3 UI).
- E2E: `pnpm --filter @haunted-ops/web test:e2e` runs `e2e/accessible.spec.ts` (no scene request or canvas, keyboard path, switch both ways, reduced-motion emulation).
- Manual screen-reader checklist (VoiceOver on macOS, NVDA on Windows), open `/?mode=accessible&demo=1`: the skip link is read first and moves to "Services"; the switch is read as a toggle button; each row is read with its level, reason, error ratio and hunt; opening a row reads "Hunt on <service>" and its steps; each change is spoken once as the demo runs, no more than one sentence every 2 s; Escape returns to the row; nothing moves on the page.
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
| `KIRO_API_KEY` | unset | optional Kiro API key for the hunt process only (printable ASCII, no space, 20 to 512 characters; a bad one stops the start, naming the variable). Unset: the `kiro-cli` login of `HOME` is used. The fixer and every other child never get it. The demo server sets it through `/etc/haunted/kiro.env` (`docs/DEPLOY.md`) |
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

## The fix flow (a pull request that a human merges)
When a Hunt succeeds, the API can draft a fix: a second agent, `exorcist-fixer` (`.kiro/agents/exorcist-fixer.json`, tools `fs_read` and `fs_write` only), edits a copy of the culprit Service, the API checks the patch and runs the Service tests, and the server pushes `incident/<huntId>` and `exorcist/<huntId>` and opens a pull request on the lab repo. If the AI patch fails a Check, the API tries `git revert` of the culprit commit instead. A person approves by merging the pull request on GitHub. The API never merges, closes or edits a pull request. After the merge the API asks the lab to deploy exactly the merged commit (`POST /chaos/deploy-fix`, the lab spec `fix-deploy`). Everything is off unless `FIX_ENABLED=true`.
- **The GitHub token.** `GITHUB_TOKEN` is a fine-grained personal access token; a classic token is refused (the API accepts only the `github_pat_` form). Create it with resource owner `Akar-Samudra-Artifisial`, repository access to `Haunted-Lab` only, repository permissions Contents and Pull requests read and write (GitHub adds Metadata read), and an expiry of 60 days. Put it only in `apps/api/.env` (git-ignored) or the process environment. It never goes into the repo, a log, a fixture, a screenshot or a pull request. The API hands it to `git push` and `git fetch` only as `GIT_CONFIG_*` for `https://github.com/`, and to `https://api.github.com` as a bearer header.
- **Rulesets on `Haunted-Lab`.** A Contents write token can write any branch, so two rulesets limit the damage: `lock-scenario` (target `scenario/*`: no update, no deletion, no force push) and `protect-main` (target `main`: no deletion, no force push). The API itself pushes only `incident/<cuid>` and `exorcist/<cuid>` and never forces.
- **Settings** (every name is in `.env.example`; the values below are the defaults):

  | Variable | Default | Notes |
  | --- | --- | --- |
  | `FIX_ENABLED` | `false` | needs `HUNTS_ENABLED=true`, `GITHUB_TOKEN`, `LAB_GITHUB_REPO` (`owner/name`), `CHAOS_TOKEN`, `WEB_ORIGIN`, an absolute `git` and an executable `kiro-cli`. Refused on Node older than 25 |
  | `CHAOS_URL`, `CHAOS_TOKEN` | `http://127.0.0.1:4100`, none | the lab chaos API (the deploy route) and its bearer token, 24+ characters, different from the other tokens. Sent only to `CHAOS_URL` |
  | `FIX_MODEL` | `claude-sonnet-5.5` | pinned model of the fixer; `auto` is refused |
  | `FIX_CREDIT_CAP` | `1.5` | Credits per fixer run (0.1 to 10). A run with no Credits report is charged the cap and marked estimated |
  | `FIX_TIMEOUT_MS`, `FIX_MAX_TOOL_CALLS` | `120000`, `30` | wall clock of the fixer (10000 to 300000) and its tool calls (3 to 60) |
  | `FIX_TEST_TIMEOUT_MS`, `FIX_REQUIRE_TESTS` | `90000`, `true` | the test run on a candidate (10000 to 300000). With `true`, a Service with no test file fails the `tests` Check, and the revert fails with it. `false` opens the pull request with "no test ran" in its body |
  | `FIX_POLL_MS`, `FIX_BRANCH_TTL_DAYS` | `30000`, `7` | pull request polling (5000 to 300000), and the age at which finished `incident/*` and `exorcist/*` branches are deleted (hourly and at start) |
  | `FIX_DEPLOY_CONFIRM_MS` | `300000` | how long after the merge the lab may take to list the Deploy Record of the fix (10000 to 3600000) |
  | `FIX_WORKDIR` | `<os temp dir>/haunted-ops-fix` | the API's own clone, the fixer folders and pid notes; absolute and outside every git repository; required in production (mode 0700) |

  The caps of the Hunts also count the fix: the day's Credits (`HUNT_DAILY_CREDIT_CAP`) include Proposal Credits, and a fixer run counts toward `HUNT_DAILY_MAX`. Over either, the AI path is skipped and the revert is tried. The Kill switch (`POST /api/hunts/kill-switch`) stops a running fixer and refuses new Proposals. The operator retry is `POST /api/hunts/<huntId>/proposal` with `Authorization: Bearer $HUNT_ADMIN_TOKEN`; it answers 409 while a Proposal is active or already final. `GET /api/proposals/<id>` is public.
- **What runs where.** The API (port 3000 by default, 3100 for the gate below) holds the tokens, the clone, the fixer process and the GitHub calls. The fixer (`kiro-cli` in its own process group, environment of `PATH`, `HOME`, `LANG`, `TERM` and `NO_COLOR`) runs in `<FIX_WORKDIR>/fixer/<proposalId>/work`, a folder outside every repository that holds the files of one Service, a read-only `packages/lab-common` and the agent file; it never sees the token. The Service tests run in a throwaway clone under `node --permission` with an environment of `PATH` only. The lab supervisor (repo `haunted-lab`) serves the chaos and read routes and does the deploy; Prometheus feeds the haunt score. GitHub holds the branches, the pull request and the merge.
- **The test run.** A service whose `package.json` has a `test` script that starts with `vitest` (every lab service) runs with the lab's own vitest; any other runs under `node --test`. The lab tests import `vitest` and the workspace package `@haunted-lab/common`, and a candidate clone has no `node_modules`, so the API installs the lab tree itself:
  - **Dependency tree.** With `FIX_ENABLED=true` the API looks up `pnpm` on `PATH` (like `git`; a warning at startup when it is missing). At startup, and again for the lockfile of the commit under test when it differs, it copies the lab's `pnpm-lock.yaml`, `pnpm-workspace.yaml` and every `package.json` from its own copy of the lab into `FIX_WORKDIR/deps/<hash>/` and runs `pnpm install --frozen-lockfile --ignore-scripts --prefer-offline` there, with only `PATH`, `HOME` (for the pnpm store), `LANG`, `CI=true` and two pnpm settings in the environment, and a 5-minute timeout. `<hash>` is the start of the SHA-256 of the lockfile, so the tree is reused while the lockfile does not change; trees of other lockfiles are removed. Log lines: `lab deps ready` or `lab deps failed` / `lab deps unavailable` with a code. The lab repo is never changed.
  - **Links.** For one run the clone gets `node_modules` links into that tree (the root `node_modules`, and per workspace package a folder of links; a workspace dependency links to the package of the clone itself). They are removed after the run, before the tested tree is compared with the commit. The fixer's folder never holds them.
  - **Fences.** vitest runs as `node --permission` from `services/<S>/` with `--pool=forks`, one worker and no module cache, and its JSON report is read for the counts. Its main process may read the clone, the tree and the `node` binary, write only `<clone>/.fix-tmp`, start child processes (its forks pool) and load addons (the native binding of its bundler, rolldown). It does not run code of the clone: files are only transformed there, and a clone with a vitest or vite config file is refused. Each test worker is forked with its own `--execArgv` fence: the same reads and the same write folder, and no child process, no worker, no addon, no WASI and no network. The `threads` pool is not used, because on Node 26 a worker thread started with an `execArgv` of its own runs outside the permission model (a test shows it). The environment is `PATH`, plus `HOME` and `TMPDIR` inside `.fix-tmp` (vitest writes a token file under the user data folder and its pool writes temporary files).
  - **Not a boundary on the Mac.** This sandbox limits files and network for the test code, but it is not a security boundary against code that uses addons or child processes, which the vitest main process is allowed. The demo server of `deploy-demo` never runs the fixer or fix deploys; a separate OS user for the test run is future work.
  - **Sandbox-green set.** Network stays denied (`--allow-net` is all or nothing), and some lab tests talk over loopback HTTP (payments `routes.test.ts`), so they cannot pass in the sandbox. At startup, and again when the lab `main` head or its lockfile changes, the API clones `main` and runs every test file of every vitest service alone in the sandbox. The files that pass form the set of the service; the others are left out as `needs_network` (a message names `--allow-net`, or a test timed out inside vitest), `timeout` or `failed`. The `tests` check of a candidate runs only the set of its service; an empty set is recorded as skipped (below). The log has one `test baseline` line per service, and the pull request lists "Tests run in the sandbox" and "Not run in the sandbox" with the reason. For payments the set holds `refunds.test.ts` and leaves out `routes.test.ts` (needs network).
  - **What runs today** (at the lab's `main`, checked by `apps/api/test/check-run-lab.int.test.ts`):

    | Service | Runs in the sandbox | Left out |
    | --- | --- | --- |
    | payments | `refunds.test.ts` (the unit test of the `error-spike` culprit file) | `routes.test.ts`: needs network (loopback HTTP) |
    | ledger | `config.test.ts` | `routes.test.ts`: needs network |
    | orders | none | `routes.test.ts`: needs network; `inventory.test.ts`: failed, because it imports `scripts/scenario-copy.mjs`, which writes a patched copy into `services/orders/` and the sandbox allows writes only in `.fix-tmp` |
    | gate | none | `chain.test.ts`: needs network (it starts the other services) |

    A `failed` file has its first error line (cleaned, 200 characters) in the `test baseline` log. The lab branches are pinned, so this is handled in the API. To grow a set, the lab needs test files that import nothing outside `services/<S>/` and `packages/lab-common/`, write nothing outside a temporary folder and open no socket.
  - **Empty set: tests skipped, out loud.** For a vitest service with no sandbox-green file (orders and gate today), the `tests` check is recorded as `{ name: 'tests', ok: true, skipped: true, detail: 'no sandbox-green tests for <service>' }` and the log has `check run skipped`. The checks before it (`non_empty`, `scope`, `forbidden_file`, `size`, `syntax`; for a revert, `scope` and `forbidden_file`) still gate the patch. The pull request body says near the top "No automated tests ran in the sandbox for this service. Review the diff carefully.", the `proposal.checks` event and the stored checks carry `skipped`, and the table shows "tests skipped". If at least one file is in the set and it fails, `tests` fails and the revert is tried as before.
  - **Diagnostics.** A failing run writes one `check run failed` log line: the runner, a code (`tests_failed`, `timeout`, `no_report`, `lab_deps_unavailable`, `vitest_config_present`, and so on), the counts, the first 2 KiB of stderr and the first failing suite's message, with every absolute path replaced by `[path]`. It never reaches the pull request or a public answer.
- **Why a fixer run was not used.** Every fixer run keeps its stream in `FIX_WORKDIR/streams/<proposalId>.fixer.stream.jsonl` (mode 0600, files older than 7 days are deleted at start and before each run), reduced like the Hunt streams: tool calls with title and input, updates, Credits and run ends, no model text and no tool output. When the run is not used, the log has one `fixer halted` line with `fixerHalt: { code, detail }`, and the Proposal row keeps `<code>: <detail>` in the column `aiFailDetail` (at most 300 characters). `GET /api/proposals/:id` returns it as `aiFailDetail` next to `aiFailReason`, scrubbed again (one line, an absolute path as `[path]`, token-like text as `[redacted]`); the summary and the events do not carry it. Codes: `foreign_tool`, `unknown_args`, `path_outside`, `write_outside_scope` (an `fs_write` outside `services/<S>/src/`), `unknown_update` (the guard; the detail names the title, the event kind and the sorted key names of the input, never a value), `timeout`, `credit_cap`, `tool_limit`, `stream_malformed`, `exit_code`, `stopped`, `not_started`, and from the runner `agent_changed`, `no_write`, `empty_diff`, `step_error` (an error after the spawn, with its class and message) and `fixer_not_started` (a setup error before it; the run does not count in the day's starts). The guard also stops on `image_read` (the mode `Image`) inside `unknown_args`. To read the shapes of a real run, give the stream file to `node scripts/fixer-stream-shapes.mjs`.
- **Isolation limits of the test run.** On the Mac the model's code runs as the same OS user as the API. `node --permission` limits reads and writes to the clone and denies child processes, workers, addons and, from Node 25, the network (a test checks that a child cannot open a socket). That is an application fence, not a kernel boundary, and Node has had bypasses, so treat it as defense in depth. The demo server of `deploy-demo` never runs the fixer or the test run (`FIX_ENABLED=false`, no GitHub token); a separate OS user with no instance role, no instance metadata and no network is future work. The test run stays behind one function (`runChecks`) so its launcher can be replaced.
- **With no Credits.** `tools/fake-kiro-cli` (`fake-kiro-fixer.mjs`, `fake-github.mjs`, `fake-lab.mjs`) stands in for `kiro-cli`, GitHub and the lab. The tests that use it (`apps/api/test/fix.int.test.ts` and the unit tests in `apps/api/src/fix`) spend nothing and touch no network.
- **Opt-in live test** (one real fixer and one real pull request, about 1 Credit, never part of `pnpm test`). Run the pre-flight first: it spends no Credits and does not call the model; it prints one `OK` or `FAIL` line per check (the `kiro-cli` version is 3.3.0, `kiro-cli whoami`, the mode of `~/Library/Application Support/kiro-cli`, the names of the environment variables below, the lab, Prometheus, the Test database, and the token's read access to the lab repository with only the HTTP status) and exits 0 only when all pass. Then run the live test, twice:
  ```sh
  pnpm --filter @haunted-ops/api preflight:live
  FIX_LIVE=1 pnpm --filter @haunted-ops/api test:live
  FIX_LIVE=1 pnpm --filter @haunted-ops/api test:live
  ```
  The live test builds its app with the same helper as the parity test (`apps/api/test-live/live-app.ts`, `apps/api/test/fix.live-parity.int.test.ts`, which runs with no Credits against fakes), so its wiring is exercised in `pnpm test`: the fixer gets `HOME` and `LANG` of the environment, and the startup check and `ProposalRunner.start()` run as in `main.ts`. It prints the `kiro-cli` version and the stream file name at its start, waits for the lab dependencies and the test baseline, then gives the proposal `FIX_TIMEOUT_MS` plus 60 seconds and prints one line per status change. When the proposal does not open, it first prints the status, kind, reasons, `aiFailDetail` and checks of the proposal and the last 40 log lines about it. It needs the lab supervisor running and, in the environment, `GITHUB_TOKEN`, `LAB_GITHUB_REPO`, `CHAOS_URL`, `CHAOS_TOKEN`, `WEB_ORIGIN`, `LAB_URL`, `LAB_READ_TOKEN`, `HUNT_ADMIN_TOKEN`, `KIRO_CLI_PATH`, `PROMETHEUS_URL` and `TEST_DATABASE_URL`. It applies `error-spike`, writes a succeeded Hunt that names the planted commit (no Hunt runs), waits for the pull request, then, in a `finally`, closes it and deletes its `incident/<huntId>` and `exorcist/<huntId>` branches through its own REST helper, which refuses every other branch name. Without `FIX_LIVE=1` the fix test is skipped.
- **Recording a fixer run.** To pin the title and input shapes of `fs_read` and `fs_write`, run `node scripts/fixer-stream-shapes.mjs <stream.jsonl>` (it prints names and counts only). The fixtures made from the tool schema of kiro-cli 3.3.0 rather than from a run (`create`, `insert`, `Image`, a changed title and the others of task 22) are listed in that script as schema-derived, not recorded. To make a fixture, run `node scripts/sanitize-fixer-stream.mjs --work <work folder> <raw.jsonl> <out.jsonl>`: it keeps tool calls with paths relative to the work folder, drops every agent message and any environment value, and prints a checklist for the human review that must follow.
- **Gate G-MVP** (one real Hunt, one fixer run and one real merge, about 2.5 Credits). Start three things, in this order:
  1. The lab: the supervisor (chaos and read routes on port 4100, with the `fix-deploy` route) and Prometheus. Check it with `curl -s http://127.0.0.1:4100/healthz`.
  2. The API with `FIX_ENABLED=true` and `PORT=3100` in `apps/api/.env`, plus the variables of the table above and of the Hunts section. `CHAOS_TOKEN` in `apps/api/.env` must be the same value as the lab's `CHAOS_TOKEN`: at startup the API calls the lab's `GET /chaos/state` with it (authenticated, changes nothing) and refuses to start with `CHAOS_TOKEN rejected by the lab` on a 401 (an unreachable lab is only a warning). The first live run failed with a 401 at the deploy because the two differed. Check the API with `curl -s http://127.0.0.1:3100/healthz`.
  3. The script, with `CHAOS_TOKEN` in the same file:
     ```sh
     node --env-file=apps/api/.env scripts/gmvp-fix.mjs
     ```

  The script waits for a calm lab, applies the scenario (`SCENARIO`, default `error-spike`), waits for the Hunt and for the Proposal to be `open`, and prints the hunt id, the path of the Hunt stream file and the pull request URL on a line of its own. **A person then reviews and merges that pull request on GitHub.** The script never merges, closes or edits it, and fails the gate if nobody merges within `MERGE_WAIT_MS` (default 900000, 15 minutes). After the merge it waits for `deployed` and for every Incident to close, prints a table (scenario, kind, checks, pull request, merged by, Credits, durations, result) and exits 0 on PASS. It resets the lab at the end, also on failure and on Ctrl-C. `API_URL` defaults to `http://127.0.0.1:3100` and `CHAOS_URL` to `http://127.0.0.1:4100`. The chaos token goes only to `CHAOS_URL` and is never printed.
## Checks and tests

```sh
pnpm typecheck     # all packages
pnpm lint          # all packages
pnpm test          # unit and property tests (and the G1 script tests), plus integration tests when TEST_DATABASE_URL is set
pnpm build         # deterministic build
pnpm check:build   # builds twice from clean and compares output hashes
pnpm --filter @haunted-ops/api db:drift   # migrations against the Prisma schema; exit 0 means no drift
```

- `db:drift` replays the migrations into a shadow database. `prisma.config.ts` takes it from `TEST_DATABASE_URL` (when set and different from `DATABASE_URL`), so it needs that variable and resets that database, like the integration tests do.
- `apps/api/test/check-run-lab.int.test.ts` runs the real vitest runner against a copy of `../haunted-lab` (installs the lab tree with `pnpm` into a temporary folder; skipped when the lab or `pnpm` is missing).

- Unit and property tests (Vitest and fast-check) never need a database.
- Integration tests that need a database read `TEST_DATABASE_URL` from the environment or `apps/api/.env`.
  - Unset: they are skipped and the run prints `TEST_DATABASE_URL is not set: database integration tests are skipped.`
  - Equal to `DATABASE_URL`: the run stops with `TEST_DATABASE_URL equals DATABASE_URL: refusing to run integration tests.`
  - Set: global setup drops and recreates the `public` schema of the test database, applies the committed migrations, and each suite clears the tables it uses. Only the test database is touched.
- To run without the database even when `apps/api/.env` sets it: `TEST_DATABASE_URL= pnpm test`.
