# Requirements Document

## Introduction

`ingest-haunt-score` is the second product spec of Haunted Ops, after `foundation`. It makes the house react to the lab. The API polls Prometheus every few seconds, stores the measurements as Signals, turns them into a haunt level from 0 (calm) to 4 (dark) for each Service, opens and closes Incidents, and publishes the changes on the existing SSE bus. The web app shows the result in table mode.

It is the last piece of gate G1 (16 Nov 2026): "chaos in the lab changes the haunt score shown in the table". The lab (`haunted-lab`, public) is done: four services `gate`, `orders`, `payments` and `ledger`, scraped by Prometheus on `127.0.0.1:9090` every 5 s. The lab already proved that its `error-spike` scenario gives a payments 5xx ratio of about 0.22, `fog` gives an orders p95 of about 2.2 s and `dark-room` gives `up == 0` for ledger.

It does not run hunts or the MCP server (`exorcist-agent`), draw the PixiJS scene (`scene-engine`), build the full accessible mode (`accessible-mode`) or deploy (`deploy-demo`). It adds no new dependency.

## Glossary

- **Workspace**, **API**, **Web**, **Shared**, **Service**, **Haunt level**, **Signal**, **Incident**, **Event bus**, **Table mode**, **Test database**: as defined in the `foundation` spec.
- **Lab**: the separate repo `haunted-lab` with the four Services, Prometheus and the chaos controller.
- **Prometheus**: the metrics server at `PROMETHEUS_URL`. Its responses are untrusted data.
- **Chaos API**: the lab supervisor routes under `/chaos/*`, protected by a bearer token. Only the G1 script uses it.
- **Poller**: the API component that queries Prometheus on a fixed interval.
- **Poll**: one run of the three queries. It succeeds only if all three succeed.
- **Sample**: the values of one Service from one successful Poll: `errorRate` (ratio 0 to 1), `p95Ms` (milliseconds) and `up` (average of `up` over 30 s, 0 to 1). Each value is a number or `null` (no value).
- **No-data Sample**: a Sample whose three values are all `null`.
- **Raw level**: the haunt level that one Sample alone gives, before hysteresis.
- **Hysteresis**: the rule that the Haunt level rises only after 2 consecutive Polls with a higher Raw level and falls only after 3 consecutive Polls with a lower one.
- **Haunt reason**: `{ kind, value }` with `kind` one of `error_rate`, `p95` or `down`, naming the Signal that sets the level. `value` is the error ratio, the p95 in milliseconds, or the `up` average.
- **Open Incident**: an Incident of a Service with `closedAt` unset.
- **Stale**: the state in which the last Poll failed, so the stored levels and metrics may be out of date.
- **Scenario**: one lab fault: `error-spike` (payments), `fog` (orders) or `dark-room` (ledger).

## Requirements

### Requirement 1: Ingest configuration

**User Story:** As an operator, I want the Prometheus address, the poll interval and the retention to be validated at startup, so that a typo shows up before the API listens.

#### Acceptance Criteria

1. WHERE `PROMETHEUS_URL` is set, THE API SHALL validate it as an origin made of scheme `http` or `https`, host and optional port, with no path, query, fragment or credentials, and WHERE it is unset THE API SHALL use `http://127.0.0.1:9090`.
2. WHERE `POLL_INTERVAL_MS` is set, THE API SHALL validate it as an integer from 1000 to 60000, and WHERE it is unset THE API SHALL use 5000.
3. WHERE `POLL_TIMEOUT_MS` is set, THE API SHALL validate it as an integer from 100 to 30000 that is not greater than `POLL_INTERVAL_MS`, and WHERE it is unset THE API SHALL use the smaller of 3000 and `POLL_INTERVAL_MS`.
4. WHERE `SIGNAL_RETENTION_H` is set, THE API SHALL validate it as an integer from 1 to 720, and WHERE it is unset THE API SHALL use 24.
5. IF any of these variables is invalid, THEN THE API SHALL exit with a non-zero code before it listens and print a message that names every offending variable and never prints a value.
6. THE `.env.example` file and `docs/DEV.md` SHALL list `PROMETHEUS_URL`, `POLL_INTERVAL_MS`, `POLL_TIMEOUT_MS` and `SIGNAL_RETENTION_H` with their defaults, and no real value.

### Requirement 2: Prometheus poller

**User Story:** As an on-call engineer, I want the API to read the lab metrics every few seconds, so that the house follows what the services do.

#### Acceptance Criteria

1. WHEN the API has started, THE Poller SHALL run a Poll immediately and then one Poll every `POLL_INTERVAL_MS`.
2. EACH Poll SHALL run exactly three instant queries with `GET /api/v1/query` at `PROMETHEUS_URL`: the error ratio over 1 minute, the p95 latency over 1 minute from the `http_request_duration_seconds` histogram, and `avg_over_time(up[30s])`.
3. THE three PromQL strings SHALL be constants in code and SHALL NOT be built from any request, response, environment value or other input.
4. THE error ratio query SHALL fall back to zero for a Service that has traffic but no 5xx series, and THE p95 query SHALL return milliseconds.
5. IF a Poll is still running when the next interval elapses, THEN THE Poller SHALL skip that interval, so that never two Polls are in flight.
6. THE Poller SHALL apply the timeout `POLL_TIMEOUT_MS` to every request, SHALL read at most 1 MiB of a response body, and SHALL NOT follow redirects.
7. THE Poller SHALL read from a response only the metric label `service` and the sample value, SHALL accept only the four known Service names, and SHALL treat a missing, duplicated, non-numeric or non-finite value as `null`, without throwing for any response body.
8. WHEN the API shuts down, THE Poller SHALL stop its timer and abort a request in flight, and SHALL NOT start another Poll.

### Requirement 3: Prometheus failure handling

**User Story:** As an on-call engineer, I want the house to keep its last known state when Prometheus is unreachable, so that a monitoring blip does not look like a recovery or an outage.

#### Acceptance Criteria

1. IF a request times out, fails to connect, answers with a status other than 200, returns a body that is not a Prometheus success result, or exceeds the size limit, THEN THE Poll SHALL fail as a whole, even if the other two queries succeeded.
2. WHEN a Poll fails, THE API SHALL keep every Haunt level, Haunt reason and Open Incident unchanged, SHALL store no Signal, and SHALL NOT count the Poll toward Hysteresis or toward the closing of an Incident.
3. WHEN the first Poll fails, or the first Poll after a successful one fails, THE API SHALL mark ingest as Stale and publish `ingest.status` with state `stale`.
4. WHEN the first Poll succeeds, or the first Poll after a failed one succeeds, THE API SHALL publish `ingest.status` with state `ok`.
5. WHILE the state does not change, THE API SHALL NOT publish `ingest.status`.
6. THE API SHALL NOT crash, leak an unhandled rejection or stop polling because of a failed Poll, and SHALL log one line per failed Poll with the error class and without the URL or response body.
7. WHEN a client sends `GET /api/ingest/status`, THE API SHALL answer `200` with the current ingest status: `state`, the time of the last change and the time of the last successful Poll (or `null`).

### Requirement 4: Signals and retention

**User Story:** As a developer, I want every sample stored with a bounded lifetime, so that the haunt level can be explained and the database does not grow without limit.

#### Acceptance Criteria

1. WHEN a Poll succeeds, THE API SHALL store one Signal row for each Service and each kind (`error_rate`, `p95_ms`, `up`) whose value is not `null`, all with the time of that Poll as `at`, and none for a `null` value.
2. THE stored values SHALL be the error ratio from 0 to 1, the p95 in milliseconds, and the `up` average from 0 to 1.
3. WHEN the API has started, and then every 10 minutes, THE API SHALL delete the Signals whose `at` is older than `SIGNAL_RETENTION_H` hours, in batches of 5000 rows, until a batch deletes fewer rows than its limit.
4. THE retention SHALL delete only Signal rows with `at` strictly before the cut-off, and SHALL NOT touch any other table.
5. IF a retention run fails, THEN THE API SHALL log it, keep polling, and try again at the next run.
6. THE schema SHALL have an index on `Signal.at` for the retention delete.

### Requirement 5: Haunt score

**User Story:** As an on-call engineer, I want one number per service that says how bad it is and why, so that I can see the worst room at a glance.

#### Acceptance Criteria

1. THE Shared package SHALL export a pure function `scoreSample` that maps one Sample to a Raw level from 0 to 4 and a Haunt reason or `null`, with no I/O and no clock.
2. THE thresholds SHALL be named constants in Shared: error ratio 0.05, 0.2 and 0.5; p95 500, 1000 and 3000 milliseconds; and the `up` value below 0.5 for a down Service.
3. THE Raw level SHALL be the highest of: 1, 2 or 3 for an error ratio at or above the first, second or third threshold; 1, 2 or 3 for a p95 at or above the first, second or third threshold; and 4 when `up` is below 0.5.
4. A value that is `null` SHALL contribute 0 to the Raw level.
5. THE Haunt reason SHALL name the Signal that gives the Raw level and its value, and when several Signals give the same level it SHALL prefer `down`, then `error_rate`, then `p95`; a Raw level of 0 SHALL have the reason `null`.
6. THE score SHALL be monotonic: if no value of Sample B is better than the same value of Sample A (a higher error ratio, a higher p95, a lower `up`, with `null` as the best value), THEN the Raw level of B is not lower than the Raw level of A.
7. THE function SHALL be total: for any input, including `NaN`, infinities and negative numbers, it SHALL return a level from 0 to 4 and SHALL NOT throw; a non-finite value counts as `null` and a negative error ratio or p95 counts as 0.

### Requirement 6: Hysteresis

**User Story:** As an on-call engineer, I want the level not to flicker, so that I can trust a change when I see one.

#### Acceptance Criteria

1. THE Shared package SHALL export a pure function `stepHaunt(state, sample)` that returns the next state, where the state holds the Haunt level, the Haunt reason, and two pending streaks: consecutive higher Polls and consecutive lower Polls, each with its count, its candidate level and its candidate reason.
2. WHEN a Sample has a Raw level above the current level, THE function SHALL count a higher Poll, and WHEN 2 consecutive higher Polls have been counted, THE function SHALL raise the level to the lowest Raw level among those 2 Polls.
3. WHEN a Sample has a Raw level below the current level, THE function SHALL count a lower Poll, and WHEN 3 consecutive lower Polls have been counted, THE function SHALL lower the level to the highest Raw level among those 3 Polls.
4. WHEN a Sample has a Raw level equal to the current level, THE function SHALL reset both pending streaks and take the Haunt reason from that Sample; WHEN the direction changes, THE function SHALL reset the pending streak of the other direction.
5. A single Poll SHALL NOT change the level.
6. WHEN the level changes, THE function SHALL take the Haunt reason from the Sample whose Raw level became the new level, and from the later Sample if both have that level.
7. A No-data Sample SHALL leave the whole state unchanged, including both pending streaks.
8. THE initial state of a Service SHALL be the stored `hauntLevel` with the stored reason and no pending streaks, so that an API restart keeps the level and restarts the counts.

### Requirement 7: Service state and events

**User Story:** As a web client, I want to hear about changes only when something changed, so that the table updates without noise.

#### Acceptance Criteria

1. WHEN the level or the Haunt reason kind of a Service changes, THE API SHALL write `Service.hauntLevel` and the reason in one transaction with any Incident change, and after the commit SHALL publish `service.updated` with the full Service state.
2. WHEN neither the level nor the reason kind changes, THE API SHALL NOT publish `service.updated`, even if the reason value or any metric changed.
3. WHEN a Poll succeeds, THE API SHALL publish one `ingest.polled` event with the Sample of each of the four Services, so that live metrics need one event per Poll and not one per value.
4. THE payload shapes of `ingest.polled`, `ingest.status`, `service.updated`, `incident.opened` and `incident.closed` SHALL be defined in Shared with total validators, and THE API SHALL publish only payloads that pass them.
5. IF a database write fails, THEN THE API SHALL keep the previous in-memory state of that Service, publish nothing for it, log the error, and keep polling; a database failure SHALL NOT mark ingest as Stale.
6. THE API SHALL NOT publish `signal.recorded` for polled values.

### Requirement 8: Incidents

**User Story:** As an on-call engineer, I want an incident to open when a service is really haunted and close when it has been calm for a while, so that later hunts have a clear subject.

#### Acceptance Criteria

1. WHEN a Service reaches level 2 or higher and has no Open Incident, THE API SHALL create an Incident with `peakLevel` set to that level and, after the commit, publish `incident.opened`.
2. THE API SHALL keep at most one Open Incident per Service, and IF the database rejects a second open Incident, THEN THE API SHALL treat the Incident as already open and continue.
3. WHILE an Incident is open and the level rises above its `peakLevel`, THE API SHALL raise `peakLevel`, so that the peak equals the highest level held while the Incident was open.
4. WHEN a Service has stayed at level 0 for 30 s of successful Poll time, THE API SHALL close its Open Incident, set `closedAt`, and after the commit publish `incident.closed` with the `peakLevel`.
5. WHEN a successful Poll shows a level above 0, THE API SHALL restart the 30 s count.
6. A Service at level 1 with no Open Incident SHALL NOT open one, and an Open Incident SHALL stay open at level 1.
7. WHEN the API starts, THE API SHALL load each Open Incident from the database and start the 30 s count at the first successful Poll that shows level 0.

### Requirement 9: Shared types, schema and service route

**User Story:** As a developer, I want the new state in one shared definition and one migration, so that API and Web cannot disagree.

#### Acceptance Criteria

1. THE Shared package SHALL extend `ServiceState` with `reason` (a Haunt reason or `null`), `metrics` (`errorRate`, `p95Ms`, `up`, each a number or `null`, plus the time `at`, or `null` when nothing was recorded) and `openIncident` (`id`, `openedAt`, `peakLevel`, or `null`), with exact total validators.
2. WHEN a client sends `GET /api/services`, THE API SHALL answer the four Services in room order with `reason` from the stored Service columns, `metrics` from the latest Sample (or, before the first successful Poll after a start, from the Signals recorded in the last 60 s, or `null`), and `openIncident` from the Open Incident.
3. THE Prisma schema SHALL add the enum `HauntReasonKind` and the nullable columns `Service.reasonKind` and `Service.reasonValue`, with a committed migration that keeps the partial unique index `incident_one_open_per_service`.
4. THE migration SHALL apply to an empty database and to a database migrated by `foundation`, and the seed SHALL leave `hauntLevel` 0 and the reason `null` for all four Services.
5. THE API and THE Web SHALL import these types, thresholds and validators from Shared and SHALL NOT redefine them.

### Requirement 10: Table mode

**User Story:** As a judge or an on-call engineer, I want to see each service's state and the cause in a table that updates by itself, so that I can follow an incident without the scene.

#### Acceptance Criteria

1. THE Table mode SHALL show for each Service: its name, the Haunt level as a number and a text label, a marker whose shape differs for each level and does not depend on colour, the Haunt reason as text, the error ratio, the p95, the `up` value, and its Open Incident (opened time and peak level) or the text "none".
2. THE Haunt reason text, built from the kind and value of the reason, SHALL read "error rate 22%" for `error_rate`, "p95 2.2 s" for `p95` (milliseconds below 1000 shown as "p95 640 ms") and "service down" for `down`, and SHALL read "none" when the reason is `null`.
3. WHERE a metric value is `null` or `metrics` is `null`, THE Table mode SHALL show the text "no data" for it.
4. WHEN `service.updated`, `ingest.polled`, `incident.opened` or `incident.closed` arrives, THE Web SHALL update the affected row without a reload, and an event that was already applied SHALL change nothing.
5. WHEN `ingest.status` has state `stale`, THE Table mode SHALL show a text notice with the time of the last successful Poll and keep the last values, and SHALL remove the notice when the state is `ok`.
6. WHEN the Haunt level of a Service changes, THE Web SHALL announce it in a polite live region with a short sentence such as "payments: haunted", once per change.
7. WHEN the stream connects, and after a `resync`, THE Web SHALL load `GET /api/services` and `GET /api/ingest/status`, and THE rows SHALL stay in room order.
8. THE Table mode SHALL remain a semantic table with a caption and column headers, reachable by keyboard, with text contrast of at least 4.5:1, and the scene mount SHALL stay as it is.

### Requirement 11: G1 script

**User Story:** As the team, I want one command that proves gate G1 against the real lab, so that the check can be repeated and shown.

#### Acceptance Criteria

1. THE repo SHALL contain `scripts/g1-score.mjs`, which reads `API_URL` (default `http://127.0.0.1:3000`) and `CHAOS_URL` (default `http://127.0.0.1:4100`) and `CHAOS_TOKEN` from the environment only, and IF `CHAOS_TOKEN` is missing THEN it SHALL exit 1 naming the variable.
2. BEFORE the first Scenario, THE script SHALL wait up to 120 s until `GET /api/services` shows all four Services at level 0 with no Open Incident, and otherwise fail.
3. FOR EACH Scenario (`error-spike`, `fog`, `dark-room`), THE script SHALL apply it with `POST {CHAOS_URL}/chaos/scenarios/<name>/apply` and SHALL assert within 60 s that its Service has a level of 2 or higher, an Open Incident, and the reason kind `error_rate` (payments), `p95` (orders) or `down` (ledger).
4. AFTER each Scenario, THE script SHALL reset with `POST {CHAOS_URL}/chaos/reset` and SHALL assert within 120 s that the Service is at level 0; the longer limit covers the 1 minute rate window, the 3 lower Polls of Hysteresis and the Prometheus scrape delay.
5. THE script SHALL print a table with the Scenario, the Service, the detected level and reason, the seconds to detect and the seconds to recover, and SHALL exit 0 when every Scenario passes and 1 otherwise.
6. THE script SHALL send the reset also when it fails or receives SIGINT or SIGTERM, SHALL never print `CHAOS_TOKEN`, and SHALL contact only `API_URL` and `CHAOS_URL`.

### Requirement 12: Untrusted input, logging and docs

**User Story:** As a maintainer, I want the ingest path to treat Prometheus as untrusted and the setup to be written down, so that the demo is safe and repeatable.

#### Acceptance Criteria

1. THE API SHALL read from a Prometheus response only numbers and the four known Service names, and SHALL NOT copy any other response text into an event, a database row or a log line.
2. THE API SHALL NOT log `PROMETHEUS_URL`, a response body or any token, and the logger redaction from `foundation` SHALL stay in force.
3. THE Prometheus request SHALL send no credentials and no data from the database or from clients.
4. `docs/DEV.md` SHALL describe how to run the API against the lab, the four new variables, and how to run `scripts/g1-score.mjs` with `CHAOS_URL` and `CHAOS_TOKEN` from the environment.
5. WHEN `ingest-haunt-score` is finished, `pnpm typecheck`, `pnpm lint` and `pnpm test` SHALL pass at the root with no database and no Prometheus, and the integration tests SHALL pass with `TEST_DATABASE_URL` set.
