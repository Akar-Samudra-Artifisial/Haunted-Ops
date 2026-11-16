# Implementation Plan: replay
## Overview
Add the replay feature end to end: the file format and its validator, the tools that build and review a file, the store and the read-only API, and the playback in the Web (scene and Accessible mode), then close the two flaky tests and the three review findings of `deploy-demo` that the same pass touches. It is 8 top-level tasks. Each task ships with its tests. Property tests are their own sub-tasks, marked `*`, and carry the comment `// Feature: replay, Property N`. Nothing here touches AWS, a server, GitHub or the real `kiro-cli`, and no test makes a network call.
## Tasks
- [x] 1. The Replay file (`packages/shared/src/replays.ts`)
  - [x] 1.1 Add `ReplayFile`, the limits, the forbidden string kinds and `validateReplayFile` built with `makeValidator`, reusing `checkServiceState`, `checkHuntDetail` and `checkProposalView`; export them from the package index and set `"sideEffects": false` in its `package.json`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_
  - [x] 1.2 Add `validateReplayList`, `replayListItem` and `applyReplayFrame`
    - _Requirements: 1.7_
  - [x] 1.3 Unit tests: a good file, every limit at its edge and one past it (id, title, date, `durationMs`, review, frame count, bytes at exactly 256 KiB), unsorted `t`, a frame after `durationMs`, unknown keys, each forbidden kind, a `prUrl` of another repository
    - _Requirements: 1.2, 1.3, 1.4, 1.5_
  - [x]* 1.4 Property test: the validator accepts every well-formed file (Property 1)
    - _Requirements: 1.1, 1.2, 1.3, 1.6_
  - [x]* 1.5 Property test: the validator refuses any single forbidden string and never prints it (Property 2)
    - _Requirements: 1.5_
- [x] 2. Builder and Review tool (`tools/replay-build/`)
  - [x] 2.1 Use the existing export `scrub` of `tools/sanitize-replay/sanitize-hunt-stream.mjs` (no copy) and `sanitizePrText` of the API
    - _Requirements: 2.4_
  - [x] 2.2 Add `build-replay.mjs` (`readIncidentRows`, pure `buildReplay`, `writeReplay`, a CLI that never prints the URL) and its type file
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_
  - [x] 2.3 Add `review-replay.mjs` (`readingOf`, `--approve` only writes)
    - _Requirements: 2.6_
  - [x] 2.4 Unit tests for both tools, with a fake database client, temporary copies and no real file approved
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_
  - [x]* 2.5 Property test: the Builder gives a valid, clean file for any rows (Property 3)
    - _Requirements: 2.3, 2.4, 2.5_
  - [x] 2.6 Add `fixtures/replays/README.md`, and the Synthetic replay made from rows that `apps/api/test/replays.int.test.ts` inserts
    - _Requirements: 2.7_
- [x] 3. Store and API
  - [x] 3.1 Add the `Replay` model and one migration (`db:drift` clean)
    - _Requirements: 3.1_
  - [x] 3.2 Add `seedReplays`, `seed:replays`, and the call in `deploy/server/seed.mjs`
    - _Requirements: 3.2, 3.3_
  - [x] 3.3 Add `fixtures/replays/*.json` to `deploy/build-release.sh` and the finding `replay_unreviewed` to the release check
    - _Requirements: 3.4_
  - [x] 3.4 Add `ReplaysModule` (`GET /api/replays`, `GET /api/replays/:id`, validation before sending, 500 with no content, cache header)
    - _Requirements: 3.5, 3.6, 3.7_
  - [x] 3.5 Integration tests on the test database: build and seed the Synthetic replay, list, get, 404, an unreviewed file skipped, a tampered row not served, no write route
    - _Requirements: 3.2, 3.5, 3.6, 3.7_
- [x] 4. Playback in the Web
  - [x] 4.1 Add `replayRouteFromPath`, `Root` with the lazy `ReplayApp`, the `replay` prop of `App`, the banner in the header and the table caption
    - _Requirements: 4.1, 4.3, 4.5_
  - [x] 4.2 Add the frame player (`player.ts`), `useReplayPlayer`, `ReplayControls`, `ReplayApp` (list, player, errors) and the replay styles
    - _Requirements: 4.3, 4.4, 4.5, 4.6, 4.8_
  - [x]* 4.3 Property test: a position is the fold of the frames up to it (Property 4)
    - _Requirements: 4.3, 4.4_
  - [x]* 4.4 Property test: the table says what the Scene shows at every position (Property 5)
    - _Requirements: 4.5, 4.7_
  - [x] 4.5 Unit and component tests (pause, speed, steps at both ends, seek, paused start, one announcement for a jump, 404, API down, no stream)
    - _Requirements: 4.3, 4.4, 4.5, 4.6, 4.8_
  - [x] 4.6 Add the Playwright test `apps/web/e2e/replay.spec.ts` against a mocked API
    - _Requirements: 4.1, 4.3, 4.4, 4.5, 4.8_
  - [x] 4.7 Extend `scripts/check-scene-bundle.mjs` with the replay chunk (budget, static-reach check) and its tests; add the README line
    - _Requirements: 4.1, 4.2, 4.9_
- [x] 5. Flaky tests
  - [x] 5.1 Add the fast-check setup of every workspace and `scripts/fast-check-setup.mjs`; document it in `docs/DEV.md`
    - _Requirements: 5.1_
  - [x] 5.2 Measure `sanitizePrText` on adversarial input; replace the quadratic markdown link and reference regular expressions of `sanitizeModelText` by a linear scan; add the equivalence and 64 KiB tests
    - _Requirements: 5.2_
  - [x] 5.3 Poll for the end of a process in the hunt tests instead of a fixed sleep
    - _Requirements: 5.3_
  - [x] 5.4 Run the full `pnpm test` three times while a second `pnpm test` of the API runs
    - _Requirements: 5.4_
- [x] 6. Review findings of deploy-demo
  - [x] 6.1 The `kiro` profile refuses `\` and `"` in the key, with tests
    - _Requirements: 6.1_
  - [x] 6.2 The `api` profile refuses `KIRO_API_KEY`, with a test
    - _Requirements: 6.2_
  - [x] 6.3 Add `scripts/read-env-value.mjs`, use it in `deploy/server/preflight.sh`, ship it in the release, and test that `KIRO_API_KEY = "<key>"` gives the same value in both
    - _Requirements: 6.3_
- [x] 7. Steering and records
  - [x] 7.1 Add the replay rules to `.kiro/steering/security.md`, update `structure.md`, add the replay lines to `docs/KIRO_USAGE.md`, and run the checks
    - _Requirements: 1.5, 2.4, 3.6_
- [x] 8. Review findings: collisions, timeouts, validator, builder, release and deploy
  - [x] 8.1 Take an advisory lock in `apps/api/test/global-setup.ts` before the schema is dropped (wait up to 10 minutes, release in teardown); test two connections; one line in `docs/DEV.md`
    - _Requirements: 7.1_
  - [x] 8.2 Give each property test of `apps/web` and `packages/shared` that renders or runs more than 100 cases a 30 s timeout as the third argument of `it`
    - _Requirements: 7.2_
  - [x] 8.3 Print the fast-check seed only for a falsified property, in the Vitest setup and in `scripts/fast-check-setup.mjs`; test both cases
    - _Requirements: 7.3_
  - [x] 8.4 Harden the validator: host names, IPv4 and IPv6, bidi and zero-width characters, HTML tags, foreign URLs and `/root/` paths, all in linear time; list the accepted shapes in a comment and test them; add the 64 KiB tests
    - _Requirements: 7.4, 7.5, 7.6_
  - [x]* 8.5 Property tests: each new forbidden kind put anywhere fails, each allowed shape put anywhere passes (Properties 2 and 6)
    - _Requirements: 7.4, 7.5, 7.6_
  - [x] 8.6 Add `sha256.ts`, `canonicalJson`, `replayHash` and `replayReviewHash`; bind the review to the content in the validator and in `review-replay.mjs --approve`; update the synthetic file and the tests
    - _Requirements: 7.8_
  - [x] 8.7 Builder: `DATABASE_URL` from the environment only, scrub again after `sanitizePrText` until stable, mask hosts, IPv6, mentions and `/root/` paths, stop on a stale `dist`; update the README of `fixtures/replays/` and the tests
    - _Requirements: 7.7_
  - [x] 8.8 Release check: the full validator, `replay_invalid`, a review with string `reviewedOn` and `by`; `build-release.sh` refuses anything that is not a regular file in `fixtures/replays/`
    - _Requirements: 7.8, 7.9_
  - [x] 8.9 Seed and routes: the row `sha256` is `replayHash` of the file; the seed rewrites a row whose body does not have it; the list and the single route refuse a row whose hash or body is wrong, logging the id only
    - _Requirements: 7.10_
  - [x] 8.10 Env guard refuses a single quote in `KIRO_API_KEY`; the pre-flight reads `LAB_READ_TOKEN` of both files with `scripts/read-env-value.mjs`; test both
    - _Requirements: 7.11_
  - [x] 8.11 Run the checks, update `docs/KIRO_USAGE.md`
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9, 7.10, 7.11_
- [x] 9. Last validator gaps
  - [x] 9.1 Host rule (`py`, `md`, `sh` with two labels, common endings in any case), IPv6 after a single `:`, more invisible characters, in the validator and the Builder; tests, the 64 KiB shapes and a Builder test
    - _Requirements: 8.1, 8.2, 8.3_
  - [x] 9.2 `build-release.sh` refuses a linked `fixtures/replays`; the seed counts only regular files; tests for both
    - _Requirements: 8.4_
  - [x] 9.3 Check the fast-check seed print of `test:scripts`, run the checks, update `docs/KIRO_USAGE.md`
    - _Requirements: 8.5_
- [x] 10. IPv6 behind a word and two flaky Web tests
  - [x] 10.1 `hasIpv6`: a run that starts inside a word, or with a single `:`, is also tested after its first single `:`; `a::b` decided as refused and named in the design, the comment and a test; tests for `device:fe80::1`, `id:fe80::1`, `ipv6:2001:db8::7` and the accepted shapes, the property test and the 64 KiB shapes
    - _Requirements: 9.1, 9.2_
  - [x] 10.2 The two flaky Web tests get a 30 s timeout (and polling waits of 5 s in the second), `numRuns` unchanged
    - _Requirements: 9.3_
  - [x] 10.3 Documents and verification: requirements 9, design, `docs/KIRO_USAGE.md`; the checks of `exorcist-agent` task 15 pass
    - _Requirements: 9.1, 9.2, 9.3_
## Notes
- Name: the feature is always "replay". The fake `kiro-cli` has a mode with a similar name; this spec does not touch it and shares no code or name with it.
- The Builder needs the built packages (`pnpm build`): it imports the validator of `packages/shared/dist` and `sanitizePrText` of `apps/api/dist`. Tests that run in vitest inject the source functions instead.
- Entry chunk, 15 Nov 2026: 92122 bytes gzip before (90.0 KiB), 92603 after (90.4 KiB, +0.47 KiB). A first version put React and the whole shared package into a common chunk and grew the entry by 3.1 KiB; `"sideEffects": false` in the shared package keeps the replay validator out of the entry. Replay chunk: 4117 bytes (4.02 KiB), budget 4940 bytes (+20 percent). After task 8 (more validator rules and the SHA-256 of the review, which the browser runs too): 5665 bytes (5.53 KiB), budget 6800 bytes (+20 percent); the entry chunk is unchanged (90.4 KiB).
- Flaky test finding (task 5.2): `sanitizeModelText` used `/!?\[[^\]]*\]\([^)]*\)/` and `/\[[^\]]*\]\[[^\]]*\]/`, which scan to the end of the text from every `[` and take quadratic time on a run of `[` (562 ms for 24000 characters, about 4 s for 80000). Both are now `replaceMarkdownLinks`, a linear scan with the same matches (tested against the regular expressions). The property test itself (300 runs of strings up to 600 characters) was not slow alone; the failure under load was the 30 s test timeout meeting a loaded machine.
- A replay frame carries `hunt` and `proposal` for the detail panel; the table and the Scene read the summaries inside `services`, so the frame holds both and the builder emits them together.
- Out of scope: real replay files (the orchestrator builds, reviews and commits them), a replay of the fixer stream, editing or deleting a replay through the API.
## Task Dependency Graph
```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "5.1", "6.1", "6.2", "6.3"] },
    { "id": 1, "tasks": ["1.2", "1.3", "3.1", "5.2", "5.3"] },
    { "id": 2, "tasks": ["1.4", "1.5", "2.1", "2.2", "3.2", "3.4"] },
    { "id": 3, "tasks": ["2.3", "2.4", "2.5", "3.3", "3.5", "2.6"] },
    { "id": 4, "tasks": ["4.1", "4.2"] },
    { "id": 5, "tasks": ["4.3", "4.4", "4.5", "4.6", "4.7"] },
    { "id": 6, "tasks": ["5.4", "7.1", "8.1", "8.2", "8.3", "8.4", "8.6", "8.10"] },
    { "id": 7, "tasks": ["8.5", "8.7", "8.8", "8.9"] },
    { "id": 8, "tasks": ["8.11"] },
    { "id": 9, "tasks": ["9.1", "9.2"] },
    { "id": 10, "tasks": ["9.3"] },
    { "id": 11, "tasks": ["10.1", "10.2"] },
    { "id": 12, "tasks": ["10.3"] }
  ]
}
```
