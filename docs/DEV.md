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
| `TEST_DATABASE_URL` | integration tests | no | separate test database; tests refuse to run if it equals `DATABASE_URL` |
| `VITE_API_BASE_URL` | web | no | API base URL, default `http://localhost:3000` |

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

## Checks and tests

```sh
pnpm typecheck     # all packages
pnpm lint          # all packages
pnpm test          # unit and property tests, plus integration tests when TEST_DATABASE_URL is set
pnpm build         # deterministic build
pnpm check:build   # builds twice from clean and compares output hashes
```

- Unit and property tests (Vitest and fast-check) never need a database.
- Integration tests that need a database read `TEST_DATABASE_URL` from the environment or `apps/api/.env`.
  - Unset: they are skipped and the run prints `TEST_DATABASE_URL is not set: database integration tests are skipped.`
  - Equal to `DATABASE_URL`: the run stops with `TEST_DATABASE_URL equals DATABASE_URL: refusing to run integration tests.`
  - Set: global setup drops and recreates the `public` schema of the test database, applies the committed migrations, and each suite clears the tables it uses. Only the test database is touched.
- To run without the database even when `apps/api/.env` sets it: `TEST_DATABASE_URL= pnpm test`.
