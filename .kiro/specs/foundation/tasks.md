# Implementation Plan: foundation

## Overview

Build the workspace, shared package, database, API shell with SSE, security baseline, web shell and dev docs, in about 10 top-level tasks. Each task ships with its tests. Property tests are their own sub-tasks and carry the comment `// Feature: foundation, Property N`. Integration tests need `TEST_DATABASE_URL`; unit and property tests never do.

## Tasks

- [x] 1. Workspace scaffolding and root scripts
  - [x] 1.1 Add root `tsconfig.base.json` (strict), ESLint config, Vitest config and `.env.example` with names and placeholder values only
    - _Requirements: 1.1, 1.6, 9.2_
  - [x] 1.2 Create `packages/shared`, `apps/api` and `apps/web` skeletons with exact-pinned dependencies from the design table; confirm the TypeScript 7 decorator risk and the Vitest decorator transform, and record the outcome in Notes
    - _Requirements: 1.1, 1.6_
  - [x] 1.3 Wire root scripts `typecheck`, `lint`, `test`, `build` and make Shared build before dependents
    - _Requirements: 1.2, 1.3, 1.4, 1.5_
  - [x] 1.4 Add `tools/check-build-determinism` script that runs `pnpm build` twice and compares output hashes
    - _Requirements: 1.5_
  - [x] 1.5 Add a smoke test per package so `pnpm test` runs and passes with no database
    - _Requirements: 1.4, 9.3_

- [x] 2. Shared types and validators
  - [x] 2.1 Define `ServiceName`, `ServiceState`, `HauntLevel`, `SignalKind`, SSE event names and payload types, and `Result<T>`
    - _Requirements: 2.1_
  - [x] 2.2 Implement total validators for Service state, Haunt level and each SSE payload, plus SSE wire format and parse helpers
    - _Requirements: 2.2, 2.3, 2.5_
  - [x] 2.3 Export everything from `index.ts`; API and Web import from `@haunted-ops/shared` and define no local copies
    - _Requirements: 2.4_
  - [x]* 2.4 Property test: validators are total and exact (Property 7)
    - _Requirements: 2.2, 2.3, 2.5_
  - [x]* 2.5 Property test: SSE payloads round-trip (Property 8)
    - _Requirements: 2.2, 6.2_

- [x] 3. API configuration
  - [x] 3.1 Implement `parseConfig` and `ConfigError` for `DATABASE_URL`, `PORT`, `WEB_ORIGIN`, `SSE_MAX_CLIENTS`, `RATE_LIMIT_MAX` with defaults 100 and 30
    - _Requirements: 4.1, 4.3, 4.5_
  - [x] 3.2 Make `main.ts` print the error with names only and exit 1 before `listen`; never print values
    - _Requirements: 4.2, 4.4_
  - [x]* 3.3 Property test: config validation rejects every missing or invalid variable and never echoes values (Property 6)
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

- [x] 4. Database schema, migrations, seed and test harness
  - [x] 4.1 Write `schema.prisma` with the six models, enums, foreign keys, the latest-signals index and the unique `[huntId, order]`; add `prisma.config.ts` and the `PrismaService` using `@prisma/adapter-pg`
    - _Requirements: 3.1, 3.2, 3.6_
  - [x] 4.2 Create and commit the first migration, with the hand-written partial unique index for one open Incident per Service
    - _Requirements: 3.2, 3.3, 3.5_
  - [x] 4.3 Write the idempotent seed for `gate`, `orders`, `payments`, `ledger` with fixed room positions and a `pnpm --filter api db:seed` script
    - _Requirements: 3.4_
  - [x] 4.4 Build the integration harness: skip with a visible message when `TEST_DATABASE_URL` is unset, refuse when equal to `DATABASE_URL`, apply migrations and truncate tables at start
    - _Requirements: 9.4, 9.5, 9.6_
  - [x] 4.5 Integration test: `migrate deploy` on an empty Test database creates all six tables and both indexes
    - _Requirements: 3.3_
  - [x]* 4.6 Property test with database: seed is idempotent (Property 14)
    - _Requirements: 3.4_
  - [x]* 4.7 Property test with database: at most one open Incident per Service (Property 15)
    - _Requirements: 3.2, 3.5_
  - [x]* 4.8 Property test with database: Evidence order is unique per Hunt (Property 16)
    - _Requirements: 3.6_

- [x] 5. Event bus and ring buffer
  - [x] 5.1 Implement `RingBuffer` (capacity 500, `since`, `oldestId`, `latestId`)
    - _Requirements: 6.4, 6.5, 6.6_
  - [x] 5.2 Implement `EventBus` (`publish`, `subscribe`, `close`) with a monotonic integer counter
    - _Requirements: 6.2, 6.9_
  - [x] 5.3 Implement SSE wire formatting in `sse-format.ts` using the Shared helpers
    - _Requirements: 6.2, 6.3_
  - [x]* 5.4 Property test: event ids strictly increase and heartbeat or resync carry no id (Property 1)
    - _Requirements: 6.2, 6.3_
  - [x]* 5.5 Property test: ring buffer is bounded and keeps the newest (Property 2)
    - _Requirements: 6.4_
  - [x]* 5.6 Property test: resume neither skips nor repeats (Property 3)
    - _Requirements: 6.5_
  - [x]* 5.7 Property test: out-of-range ids resync (Property 4)
    - _Requirements: 6.6_

- [x] 6. API shell: routes and SSE controller
  - [x] 6.1 Bootstrap Nest in `main.ts` and `app.module.ts` with the middleware order from the design, graceful shutdown hooks and a testable `createApp(config)` factory
    - _Requirements: 4.1, 6.9_
  - [x] 6.2 Implement `GET /healthz` with a 2 s database timeout
    - _Requirements: 5.1, 5.2_
  - [x] 6.3 Implement `GET /api/services` in room order, validated against the Shared validator in tests
    - _Requirements: 5.3, 5.4_
  - [x] 6.4 Implement `EventsController`: headers, id parsing from header or `lastEventId`, subscribe before replay, replay, `resync`, 15 s heartbeat
    - _Requirements: 6.1, 6.2, 6.3, 6.5, 6.6_
  - [x] 6.5 Enforce `SSE_MAX_CLIENTS` with 503 and `Retry-After`; clean up subscription and timer on disconnect
    - _Requirements: 6.7, 6.8_
  - [x] 6.6 End all Streams and close the bus on shutdown
    - _Requirements: 6.9_
  - [x] 6.7 Integration tests on an ephemeral port: health up and down, services shape, SSE headers, publish, drop and resume, resync, cap, shutdown
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 6.1, 6.2, 6.5, 6.6, 6.7, 6.9_
  - [x]* 6.8 Property test: client cap holds and disconnect releases its slot and timer (Property 5)
    - _Requirements: 6.7, 6.8_

- [x] 7. Security baseline
  - [x] 7.1 Add request id middleware, `X-Request-Id` header and the JSON logger with `redact`
    - _Requirements: 7.4, 7.5, 7.6_
  - [x] 7.2 Add `helmet`, exact-origin CORS through `isAllowedOrigin`, and `express.json({ limit: '32kb' })` with the Nest body parser disabled
    - _Requirements: 7.1, 7.2, 7.3_
  - [x] 7.3 Add the global `RateLimitGuard` on `@nestjs/throttler`, skipping GET, HEAD and OPTIONS, with a test-only mutating route to exercise it
    - _Requirements: 7.7_
  - [x] 7.4 Add `ErrorFilter` for 404, 413, 429 and generic 500 bodies with no stack traces
    - _Requirements: 5.5, 7.3, 7.8_
  - [x] 7.5 Integration tests: 404 body, 413 on a 33 KiB body, CORS allowed and denied origin, security headers present, 500 body is generic
    - _Requirements: 5.5, 7.1, 7.2, 7.3, 7.8_
  - [x]* 7.6 Property test: logs never leak secrets (Property 9)
    - _Requirements: 7.5, 7.6_
  - [x]* 7.7 Property test: rate limit counts only mutating requests (Property 10)
    - _Requirements: 7.7_
  - [x]* 7.8 Property test: CORS is exact (Property 11)
    - _Requirements: 7.1_

- [x] 8. Web shell and SSE client
  - [x] 8.1 Scaffold Vite + React with `Header`, `SceneMount` (empty, labelled, no PixiJS) and `TableMode`; read `VITE_API_BASE_URL`
    - _Requirements: 8.1, 8.2, 8.8, 8.9_
  - [x] 8.2 Implement `backoff.ts` (exponential, cap 30 s, equal jitter) and the `status.ts` reducer
    - _Requirements: 8.3, 8.4, 8.5_
  - [x] 8.3 Implement `sse-client.ts` with injectable `EventSource`, reconnect using `?lastEventId=`, `resync` handling and `fetchServices()` on connect and resync
    - _Requirements: 8.3, 8.4, 8.5, 8.6, 8.7, 8.9_
  - [x] 8.4 Render connection status in a polite live region with text and a shape icon; render Service name and Haunt level as table text
    - _Requirements: 8.1, 8.8_
  - [x] 8.5 Component and client tests with Testing Library and fake timers: status transitions, `resync` refetch, last id sent on reconnect, only the two allowed endpoints called
    - _Requirements: 8.3, 8.5, 8.6, 8.7, 8.9_
  - [x]* 8.6 Property test: backoff stays within bounds (Property 12)
    - _Requirements: 8.4_
  - [x]* 8.7 Property test: connection status is consistent (Property 13)
    - _Requirements: 8.3, 8.4, 8.5_

- [x] 9. Dev documentation
  - [x] 9.1 Write `docs/DEV.md`: prerequisites, Homebrew `postgresql@17` start and stop, creating dev and test databases, environment variable names, migrate, seed, running API and Web, running unit and integration tests, skip and refuse behavior
    - _Requirements: 9.1, 9.3, 9.4, 9.5_
  - [x] 9.2 Check that `.env.example` matches the variables the API reads and that `DEV.md` lists the same names
    - _Requirements: 9.1, 9.2_

- [x] 10. Final verification
  - [x] 10.1 Run `pnpm typecheck`, `pnpm lint`, `pnpm test` (without database) and, with a Test database, the integration suite; run the determinism check
    - _Requirements: 1.2, 1.3, 1.4, 1.5, 9.3, 9.4_
  - [x] 10.2 Start API and Web locally and confirm the status goes `live`, `reconnecting` after stopping the API and `live` again after restart, with the table filled from `GET /api/services`
    - _Requirements: 8.3, 8.4, 8.6_
  - [x] 10.3 Scan the repository for secrets and home paths, then add the finished-task line to `docs/KIRO_USAGE.md`
    - _Requirements: 4.4, 7.5_

- [x] 11. Review fixes (code review and security review)
  - [x] 11.1 Config: `SSE_MAX_CLIENTS_PER_IP` (default 5), `TRUST_PROXY_HOPS` (0 to 3, default 0, never `true`), `HOST` (default `127.0.0.1`); `.env.example` and `docs/DEV.md` updated
    - _Requirements: 4.5, 4.6, 4.7_
  - [x] 11.2 Per-IP stream cap on `req.ip` with 503 and `Retry-After`; one `release()` frees the slot on every close path
    - _Requirements: 6.10, 7.10_
  - [x] 11.3 Backpressure: destroy a stream past 64 KiB of unsent output; maximum stream age of 30 min, then a clean end
    - _Requirements: 6.11, 6.12_
  - [x] 11.4 Restart safety: random boot id per process, `connected { bootId }` first on every stream, ids `<bootId>-<n>`, `resync` reason `restarted` for a foreign boot; shared `formatEventId` / `parseEventId`
    - _Requirements: 6.2, 6.6, 6.13, 6.14_
  - [x] 11.5 `trust proxy` set from `TRUST_PROXY_HOPS`; throttler and per-IP cap use `req.ip`
    - _Requirements: 7.10_
  - [x] 11.6 `redact` scrubs connection strings and URL credentials inside free text
    - _Requirements: 7.9_
  - [x] 11.7 Explicit `requestTimeout` and `headersTimeout`, socket timeout off for SSE, listen on `HOST`
    - _Requirements: 4.7, 6.15_
  - [x] 11.8 Web: fetch-based EventSource that reports status and `Retry-After`; reconnect delay honours it (capped at 5 min)
    - _Requirements: 8.12_
  - [x] 11.9 Web: snapshot merged by `updatedAt` when an event raced the fetch; `resync` clears the stored id; a new boot id clears it and refetches; services kept in room order
    - _Requirements: 8.6, 8.10, 8.11, 8.13_
  - [x] 11.10 Tests: per-IP cap (6th stream 503, release on close), backpressure destroy, max age end, cross-boot `Last-Event-ID` resync, redact of a connection string in a message, snapshot-vs-event race, `Retry-After` honoured, trust proxy over HTTP, SSE outlives the request timeout
    - _Requirements: 4.6, 6.10, 6.11, 6.12, 6.14, 6.15, 7.9, 7.10, 8.10, 8.11, 8.12_
  - [x]* 11.11 Property tests updated: Property 1 and 3 with boot ids, Property 4 split per reason with `too_old` always overflowing the buffer, Property 5 with per-IP caps and maximum age, Property 6 with the new variables, Property 9 with free-text scrubbing, Property 12 with `Retry-After`
    - _Requirements: 4.6, 4.7, 6.5, 6.6, 6.10, 6.13, 6.14, 7.9, 8.12_
  - [x]* 11.12 Property test: a snapshot never overwrites a newer event (Property 17)
    - _Requirements: 8.10_
  - [x]* 11.13 Property test: services stay in room order (Property 18)
    - _Requirements: 8.13_

## Task Dependency Graph

```mermaid
graph TD
  T1[1 Workspace] --> T2[2 Shared]
  T1 --> T3[3 Config]
  T1 --> T4[4 Database]
  T2 --> T5[5 Event bus]
  T2 --> T7[7 Security]
  T3 --> T7
  T2 --> T8[8 Web shell]
  T3 --> T6[6 API shell]
  T4 --> T6
  T5 --> T6
  T7 --> T6
  T6 --> T9[9 Dev docs]
  T8 --> T9
  T9 --> T10[10 Verification]
  T10 --> T11[11 Review fixes]
```

```json
{
  "waves": [
    { "id": 0, "tasks": ["1"] },
    { "id": 1, "tasks": ["2", "3", "4"] },
    { "id": 2, "tasks": ["5", "7", "8"] },
    { "id": 3, "tasks": ["6"] },
    { "id": 4, "tasks": ["9"] },
    { "id": 5, "tasks": ["10"] },
    { "id": 6, "tasks": ["11"] }
  ]
}
```

## Notes

- Sub-tasks marked `*` are property-based tests. They are required for this spec: every correctness property has one.
- Properties 14 to 16 need `TEST_DATABASE_URL`. They are skipped with a visible message when it is unset.
- Prisma is pinned to 7.10.1, the latest stable. Do not move to 8.0.0 release candidates.
- Task 1.2 outcome: TypeScript 7.0.2 `tsc` type checks and emits `design:paramtypes` with `experimentalDecorators` and `emitDecoratorMetadata`, so it stays for all packages. TypeScript 7.0 ships no compiler API, and typescript-eslint refuses it, so, following the TypeScript 7 release notes, the root aliases `typescript` to `@typescript/typescript6@6.0.2` (API for tooling) and `@typescript/native` to `typescript@7.0.2` (the `tsc` binary). Vitest for `apps/api` uses `unplugin-swc` 2.0.0 with `@swc/core` 1.16.22 for decorator metadata; a smoke test asserts it.
- Out of scope: Prometheus polling and haunt score (`ingest-haunt-score`), PixiJS scene (`scene-engine`), MCP and hunts (`exorcist-agent`), pull requests (`fix-proposal-flow`), deploy (`deploy-demo`).
- Integration tests (4.5, 6.7, 7.5) are the only tests that touch the database.
- Task 10.2 outcome: the compiled API (`node dist/main.js`) served `/healthz`, `/api/services` and `/api/events`; the web SSE client, driven from Node's experimental `EventSource` against that API, went `live`, then `reconnecting` while the API was stopped, then `live` again with the services reloaded after restart. The Vite dev server served the shell. It was not checked in a real browser.
- Task 4 outcome: the generated Prisma client lives in `apps/api/src/generated/` (git-ignored, regenerated by `postinstall`, `typecheck` and `build`). The seed runs through `tsx` 4.23.15. The partial index `incident_one_open_per_service` is hand-written SQL; check every later `prisma migrate dev` output so it does not drop it. Integration global setup drops and recreates the `public` schema of the Test database only, then runs `prisma migrate deploy`.
- Task 11 outcome: the browser `EventSource` cannot read the status or headers of a failed request, so honouring `Retry-After` needed a small fetch-based `FetchEventSource` in the web app. It keeps the `?lastEventId=` query (no custom header, so no CORS preflight). Event ids changed from bare integers to `<bootId>-<n>`; a bare integer from an older client is now `malformed` and resyncs.
