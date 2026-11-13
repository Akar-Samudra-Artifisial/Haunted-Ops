# Kiro usage log

One line per finished task: date | spec/task | what Kiro did.

- 2026-11-12 | foundation/setup | Kiro created the repo skeleton, 8 steering files, 4 hooks and the exorcist-agent spec stub.
- 2026-11-12 | exorcist-agent/0 (G0 spike) | Kiro built a stdio MCP spike and ran headless Exorcist hunts; G0: PASS, about 0.59 credits and 33 s per 3-tool hunt, allow-list held.
- 2026-11-12 | foundation/spec | Kiro wrote the foundation spec (requirements, design, tasks): 9 requirements, 16 correctness properties, 10 top-level tasks, versions checked against the npm registry.
- 2026-11-12 | foundation/1 | Kiro set up the pnpm workspace (shared, api, web), strict TS 7 with a TS 6 API alias for linting, root scripts, smoke tests and a build determinism check.
- 2026-11-12 | foundation/2 | Kiro wrote the shared types, total exact validators and SSE wire helpers, with unit tests and property tests 7 and 8.
- 2026-11-12 | foundation/3 | Kiro added startup config validation that names bad variables without values and exits before listen, with unit tests and property test 6.
- 2026-11-12 | foundation/4 | Kiro wrote the Prisma schema, the first migration with a partial unique index, the idempotent seed and the Test database harness (skip and refuse guards), with integration tests and property tests 14 to 16.
- 2026-11-12 | foundation/5 | Kiro built the in-process event bus, the 500-event ring buffer, SSE framing and subscribe-before-replay resume, with unit tests and property tests 1 to 4.
- 2026-11-12 | foundation/7 | Kiro added the security baseline (request id, redacting JSON logs, helmet, exact-origin CORS, 32 KiB body limit, mutating-only rate limit, generic error bodies), with HTTP tests and property tests 9 to 11.
- 2026-11-12 | foundation/8 | Kiro built the web shell (header with polite live status, empty scene mount, table mode) and an SSE client with jittered backoff, lastEventId resume and resync reloads, with component tests and property tests 12 and 13.
- 2026-11-12 | foundation/6 | Kiro wired the API shell (healthz with a 2 s DB timeout, GET /api/services, GET /api/events with heartbeat, resume, resync, client cap and clean shutdown), with HTTP end-to-end tests and property test 5.
- 2026-11-12 | foundation/9 | Kiro wrote docs/DEV.md (Homebrew postgresql@17, databases, env names, migrate, seed, run, tests with skip and refuse rules) and checked .env.example against the variables the code reads.
- 2026-11-12 | foundation/10 | Kiro ran typecheck, lint, unit, property and integration tests (113 passing), the build determinism check, a live/reconnecting/live run of the web client against the compiled API, and a secret and home-path scan.
- 2026-11-12 | foundation/11 (review fixes) | Kiro added per-IP SSE caps, backpressure and max stream age, boot-id event ids with resync on restart, TRUST_PROXY_HOPS and HOST, explicit HTTP timeouts, free-text secret scrubbing, and a web client that honours Retry-After, merges snapshots by updatedAt and keeps room order; 155 tests pass.
- 2026-11-13 | ingest-haunt-score/spec | Kiro wrote the ingest-haunt-score spec (requirements, design, tasks): 12 requirements, 14 correctness properties, 8 top-level tasks, PromQL and event shapes fixed, no new dependency.
