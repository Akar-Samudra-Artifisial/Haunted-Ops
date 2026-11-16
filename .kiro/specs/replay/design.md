# Design Document
## Overview
A replay is a file, a row and a page. The file is built from a recorded incident by a tool, read by a person who approves it, and committed. The API seeds the reviewed files into one table and serves them with `GET`. The Web loads one file, folds its frames into a state with a pure player, and feeds that state to the same `App` that shows live data, so the Scene, the table, the detail panel and the announcer need no second code path.
Three choices carry the design. First, a frame replaces whole parts of the state (the list of services, a full Hunt detail, a full Proposal view), so a position is always the fold of the frames up to it and nothing has to be patched. Second, the validator in the shared package is the only judge: the Builder, the seed, the API and the Web all call it, and it checks every string again for what the sanitizer removes. Third, the replay code is a separate chunk behind `import()`, so the entry chunk pays for one route check and a lazy import (0.47 KiB gzip) and the scene chunk is not touched.
## Architecture
```
incident rows --build-replay.mjs--> fixtures/replays/<id>.json (review: null)
                                      |  review-replay.mjs --approve (a person reads every string)
                                      v
                          fixtures/replays/<id>.json (review set) --commit--> release tarball
                                      |  seedReplays (validate all, skip unreviewed, keep same sha256, delete gone)
                                      v
                                PostgreSQL "Replay"  --GET /api/replays[/:id] (validate again)-->  Web
Web: Root --/replays--> lazy ReplayApp --fetch, validate--> useReplayPlayer --state of the frame--> App (replay prop)
```
- `packages/shared/src/replays.ts`: type, validator, list validator, `applyReplayFrame`.
- `tools/replay-build/`: `build-replay.mjs`, `review-replay.mjs` (and the test support). `tools/sanitize-replay/sanitize-hunt-stream.mjs` exports `scrub`.
- `apps/api/src/replays/`: `replay-seed.ts`, `replays.controller.ts`, `replays.module.ts`; `apps/api/prisma/seed-replays.ts`.
- `apps/web/src/replay/`: `player.ts`, `useReplayPlayer.ts`, `ReplayApp.tsx`, `ReplayControls.tsx`, `replay-api.ts`.
- `deploy/server/seed.mjs`, `deploy/build-release.sh`, `scripts/release-check.mjs`, `scripts/check-scene-bundle.mjs`.
## Components and Interfaces
### Replay file (`packages/shared/src/replays.ts`)
```ts
interface ReplayFile {
  version: 1; id: string; title: string; scenario: 'error-spike' | 'fog' | 'dark-room';
  recordedOn: string; durationMs: number;
  review: { reviewedOn: string; by: string; note: string; sha256: string } | null;
  frames: Array<{ t: number; services?: ServiceState[]; hunt?: HuntDetail | null; proposal?: ProposalView | null }>;
}
validateReplayFile(input: unknown): Result<ReplayFile>   // total, names paths, never text
replayForbiddenKind(text: string): string | null          // the name of the first forbidden kind
replayHash(file): string                                   // sha256 of the canonical JSON: the sha256 of a Replay row
replayReviewHash(file): string                             // replayHash of the file with review set to null: review.sha256
```
The validator walks the whole file for strings (except the `id`, which has its own pattern) and applies `REPLAY_FORBIDDEN` plus the long-run rule. The size is measured in UTF-8 bytes without `TextEncoder` (the package has no DOM or Node types). `package.json` of the package says `"sideEffects": false`, so the bundler leaves the replay validator out of the entry chunk.
### Builder (`tools/replay-build/build-replay.mjs`)
`readIncidentRows(prisma, incidentId)` returns plain rows (incident, services, signals, latest hunt with steps and evidence, latest proposal, window). `buildReplay(rows, { id, title, scenario }, deps)` is pure: it computes the haunt state of each service poll with `stepHaunt`, builds the Hunt detail and the Proposal view as they were at each second (status stages `drafting`, `open`, `merged`, `deployed` or the failure from the stored times), emits a frame only for the parts that changed, thins frames to 400 and 256 KiB, and validates. `deps` are the validator, the haunt functions and `sanitizePrText`, loaded from the built packages (`loadDeps`) or injected by tests.
### Review tool (`tools/replay-build/review-replay.mjs`)
`readingOf(file)` lists the header strings and, for each frame, the strings whose value changed since the last time that path was shown. `main` validates, prints, and with `--approve` writes `review` and validates again.
### Store and API (`apps/api/src/replays/`)
`seedReplays` is a two-phase function: read and validate all, then write. `ReplaysController` is `@Controller('api/replays')` with two `@Get` routes; `get` uses the response object so that an invalid row can answer 500 with an empty body.
### Frame player (`apps/web/src/replay/player.ts`)
```ts
interface PlayerState { position: number; playing: boolean; speed: 1 | 2 | 4 }
reducePlayer(file, state, action): PlayerState   // play pause toggle speed tick seek next prev
timeline(frames): ReplayState[]                  // states[i] = fold of frames 0..i
stateAt(states, frames, position): ReplayState   // binary search of the last frame with t <= position
```
`tick` moves by `dt × speed` only while playing and stops at the end; `play` at the end restarts from 0; `next` and `prev` pause and are no-ops at the ends; `seek` clamps and rounds.
### Replay in `App`
`App` takes `replay?: ReplaySource` (`services`, `proposal`, `now`, `banner`, `controls`, `loadHuntDetail`). With it, no stream opens, the scene clock is `now` (the recording date plus the position), the header shows the banner in place of the connection, the table caption starts with it, and the Hunt detail comes from the frame. `Root` chooses between `App` and the lazy `ReplayApp` by `replayRouteFromPath`; `ReplayApp` receives `App` as a prop, so its chunk imports nothing from the entry chunk.
### Bundle check
`scripts/check-scene-bundle.mjs` finds the chunk of `src/replay/ReplayApp.tsx`, measures it (its static files that the entry does not have), fails over `BUDGETS.replay`, and fails when the static closure of the entry holds it.
## Data Models
```prisma
model Replay { id String @id; title String; scenario String; recordedOn DateTime @db.Date; durationMs Int
               body Json; sha256 String; createdAt DateTime @default(now()); updatedAt DateTime @updatedAt }
```
`sha256` is `replayHash` of the file: the hash of its canonical JSON (keys sorted, no spaces), not of the bytes on disk, because a `jsonb` column does not keep the order of keys and the API must be able to recompute it from the row. `body` is the whole file, so the API needs no second source.
## Review findings (task 8)
- **Lock** (`apps/api/test/db-lock.ts`): `pg_try_advisory_lock(7201126042)` on a dedicated `pg.Client` that stays open until the teardown that global setup returns. Two connections are the proof: the second `acquireTestDbLock` stays pending while the first holds the lock, says "another api test run is using the test database, waiting" once, and goes on after the release; the test uses its own key because the run itself holds the real one. A crashed run frees the lock with its connection.
- **Timeouts**: the heavy properties get `30_000` as the third argument of `it`. `numRuns` stays; lowering it would hide failures, which the fast-check setup already forbids.
- **Seed line**: Vitest reads `ctx.task.result.errors` (`isPropertyFailure` in `packages/shared/test/fast-check-report.ts`). For `node --test` there is no error object in a preload, so the setup installs a `reporter` through `fc.configureGlobal`; it notes the failure and throws the usual report, and the `exit` hook prints the seed only after that.
- **Host rule and the other kinds** (`REPLAY_FORBIDDEN` is now a list of `{ name, test }`): scans, not regular expressions, for the host name (`hasHostName`), IPv4 (`hasIpv4`), IPv6 (`hasIpv6`) and e-mail (`hasEmail`), so that each takes one pass. The shapes that must pass are listed in the comment of `hasHostName` and in `replays.hosts.test.ts`. A file ending (`py`, `yaml`, `md`, `ts` and the like) is not a host; a mixed-case last label (`Done.Next`) is not a host; a code name such as `os.path` is refused, and the Builder writes `[host]` in its place. Trade-off: an address in the style of a version (`1.2.3.4` with no `v`) is refused.
- **Review hash** (`sha256.ts`, `canonicalJson`, `replayHash`, `replayReviewHash`): SHA-256 is written out in the shared package (it computes its constants from the roots of the first primes; a test compares it with `node:crypto`) so that the validator, which the browser also runs, checks the hash with the same code as the Builder, the release check and the seed. The check runs last and only on a file with no other error. The hash covers everything except `review`, so the note and the date can change; the content cannot.
- **Builder**: `loadDeps` compares the newest file of each `dist` with the newest source (tests, declarations and the generated Prisma client aside) and stops with `build_stale: <package> (run "pnpm build" first)`. `clean` loops scrub, `sanitizePrText` and removal of invisible characters until the text stops changing; `sanitizePrText` writes a zero-width space after each `@`, so mentions become `[mention]` first and the characters are removed after.
- **Release and seed**: `release-check.mjs` loads `validateReplayFile` from `packages/shared/dist` (exit 2 with a message when it is not built). `build-release.sh` runs `find fixtures/replays -mindepth 1 ! -type f` before it copies anything.
## Last validator gaps (task 9)
- **Host rule**: `hasHostName` looks the last label up in `HOST_ENDINGS` (any case) first; any other label keeps the one-case rule. `py`, `md` and `sh` (`AMBIGUOUS_ENDINGS`) are a file only when the part before the ending has no `.`; the other `FILE_ENDINGS` are unchanged. Still one pass with a few anchored single-class tests per token. Trade-off: a code name such as `os.sh` with two labels, or `Done.Com`, is refused.
- **IPv6**: a run that starts with a single `:` loses it and skips the left-boundary check (`addr:fe80::1`); the right check stays. `maskNetwork` of the Builder already starts its match after the `:`, so it writes `addr:[ip]`.
- **Invisible characters**: one set (U+061C, U+200B-U+200F, U+2028, U+2029, U+202A-U+202E, U+2060-U+2064, U+2066-U+2069, U+FEFF, U+E0000-U+E007F, `u` flag) in the validator and in the Builder's `INVISIBLE`.
- **Release and seed**: `build-release.sh` refuses a `fixtures/replays` that is a link; `jsonFiles` reads `Dirent`s and stops with `not_regular_file` and the name for any `*.json` that is not a regular file.

## IPv6 behind a word and two flaky tests (task 10)
- **IPv6**: `hasIpv6` is `isIpv6Run` (the group rules, unchanged) plus the boundary rules. A run that is not inside a word is tested as a whole. A run that starts inside a word (`ce:fe80::1` of `device:fe80::1`, because `c` and `e` are hex letters) or that starts with a single `:` is also tested from after its first single `:`, with no left-boundary check; the right-boundary check applies to both. A run that is not inside a word and does not start with `:` is not tested from its first `:` (`a:b:c:d:e:f:1:2:3` has 9 groups and stays accepted). `std::vector` and `zx::1` have a `::` there, so no single `:` is found. The Builder needs no change: its pattern (`(?<![A-Za-z0-9_])[0-9A-Fa-f:]{2,}`) starts after the `:` and uses `hasIpv6` on that run.
- **`a::b`**: decided as refused. It is a valid compressed address, a validator that is a safety check should lean to refuse, and code names with only hex letters on both sides of `::` are rare in a replay of an incident. The earlier note that such a name is accepted was wrong for the code (`hasIpv6('a::b')` has always been true); the comment of the function and a test now say so. `za::b` (inside a word) and `a::bz` (a word follows) are accepted.
- **Timing**: the new shapes (`e:` repeated, `x` and `a:` repeated, `a:fe80::` repeated, `device:1:2:3:4:5:6:7` repeated) are in the 64 KiB test; each run is read a constant number of times.
- **Flaky tests**: both are property tests that render or loop many times (60 and 12 runs). They get a 30 s test timeout like the property tests fixed in task 8; the second one also gives its `waitFor` and `findByRole` calls a 5 s timeout, because a 1 s wait for a React effect is short when the machine is loaded. They had no fixed sleeps. `numRuns` is not lowered.

## Correctness Properties
*A property is a statement that must hold for all valid inputs. Each one below is checked by a property-based test with fast-check, at least 100 runs, with the comment `// Feature: replay, Property N`.*
### Property 1: The validator accepts every well-formed file
For any file built from random frame counts, times, services, hunts and pull requests that follow the format, `validateReplayFile` accepts it and accepts it again after a JSON round trip.
**Validates: Requirements 1.1, 1.2, 1.3, 1.6**
### Property 2: The validator refuses any single forbidden string and never prints it
For any valid file and any text of a forbidden kind (email, home or temp path, token, UUID, account id, IP address, host name, control character, long run) put into any free-text field, the validator refuses the file at the path of that field and no error holds the text.
**Validates: Requirements 1.5, 7.5, 7.6**
### Property 3: The Builder gives a valid, clean file for any rows
For any rows of a valid incident (random signals, hunt state, steps, evidence with hostile text, proposal stage), `buildReplay` returns a file that passes the validator, has at most 400 frames and 256 KiB, holds no real id, no internal text and none of the planted forbidden text, and is the same bytes for the same rows and replay id.
**Validates: Requirements 2.3, 2.4, 2.5**
### Property 4: A position is the fold of the frames up to it
For any file and any sequence of player actions, the position stays an integer from 0 to `durationMs` and the state at the position equals the fold of the frames with `t` not above it.
**Validates: Requirements 4.3, 4.4, 4.6**
### Property 5: The table says what the Scene shows at every position
For any position of a replay and any motion setting, each row of the table has the level and its label, the reason, the dark or lit state, the incident, the hunt text and the fix text of the Scene model for that frame, and the caption starts with the banner.
**Validates: Requirements 4.5, 4.7**
### Property 6: Allowed shapes are never refused
For any valid file and any text of an allowed shape (service and tool names, lab file names, versions, decimals, times, prose, 127.0.0.1) put into any free-text field, the validator accepts the file once the review hash is written again.
**Validates: Requirements 7.4, 7.5, 7.6**
## Error Handling
- The Builder prints a code and field paths (`incident_not_found`, `window_too_long`, `invalid_replay: $.frames[3].hunt.model`, `file_exists`, `usage`), never a database error, a URL or a value. Exit 1 for a failure, 2 for a usage error.
- The seed throws `ReplaySeedError(file, paths)` before it writes anything; the scripts print only that message.
- The API answers 404 for a bad or unknown id, 500 with no content for a row that fails the validator (the log has `replayId` only), and the usual `{ error, requestId }` for anything else.
- The Web shows a plain message for a missing replay, an API that is down, a body that is invalid or unreviewed, and the list when it cannot be loaded.
## Testing Strategy
- **Unit tests**: `packages/shared/test/replays.test.ts` (every limit at its edge and one past it, unsorted `t`, a frame after `durationMs`, unknown keys, each forbidden kind, other-repository links, bytes at exactly 256 KiB), `tools/replay-build/*.test.mjs`, `apps/web/src/replay/player.test.ts`.
- **Property tests**: `replays.property.test.ts` (Properties 1, 2 and 6), `build-replay.property.test.mjs` (Property 3), `player.property.test.ts` (Property 4), the parity test (Property 5).
- **Integration** (test database): `apps/api/test/replays.int.test.ts` builds the Synthetic replay from inserted rows, seeds, lists, gets, 404s, skips an unreviewed file, refuses a tampered row and has no write route.
- **Component and end-to-end**: `apps/web/src/replay/replay.test.tsx` and `apps/web/e2e/replay.spec.ts` against a mocked API (list, open, play, pause, step, Accessible mode, no request to `/api/events`, the replay chunk not requested on `/`).
- **Review findings**: `apps/api/test/db-lock.int.test.ts` (two connections), `packages/shared/test/replays.hosts.test.ts` (shapes, 64 KiB, SHA-256 against `node:crypto`), `fast-check-report.test.ts` and `scripts/fast-check-setup.test.mjs` (both seed cases), the review hash tests of `replays.test.ts`, the stale-build and environment tests of `build-replay.test.mjs`, `release-check.test.mjs`, the guard test of `deploy-files.test.mjs`, the list and tamper tests of `replays.int.test.ts`.
- **Scripts**: `check-scene-bundle.test.mjs`, `release-check.test.mjs`, `deploy-files.test.mjs`, `demo-env-check.test.mjs`, `read-env-value.test.mjs`.
