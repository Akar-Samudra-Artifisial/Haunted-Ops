# Requirements Document

## Introduction

`exorcist-agent` is the fifth product spec of Haunted Ops, after `foundation`, `haunted-lab`, `ingest-haunt-score` and `scene-engine`. It turns an Incident into a Hunt: the API starts the Exorcist, a headless `kiro-cli` agent, which investigates the haunted Service only through read-only MCP tools (metrics, errors, logs, deploys, commit diffs) and ends with one diagnosis that names the culprit commit. The API streams every step to the scene and the table, checks the diagnosis against the lab, and records the Hunt.

Task 0 (the G0 feasibility spike, done on 12 Nov 2026, `spikes/g0/G0.md`) proved that one headless hunt works, that tools outside the allow-list are not available to the model, and that a three-tool hunt costs about 0.6 credits and 33 s. Its "Decisions for the spec" are binding for this document: headless `kiro-cli` with `--output-format stream-json`, the double allow-list (agent config and `--trust-tools`), `submit_diagnosis` as the only output channel validated by the server, `<untrusted_data>` wrapping, the agent committed in its upgraded format in `.kiro/agents/exorcist.json`, `--require-mcp-startup`, a minimal working directory without project steering, credits read from `_meta.kiro.credits` with a cap, an allow-list check of every `tool_call` in the API, and a pinned model.

The target is Gate G2 on 20 Nov 2026: in the lab, an Incident starts a Hunt, the Exorcist calls lab tools, evidence streams to the scene and the table live, and the Hunt ends with a validated diagnosis that names the planted culprit commit, for all three scenarios.

Out of scope: opening pull requests, `propose_fix` and human approval (`fix-proposal-flow`), authentication of `kiro-cli` on EC2 (`deploy-demo`), replays (`replay`), sound (`spatial-audio`).

## Glossary

- **Workspace**, **API**, **Web**, **Shared**, **Service**, **Haunt level**, **Incident**, **Open Incident**, **Table mode**, **Scene**, **Room**, **Room visual**, **Hunt slot**, **SSE stream**: as defined in the `foundation`, `ingest-haunt-score` and `scene-engine` specs.
- **Lab**: the separate repo `haunted-lab`: four Services, a supervisor with the chaos API (`/chaos/*`, Bearer `CHAOS_TOKEN`) and the observability API (`/lab/*`, Bearer `LAB_READ_TOKEN`), and Prometheus.
- **Observability API**: the read-only `/lab/errors`, `/lab/logs`, `/lab/deploys` and `/lab/commits/{sha}/diff` routes of the lab supervisor (`../haunted-lab/.kiro/specs/haunted-lab/design.md:109-120`).
- **Scenario**: one of the lab faults `error-spike` (payments), `fog` (orders), `dark-room` (ledger), each caused by one planted commit whose SHA is recorded in `../haunted-lab/scripts/scenario-shas.json`.
- **Exorcist**: the Kiro agent `exorcist` that investigates one Incident.
- **Exorcist MCP server**: the stdio MCP server in `packages/exorcist-mcp`, started by `kiro-cli` once per Hunt.
- **Read tool**: one of `query_metrics`, `search_errors`, `tail_logs`, `recent_deploys`, `diff_commit`.
- **Hunt**: one investigation of one Incident by one `kiro-cli` process, from queued to finished.
- **Hunt runner**: the `hunts` module of the API that queues, starts, watches, stops and records Hunts.
- **Trigger**: what asks for a Hunt: `auto` (an `incident.opened` event at level 2 or higher) or `operator` (`POST /api/hunts`).
- **Step**: one call of a Read tool or of `submit_diagnosis` during a Hunt, as seen in the stream.
- **Evidence handle**: a short reference (for example `deploy:d-102`) that the Exorcist MCP server attaches to each item it returns; a diagnosis may cite only handles issued in its own Hunt.
- **Hunt ledger**: the JSON Lines file the Exorcist MCP server writes for one Hunt: the issued Evidence handles and the submitted diagnosis.
- **Diagnosis**: the input of `submit_diagnosis`: `service`, `culprit_deploy`, `culprit_sha`, `summary`, `evidence[{kind, ref, detail}]`, `fix_hint`.
- **Valid diagnosis**: a Diagnosis that passes every server-side check of Requirement 11.
- **Credits**: the Kiro usage unit reported in `_meta.kiro.credits` of the stream.
- **Per-hunt cap**, **Daily cap**: the most Credits one Hunt, and all Hunts of one UTC day, may use.
- **Kill switch**: the setting that stops new Hunts at once.
- **Untrusted data**: any text that comes from the Lab, Prometheus or the model: error messages, log lines, commit subjects, authors, diffs, the diagnosis summary and fix hint.
- **Fake kiro-cli**: a test program, selected by `KIRO_CLI_PATH`, that behaves like `kiro-cli` on the command line and in the stream, with no model and no Credits.
- **G0**, **G2**: the feasibility gate (task 0) and the hunt gate (20 Nov 2026).

## Requirements

### Requirement 1: G0 feasibility spike

**User Story:** As the Haunted Ops team, I want to prove that one headless Exorcist hunt works end to end and know its cost, so that I can decide between headless `kiro-cli` and the ACP fallback before writing the rest of the spec.

#### Acceptance Criteria

1. WHEN the headless command `kiro-cli chat --no-interactive` is run with the Exorcist agent, THE Exorcist SHALL investigate using only the MCP tools `query_metrics`, `diff_commit` and `submit_diagnosis`.
2. WHEN the Exorcist is asked to use a tool outside the allow-list (for example a shell command), THE system SHALL refuse the call.
3. WHEN the hunt finishes, THE Exorcist SHALL have called `submit_diagnosis` once with a valid `{summary, evidence[{kind,ref,detail}], culprit_commit, confidence}` payload, and THE MCP server SHALL write it to `spikes/g0/out/diagnosis.json`.
4. WHEN the hunt finishes, THE spike SHALL record the exit code, wall time and credits used.
5. WHEN the spike is complete, THE spike SHALL record a verdict line `G0: PASS` or `G0: FAIL — <reason>` and a "Decisions for the spec" section in `spikes/g0/G0.md`.

### Requirement 2: Exorcist MCP server

**User Story:** As the Haunted Ops team, I want a small, typed MCP server that is the Exorcist's only window on the world, so that the agent can investigate and nothing else.

#### Acceptance Criteria

1. THE Workspace SHALL contain the package `packages/exorcist-mcp` (TypeScript strict, ESM), a stdio MCP server built on the official MCP SDK at a pinned exact version, exposing exactly the tools `query_metrics`, `search_errors`, `tail_logs`, `recent_deploys`, `diff_commit` and `submit_diagnosis`.
2. THE Exorcist MCP server SHALL expose no tool that writes to the Lab, the repository, the file system (other than its own Hunt ledger) or any other system, and SHALL run no shell command.
3. THE Read tools `search_errors`, `tail_logs`, `recent_deploys` and `diff_commit` SHALL be thin read-only clients of the Observability API at `LAB_URL` with the bearer `LAB_READ_TOKEN`, and `query_metrics` SHALL read Prometheus at `PROMETHEUS_URL`, because the Observability API has no metrics route.
4. THE Exorcist MCP server SHALL read `LAB_URL`, `LAB_READ_TOKEN`, `PROMETHEUS_URL` and its Hunt ledger path from the environment, SHALL accept a `LAB_URL` or `PROMETHEUS_URL` whose host is not loopback only when `LAB_ALLOW_REMOTE` or `PROMETHEUS_ALLOW_REMOTE` is `true`, and SHALL refuse link-local hosts always.
5. IF a required setting is missing or invalid, THEN THE Exorcist MCP server SHALL exit with a non-zero code before it answers the MCP handshake, and its error message SHALL name the variables, never their values.
6. THE Exorcist MCP server SHALL write diagnostics only to stderr, without any environment value, and SHALL keep stdout for the MCP protocol.
7. EVERY request of the Exorcist MCP server to the Lab or Prometheus SHALL have a timeout of 5 s and a response size limit of 1 MiB, and a failure SHALL become a tool error result, not a crash.

### Requirement 3: Read tools

**User Story:** As the Exorcist, I want a few precise read tools with tight inputs, so that I can follow an incident from the metric to the commit without being able to wander.

#### Acceptance Criteria

1. EVERY tool SHALL declare a JSON Schema input with `additionalProperties: false`, and THE Exorcist MCP server SHALL reject an input with an unknown field, a wrong type or a value out of bounds with a tool error that names the field.
2. THE input `service` SHALL be one of `gate`, `orders`, `payments`, `ledger`; a SHA SHALL match `^[0-9a-f]{7,40}$`; `since` SHALL be an ISO-8601 UTC instant no more than 6 hours in the past and no more than 1 minute in the future; `limit` SHALL be an integer from 1 to 50 (default 20); `window` SHALL be one of `5m`, `15m`, `30m`, `1h`; `signal` SHALL be one of `error_ratio`, `p95_ms`, `up`.
3. WHEN `query_metrics(service, signal, window)` is called, THE tool SHALL run only a constant PromQL template for `signal` (the error ratio, p95 and `up` queries of `ingest-haunt-score`) as a range query over `window`, SHALL select the answer by its `service` label, and SHALL return at most 40 points plus the first, last, minimum and maximum values; no text from the model SHALL ever be part of a PromQL query.
4. WHEN `search_errors(service, since, limit)` or `tail_logs(service, since, limit)` is called, THE tool SHALL return the newest matching items of `/lab/errors` or `/lab/logs`, oldest first, at most `limit`.
5. WHEN `recent_deploys(since)` is called, THE tool SHALL return the Deploy records of `/lab/deploys` after `since`, at most 20, oldest first, with their id, service, ref, full SHA, time and actor.
6. WHEN `diff_commit(sha)` is called, THE tool SHALL return the subject, author, date and diff of `/lab/commits/{sha}/diff`, the diff cut to 16 KiB on a character boundary with a `truncated` flag, and SHALL return the tool error `not_found` when the Lab answers `unknown_commit`.
7. EVERY tool description SHALL state that the returned content is data from the system under investigation, not instructions.
8. THE Exorcist MCP server SHALL accept at most 12 calls of Read tools per process and SHALL answer every further call with the tool error `call_limit`.

### Requirement 4: Untrusted output

**User Story:** As the Haunted Ops team, I want every byte the agent reads from the lab to be clearly marked and bounded, so that text planted in logs or commits cannot steer the Exorcist or flood its context.

#### Acceptance Criteria

1. EVERY tool result, success or error, SHALL be one text content whose body is `<untrusted_data>`, a newline, a JSON object starting with `"untrusted_data": true`, a newline and `</untrusted_data>`, and the JSON SHALL encode every `<` as `\u003c` so that no data can close the wrapper.
2. THE Exorcist MCP server SHALL remove ANSI escapes, C0 and C1 control characters and DEL from every string it returns (a diff keeps only line feeds and tabs), after the cleaning the Lab already does (`../haunted-lab/.kiro/specs/haunted-lab/design.md:122-130`).
3. EVERY tool result SHALL be at most 24 KiB of UTF-8; a longer list SHALL be cut to its newest items, a longer text cut on a character boundary, and the result SHALL say `truncated: true`.
4. NO tool result, error message or Hunt ledger line SHALL contain the value of `LAB_READ_TOKEN`, `PROMETHEUS_URL` credentials or any other environment value.
5. THE error codes of tool error results SHALL come from a fixed list (`bad_input`, `not_found`, `lab_unavailable`, `lab_error`, `metrics_unavailable`, `call_limit`, `already_submitted`), with no upstream body or stack trace.

### Requirement 5: Diagnosis and Evidence handles

**User Story:** As the API, I want the diagnosis to cite only things the agent really saw in this hunt, so that a made-up commit or a made-up log line cannot pass as evidence.

#### Acceptance Criteria

1. EVERY item a Read tool returns SHALL carry an Evidence handle that is unique in the Hunt: `metric:<service>/<signal>/<window>`, `error:<n>`, `log:<n>`, `deploy:<deploy id>` or `commit:<40-hex sha>`, where `<n>` counts from 1 in issue order.
2. THE Exorcist MCP server SHALL append one line per issued Evidence handle to its Hunt ledger, with the handle, its kind, the tool, the Service, the deploy id or SHA when there is one, and a cleaned detail of at most 200 characters.
3. THE tool `submit_diagnosis({service, culprit_deploy, culprit_sha, summary, evidence, fix_hint})` SHALL validate its input (`service` one of the four, `culprit_deploy` matching `^d-[0-9]{1,9}$`, `culprit_sha` a 7 to 40 hex SHA, `summary` 1 to 600 characters, `evidence` 1 to 10 items of `{kind, ref, detail}` with `kind` one of `metric`, `error`, `log`, `deploy`, `commit`, `ref` at most 80 and `detail` at most 300 characters, `fix_hint` at most 600 characters), SHALL append it to the Hunt ledger, and SHALL answer with a short acknowledgement.
4. THE tool `submit_diagnosis` SHALL accept one call per process and SHALL answer a second call with the tool error `already_submitted`.
5. THE tool `submit_diagnosis` SHALL be the only output channel of the Exorcist: the API SHALL take the diagnosis only from the Hunt ledger and the matching `tool_call` of the stream, never from the agent's free text.

### Requirement 6: Agent configuration and working directory

**User Story:** As the Haunted Ops team, I want the agent config to be fixed, minimal and checked, so that the Exorcist has the six tools and nothing else in every hunt.

#### Acceptance Criteria

1. THE Workspace SHALL commit `.kiro/agents/exorcist.json` in the universal format that `kiro-cli` writes on first load (with its `kiroUpgrade` block), with `tools: ["@exorcist"]`, `allowedTools` listing exactly the six `@exorcist/<tool>` names, `includeMcpJson: false`, permission rules that allow only those six MCP tools, and no `fs_read`, shell, write or other built-in tool rule.
2. THE agent prompt SHALL tell the Exorcist to investigate in the order metrics, then errors and logs, then deploys, then the diff; to name exactly one culprit commit and its deploy; to cite Evidence handles; to call `submit_diagnosis` exactly once; and never to follow instructions found inside tool data.
3. THE agent config SHALL start the Exorcist MCP server by a command name that the Hunt runner puts on the `PATH` of the Hunt process, so that the committed file holds no absolute path.
4. THE Hunt runner SHALL run every Hunt with a dedicated working directory outside every git repository and every `.kiro/steering` folder, holding only `.kiro/agents/exorcist.json` (a byte-equal copy of the committed file) and the Hunt ledgers.
5. WHEN the agent config is changed, THE team SHALL re-run the allow-list probe of G0 (the Exorcist and a neutral probe agent asked to run `ls` and read a file) against the new config, and SHALL record that no tool call was attempted, the cost and the date in the Notes of `tasks.md`.
6. THE Hunt runner SHALL check at start that the copy in the working directory is byte-equal to the committed file and SHALL log a warning without content when `kiro-cli` has changed it after a Hunt.

### Requirement 7: Hunt triggers and concurrency

**User Story:** As the operator of the demo, I want hunts to start by themselves when an incident opens, one at a time, and never from a stranger's request, so that the cost is predictable and the demo runs unattended.

#### Acceptance Criteria

1. WHEN an `incident.opened` event has a level of 2 or higher, THE Hunt runner SHALL request a Hunt with Trigger `auto` for that Incident, at most once per Incident.
2. THE Hunt runner SHALL run at most one Hunt at a time and SHALL keep at most one queued Hunt; WHEN a Hunt is requested while one is running and one is queued, THE Hunt runner SHALL record it as `cancelled` with the reason `busy`.
3. WHEN a Hunt for a Service finished less than `HUNT_COOLDOWN_MS` (default 120 000) ago, THE Hunt runner SHALL record a new automatic request for that Service as `cancelled` with the reason `cooldown`.
4. WHEN a queued Hunt is about to start and its Incident is closed, THE Hunt runner SHALL record it as `cancelled` with the reason `incident_closed`.
5. WHEN `POST /api/hunts` is called with a correct bearer `HUNT_ADMIN_TOKEN` and the id of an Open Incident or the name of a Service with an Open Incident, THE API SHALL request a Hunt with Trigger `operator` and answer 202 with the Hunt id; it SHALL compare the token in constant time, answer 401 without a hint for a missing or wrong token, and limit the route to 5 requests per minute per client.
6. THE API SHALL offer no other way to start a Hunt.
7. WHILE the Kill switch is on (`HUNTS_ENABLED` is not `true`, or an operator turned Hunts off with `POST /api/hunts/kill-switch`), THE Hunt runner SHALL start no Hunt and SHALL record every request as `cancelled` with the reason `disabled`; the default of `HUNTS_ENABLED` SHALL be `false`.
8. WHEN the Kill switch is turned on while a Hunt runs, THE Hunt runner SHALL stop that Hunt and record it as `cancelled` with the reason `disabled`.

### Requirement 8: Hunt process

**User Story:** As the Haunted Ops team, I want each hunt to be one tightly controlled child process, so that a stuck, slow or misbehaving run cannot hurt the API.

#### Acceptance Criteria

1. THE Hunt runner SHALL start `kiro-cli` with `execFile` and an argument array, never through a shell: `chat --no-interactive --trust-workspace --require-mcp-startup --agent exorcist --model <EXORCIST_MODEL> --output-format stream-json --trust-tools=<the six @exorcist/<tool> names, comma-separated>` followed by one prompt built from a fixed template with only the Incident id, the Service name, the Haunt level, the reason kind and the opening time.
2. THE executable SHALL be `KIRO_CLI_PATH` (default `kiro-cli`), resolved once at start to an absolute path; `EXORCIST_MODEL` SHALL be a pinned model name (default `claude-sonnet-5.5`) and SHALL NOT be `auto`.
3. THE environment of the Hunt process SHALL contain only `PATH` (the Exorcist MCP launcher, Node and `kiro-cli` folders and the system folders), `HOME`, `LANG`, `TERM=dumb`, `NO_COLOR=1`, `LAB_URL`, `LAB_READ_TOKEN`, `LAB_ALLOW_REMOTE`, `PROMETHEUS_URL`, `PROMETHEUS_ALLOW_REMOTE`, `HUNT_ID` and `HUNT_LEDGER_PATH`, and SHALL NOT contain `DATABASE_URL`, `HUNT_ADMIN_TOKEN`, `CHAOS_TOKEN` or any GitHub token.
4. THE Hunt process SHALL run in its own process group; WHEN the wall-clock time of a Hunt reaches `HUNT_TIMEOUT_MS` (default 90 000; a recorded hunt took 59 s), THE Hunt runner SHALL send SIGTERM to the group, SIGKILL after 2 s, and record the Hunt as `failed` with the reason `timeout`.
5. WHEN the API shuts down, THE Hunt runner SHALL stop a running Hunt the same way and record it as `cancelled` with the reason `shutdown`; WHEN the API starts, THE Hunt runner SHALL record every Hunt left `queued` or `running` as `failed` with the reason `api_restart`.
6. WHEN `kiro-cli` exits with code 3, THE Hunt runner SHALL record the Hunt as `failed` with the reason `mcp_startup`; any other non-zero exit without a Valid diagnosis SHALL be `failed` with the reason `cli_error`.
7. THE Hunt runner SHALL limit the output it reads from the Hunt process to 8 MiB and SHALL stop the Hunt with the reason `stream_error` beyond it.
8. THE API SHALL NOT log the raw stream, the prompt, the agent's free text or any environment value.

### Requirement 9: Stream parsing and hunt events

**User Story:** As a viewer, I want to see each step of the hunt as it happens, so that the demo shows the investigation and not a spinner.

#### Acceptance Criteria

1. THE Hunt runner SHALL parse the stream as JSON Lines into typed events (`tool_call`, `tool_call_update`, `session_info_update` with `_meta.kiro`, `runFinished`), SHALL ignore unknown event types, and SHALL stop the Hunt with the reason `stream_error` after more than 20 lines that are not valid JSON.
2. THE API SHALL publish the SSE events `hunt.queued`, `hunt.started`, `hunt.step`, `hunt.evidence`, `hunt.diagnosis` and `hunt.finished`, with payload types and validators in `packages/shared`, through the existing event bus and ring buffer, so that they resume like the other domain events.
3. WHEN a `tool_call` of an `@exorcist` tool appears, THE API SHALL publish `hunt.step` with the step index, the tool name and a summary of at most 120 characters built by the API from the validated tool arguments, never from model text.
4. WHEN the Hunt ledger gains an Evidence handle, THE API SHALL publish `hunt.evidence` with its kind, handle and cleaned detail.
5. FOR EACH Hunt, THE events SHALL be published in the order: one `hunt.queued`; then, if the Hunt starts, one `hunt.started`, any number of `hunt.step` and `hunt.evidence`, and at most one `hunt.diagnosis`; and last exactly one `hunt.finished` with the status, the reason, the Credits and the duration.
6. THE API SHALL publish `hunt.diagnosis` only for a Valid diagnosis.

### Requirement 10: Cost and tool guards

**User Story:** As the team paying for credits, I want hard limits that stop a hunt the moment it misbehaves or costs too much, so that a bad run cannot drain the budget.

#### Acceptance Criteria

1. THE Hunt runner SHALL read the Credits of every `_meta.kiro.credits` report of the stream, SHALL store the running total of the Hunt in the database at each report, and WHEN the total reaches the Per-hunt cap (`HUNT_CREDIT_CAP`, default 1.5) SHALL stop the Hunt and record it as `failed` with the reason `credit_cap`.
2. BEFORE a Hunt starts, THE Hunt runner SHALL compute the Credits used by the Hunts of the current UTC day from the database, and WHEN that total plus the Per-hunt cap is above the Daily cap (`HUNT_DAILY_CREDIT_CAP`, default 30) SHALL record the Hunt as `cancelled` with the reason `daily_cap`.
3. WHILE a Hunt runs, THE Hunt runner SHALL stop it with the reason `daily_cap` as soon as the day's total reaches the Daily cap.
4. WHEN the stream shows a `tool_call` whose tool is not one of the six `@exorcist/<tool>` names and is not the built-in `Tool Load` loading only those names, THE Hunt runner SHALL stop the Hunt and record it as `failed` with the reason `foreign_tool`, and SHALL NOT publish or store a diagnosis from it.
5. WHEN a Hunt has more than `HUNT_MAX_TOOL_CALLS` (default 20; a recorded hunt made 12: six `Tool Load` calls and six tool calls, and the most the MCP server allows is 6 loads, 12 read calls and 1 diagnosis) tool calls, THE Hunt runner SHALL stop it with the reason `tool_limit`.
6. THE cost of a Hunt SHALL never exceed the Per-hunt cap by more than the Credits of one report of the stream.

### Requirement 11: Diagnosis validation

**User Story:** As a viewer and a judge, I want a "found it" only when the evidence holds up, so that the Exorcist never shows a wrong culprit as a success.

#### Acceptance Criteria

1. WHEN the Hunt process ends with a diagnosis in the Hunt ledger, THE API SHALL accept it as a Valid diagnosis only if: its `service` is the Service of the Incident; `culprit_deploy` is a Deploy record of `/lab/deploys` for that Service; the SHA of that Deploy record starts with `culprit_sha`; the Lab serves `/lab/commits/{sha}/diff` for that SHA (it is reachable from an allow-listed ref); every `ref` of the evidence is an Evidence handle issued in this Hunt with the same kind; the evidence cites the culprit deploy or the culprit commit; and the diagnosis in the ledger equals the arguments of the `submit_diagnosis` tool call in the stream.
2. WHEN a check of 11.1 fails, THE API SHALL record the Hunt as `failed` with the reason `invalid_diagnosis` and the name of the failed check, SHALL publish no `hunt.diagnosis`, and THE Web SHALL never show it as a success.
3. WHEN the Hunt process ends without a diagnosis, THE API SHALL record the Hunt as `failed` with the reason `no_diagnosis`.
4. WHEN the diagnosis is valid, THE API SHALL store the full 40-character SHA of the culprit Deploy record, the deploy id, the summary and fix hint (cleaned and capped), mark the cited Evidence, record the Hunt as `succeeded` with the reason `diagnosed`, and publish `hunt.diagnosis` before `hunt.finished`.
5. THE API SHALL treat the summary, the fix hint and every evidence detail as Untrusted data: cleaned of control characters, capped, stored and sent as plain text, never as markup.

### Requirement 12: Persistence and HTTP read API

**User Story:** As a viewer who opens the page during or after a hunt, I want the current hunt and its result from the API, so that a reload does not lose the story.

#### Acceptance Criteria

1. THE API SHALL store per Hunt its status, Trigger, end reason, Service, model, Credits, tool call count, the queued, start and finish times, the duration, the ordered Steps, the ordered Evidence (with a cited flag) and the diagnosis fields, through a committed Prisma migration.
2. WHEN `GET /api/hunts/:id` is called with a valid id, THE API SHALL answer 200 with the Hunt, its Steps, its Evidence and its diagnosis; an unknown id SHALL answer 404 and a malformed id 400.
3. THE response of `GET /api/services` SHALL include for each Service its latest Hunt as a summary (status, reason, at most the last 8 Steps, the number of Evidence items, the diagnosis deploy id, SHA and summary when valid, the Credits and the times), or `null`.
4. THE HTTP responses and SSE payloads SHALL never contain the prompt, the raw stream, the agent's free text, a file path of the host or an environment value.

### Requirement 13: Hunt in the scene

**User Story:** As a viewer of the demo, I want to see the Exorcist enter the haunted room and work, so that the investigation reads at a glance.

#### Acceptance Criteria

1. WHEN a Hunt of a Service is running, THE Scene SHALL draw an Exorcist figure in that Room at a place reserved by the Layout inside the Room silhouette and clear of the nameplate, the incident row, the reason badge and the Hunt slot, entering from the Room's door.
2. WHEN a `hunt.step` arrives, THE Scene SHALL show one visual beat (a pulse of the figure's lantern and one more lit mark in the Hunt slot, up to 8 marks), with no more than 3 flashes per second.
3. WHEN a Hunt ends with a Valid diagnosis, THE Scene SHALL draw a seal in the Room and keep a small sealed mark in the Hunt slot while the Incident is open; WHEN a Hunt fails or is cancelled after it started, THE Scene SHALL draw a fizzle (the lantern dims out) and keep a small failed mark.
4. THE Scene SHALL derive all hunt visuals from the Room visual field `hunt` filled by the pure Scene model from the Service's latest Hunt, so that `exorcist-agent` does not change the renderer lifecycle.
5. WHILE reduced motion is on, THE Scene SHALL show the figure at its place without walking, light the marks without pulses, and draw the seal or the fizzle in its final state at once.
6. THE hunt visuals SHALL use only procedural shapes and the existing Palette, SHALL NOT imitate any existing game, film or franchise, and SHALL stay within the particle cap of the Scene.
7. THE Demo mode SHALL offer the frozen scenarios `payments-hunting`, `payments-sealed` and `payments-fizzled` and a hunt in the scripted timeline, with no API call.

### Requirement 14: Hunt in Table mode and announcements

**User Story:** As a keyboard or screen reader user, I want the table to tell me the same hunt story, so that I miss nothing the scene shows.

#### Acceptance Criteria

1. THE Table mode SHALL show for each Service a Hunt cell with the same state as the Scene: none, queued, running with the step count and the last tool, sealed with the deploy id and the short SHA, failed or cancelled with the reason in words.
2. THE Table mode SHALL show, for the selected Service (or the Service of the running Hunt when none is selected), the Steps of its latest Hunt as an ordered list and, when valid, the diagnosis summary and the cited Evidence as text.
3. THE Scene label of a Room and the Table hunt cell SHALL be built by the same helper, and an automated test SHALL check, for any Hunt summary, that the Scene model and the Table agree on the hunt phase, the step count, the culprit and the reason.
4. THE existing polite live region SHALL announce the start of a Hunt, its diagnosis and its failure in one short sentence each, and at most one step sentence every 5 s, without repeating a sentence.
5. THE hunt text in the Table and the announcements SHALL meet the contrast and keyboard rules of the `scene-engine` spec.

### Requirement 15: Testing without credits

**User Story:** As a developer, I want every hunt path covered by fast tests that cost nothing, so that I can change the runner without spending credits.

#### Acceptance Criteria

1. THE Workspace SHALL contain a Fake kiro-cli selected by `KIRO_CLI_PATH`, which accepts the same arguments, reads the agent in its working directory, and either drives the real Exorcist MCP server through a scripted list of tool calls (script mode) or replays a recorded stream (replay mode), writing stream-json events on stdout and exiting like `kiro-cli`.
2. THE scripted fixtures SHALL cover the three Scenarios, a foreign tool call, a run over the Per-hunt cap, no diagnosis, an invalid diagnosis (unknown SHA, unseen Evidence handle, wrong Service), an MCP start failure (exit 3), a timeout, malformed stream lines, and Lab data that contains planted instructions.
3. THE tests SHALL use a fake Lab and a fake Prometheus that answer in the formats of the lab design (`../haunted-lab/.kiro/specs/haunted-lab/design.md:109-120`, `:161-196`), and SHALL run without the Lab, without `kiro-cli` and without Credits.
4. THE recorded fixtures SHALL come from real runs, SHALL be sanitized by a tool under `tools/sanitize-replay` (no host path, user name, email, token, session id or free text beyond the agent's final message) and SHALL be reviewed by a human before they are committed.
5. THE Workspace SHALL contain one opt-in live test, skipped unless `HUNT_LIVE=1`, that runs one real Hunt against a running Lab and checks the Valid diagnosis; `pnpm test` SHALL never spend Credits.

### Requirement 16: Gate G2

**User Story:** As the team, I want one command that proves G2, so that the gate result is a table and not an impression.

#### Acceptance Criteria

1. THE Workspace SHALL contain `scripts/g2-hunt.mjs`, which, with the Lab and the API running, applies each Scenario through the chaos API, waits for the Incident, the Hunt and its end, asserts that the Hunt succeeded and that its culprit SHA equals the SHA of the Scenario in `../haunted-lab/scripts/scenario-shas.json`, records the Credits and the duration, resets the Lab, prints a table and exits 0 when all three pass and 1 otherwise.
2. THE script SHALL read its tokens from the environment, SHALL send `CHAOS_TOKEN` only to `CHAOS_URL`, SHALL print no token, SHALL reset the Lab on failure or Ctrl-C, and SHALL give each Scenario at most 180 s.
3. THE live G2 run SHALL be started by hand only (it spends about 3 hunts of Credits) and its table SHALL be recorded in the Notes of `tasks.md`.

### Requirement 17: Configuration and documents

**User Story:** As a maintainer, I want every new setting named, checked and documented, so that a wrong value fails at start and not in the middle of a demo.

#### Acceptance Criteria

1. THE API SHALL read `LAB_URL` (default `http://127.0.0.1:4100`), `LAB_READ_TOKEN`, `LAB_ALLOW_REMOTE`, `HUNTS_ENABLED`, `HUNT_ADMIN_TOKEN`, `KIRO_CLI_PATH`, `EXORCIST_MODEL`, `HUNT_CREDIT_CAP`, `HUNT_DAILY_CREDIT_CAP`, `HUNT_TIMEOUT_MS`, `HUNT_COOLDOWN_MS`, `HUNT_MAX_TOOL_CALLS` and `HUNT_WORKDIR`, and SHALL refuse to start, naming the variables only, when a value is invalid: tokens shorter than 24 characters or starting with `change-me`, equal tokens, a Per-hunt cap above the Daily cap, a timeout outside 10 to 300 s, or `HUNTS_ENABLED=true` without `LAB_READ_TOKEN`, `HUNT_ADMIN_TOKEN` and an executable `KIRO_CLI_PATH`.
2. `.env.example` SHALL list every new variable with a placeholder and no real value.
3. `docs/DEV.md` SHALL describe the hunt settings, the Kill switch, the fake and live modes, the opt-in live test, the allow-list probe and the G2 run, and SHALL say that a live run spends Credits.
4. WHEN `exorcist-agent` is finished, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` and `pnpm check:build` SHALL pass at the root with no Lab, no `kiro-cli` and no Credits.

### Requirement 18: Cascading Incidents and downstream causes

**User Story:** As the operator of the demo, I want one fault to get one Hunt, on the Service where the fault is, so that the credits go to the cause and not to its symptoms. The first live G2 run (13 Nov 2026, 9 hunts, 2.88 Credits) failed because the lab is one call chain (`gate` calls `orders`, `orders` calls `payments`, `payments` calls `ledger`): a broken Service makes every caller upstream fail too, 2 or 3 Incidents opened within seconds, the first one to open took the running slot, and the real root was cancelled as `busy`.

#### Acceptance Criteria

1. THE Shared package SHALL define `SERVICE_DEPENDENCIES` (`gate` to `orders`, `orders` to `payments`, `payments` to `ledger`) and a pure `downstreamOf(service)`, and these SHALL be the only place the chain is written.
2. WHEN an Incident opens at level 2 or higher, THE Hunt runner SHALL wait `HUNT_SETTLE_MS` (default 10 000, from 0 to 60 000) before it chooses; WHEN the wait ends, it SHALL request one `auto` Hunt for the most downstream Service among the Open Incidents, and SHALL link the other Open Incidents to that Hunt, which means they get no Hunt of their own.
3. WHEN an Incident closes during the wait, THE Hunt runner SHALL request nothing for it.
4. IF a Hunt is running for a Service and an Incident at level 2 or higher opens downstream of it, THEN THE Hunt runner SHALL queue a Hunt for the downstream Service, and SHALL withdraw a queued `auto` Hunt of a Service upstream of it, recording that Hunt as `cancelled` with the reason `downstream`; the downstream request SHALL NOT be cancelled as `busy` because of the withdrawn one.
5. THE operator request `POST /api/hunts` SHALL behave as before: it hunts the Service or Incident it names, whatever is open downstream.
6. THE runner SHALL log one line for each Incident it links, with the Incident ids and Services only.

### Requirement 19: Causes in a Service downstream of the hunted one

**User Story:** As a viewer, I want a Hunt on `gate` to be allowed to say "the culprit is the deploy of `orders`", because that is true, and to see in the table and the scene that the cause is elsewhere.

#### Acceptance Criteria

1. A culprit deploy SHALL be valid when its Service is the hunted Service or any Service downstream of it; a deploy of any other Service SHALL fail the check `deploy_service`.
2. THE API SHALL store and publish the Service of the culprit deploy as `culpritService` with every Valid diagnosis (the `hunt.diagnosis` payload, the Hunt summary, `GET /api/hunts/:id` and the Hunt row), and a success without it SHALL be refused by the database.
3. THE hunt prompt SHALL state the call chain and that the cause may be a recent deploy of the hunted Service or of a Service it depends on, using only the fixed chain and the checked Service name.
4. WHEN the culprit Service differs from the hunted Service, THE Table mode, the Scene label and the announcement SHALL say "caused by <service>".

### Requirement 20: What happened in a failed live Hunt

**User Story:** As a developer, I want to see why a live Hunt stopped and to turn its stream into a fixture, because the first live run showed `foreign_tool` twice and the refused call was never recorded.

#### Acceptance Criteria

1. WHEN the allow-list refuses a tool call, THE runner SHALL record the title (control characters removed, at most 80 characters) and, for a `Tool Load`, its raw ids (at most five, 60 characters each), in one log line and in the nullable Hunt column `stopDetail` (at most 200 characters), shown by `GET /api/hunts/:id`; it SHALL record nothing else of the call.
2. THE runner SHALL keep the reduced stream of each live Hunt in `HUNT_WORKDIR/<huntId>.stream.jsonl` (mode 0600, the last 20 files): tool calls with title and input, updates without their output, Credits and run ends, with no model text, no tool output and no secret.
3. THE allow-list SHALL accept exactly the six `@exorcist/<tool>` calls and a `Tool Load` that names only those tools in every shape `kiro-cli` 3.3.0 is known to send (a string under `id` or `tool_id`, a list under `tool_ids`, `ids`, `tools` or `toolIds`; each as `tool::exorcist::<tool>`, `@exorcist/<tool>` or the bare name), and SHALL NOT judge a call again when its id comes back in a repeated `tool_call` or an update that names the same tool (Requirement 25.1 decides what a different tool means); anything else SHALL stay refused.

### Requirement 21: Gate G2 for a cascade

**User Story:** As the team, I want the gate to fail when a fault gets more than one Hunt or the wrong one.

#### Acceptance Criteria

1. THE G2 script SHALL wait, for each scenario, for the Hunt of the scenario's root Service (`payments`, `orders`, `ledger`), SHALL assert `succeeded`, the planted SHA and `culpritService` equal to the root Service, and SHALL report how many Hunts of other Services were queued during the scenario, which SHALL be 0.
2. BETWEEN scenarios THE G2 script SHALL wait, for at most 120 s, until every Incident is closed.

### Requirement 22: The `Tool Call` wrapper

**User Story:** As the Haunted Ops team, I want a hunt that kiro-cli 3.3.0 runs through its generic tool wrapper to count as the six tools it really called, because the second live G2 run (13 Nov 2026) stopped two of three Hunts with `foreign_tool` (stop detail `Tool Call`) for a call to `tool::exorcist::diff_commit` and `tool::exorcist::tail_logs`.

#### Acceptance Criteria

1. THE allow-list SHALL accept a `tool_call` whose title is exactly `Tool Call` only when its `rawInput` has exactly the keys `tool_id` and `arguments`, `tool_id` is `tool::exorcist::<tool>` for one of the six tools, and `arguments` is an object; it SHALL then treat the call as a step of that tool whose input is `arguments`.
2. ANY other `tool_id` (another server, a built-in tool, a malformed id), any extra or missing key, and arguments that are not an object SHALL be refused as `foreign_tool`, and the `stopDetail` SHALL name the refused `tool_id` (cleaned, at most 80 characters in all).
3. A `tool_call_update` SHALL never be judged as a call, and a repeated `tool_call` for an accepted `toolCallId` SHALL NOT be judged or counted again, whatever its title (including none, `null` or `Tool Call`).
4. THE diagnosis SHALL be read from the `arguments` of a wrapped `submit_diagnosis` exactly as from a direct call.

### Requirement 23: A late Incident after its cause is known

**User Story:** As the operator of the demo, I want no second Hunt on a Service that an upstream Hunt has just named as the cause, because the second live G2 run paid 0.89 Credits for the right answer and then ran a `ledger` Hunt anyway: `ledger` opens its Incident about 25 s after the break, later than the settle window.

#### Acceptance Criteria

1. WHEN a Hunt on Service A succeeds with `culpritService` S other than A, THE Hunt runner SHALL cancel a queued (not running) `auto` Hunt of S whose Incident opened after A's Incident, with the reason `diagnosed_upstream`, and SHALL link it to A's Hunt.
2. WHEN an Incident of S opened after A's Incident and no later than `HUNT_SETTLE_MS` after that diagnosis, THE Hunt runner SHALL record its automatic request as `cancelled` with the reason `diagnosed_upstream` and the same link, and SHALL start no Hunt for it; a later Incident of S SHALL get a Hunt as usual.
3. THE Hunt summary SHALL carry `diagnosedBy` (the Service of the Hunt that diagnosed it), non-null exactly when the reason is `diagnosed_upstream`; `hunt.finished` SHALL carry the same field; `GET /api/hunts/:id` SHALL carry `linkedHuntId`; THE database SHALL refuse a row where the two do not match the reason.
4. THE Table mode, the Scene label and the announcement SHALL say "diagnosed by the <service> hunt" for such a Hunt, from the same helper.
5. WHILE an upstream `auto` Hunt runs and a downstream Incident opens, THE Hunt runner SHALL keep the downstream Hunt queued as before (Requirement 18.4); Requirement 23.1 decides what happens when the upstream Hunt ends. Operator requests SHALL stay as they are.

### Requirement 24: Gate G2 by outcome

**User Story:** As the team, I want G2 to pass when the cause was found once and nothing failed, whichever Service of the cascade found it.

#### Acceptance Criteria

1. A scenario of the G2 script SHALL PASS when, during the scenario, exactly one Hunt succeeded with the scenario's planted SHA and `culpritService` equal to the scenario's root Service (`payments`, `orders`, `ledger`), whichever Service it hunted, and no Hunt failed.
2. THE script SHALL report the hunted Service, the Service of the culprit, the other Hunts that started (each as `service:reason`), the Credits of all Hunts and the duration of the successful one, SHALL wait until no Hunt has changed for 25 s before it judges, and SHALL NOT call a scenario passed while a Hunt is still running at the 180 s limit.

### Requirement 25: Review fixes (code and security review of 13 Nov 2026)

**User Story:** As the owner of the demo, I want the holes found in review closed, because a repeated call id let a foreign tool pass the allow-list, a Hunt could be charged nothing for a real cost, and model text and leftover processes were trusted too far.

#### Acceptance Criteria

1. THE Hunt runner SHALL remember, for each accepted tool call id, the tool it was accepted for. A later `tool_call` or `tool_call_update` with that id SHALL be skipped only when its title is `null` or empty or names the same tool (`@exorcist/<tool>`, `Tool Load` for the same load, `Tool Call` for a wrapper of the same tool) and its `rawInput`, when present, names the same tool. Anything else SHALL be judged again, and a different tool SHALL end the Hunt as `foreign_tool`. The kiro-cli 3.3.0 sequences (call, update with `title: null`, update with the same title) SHALL still pass.
2. THE Hunt runner SHALL read the diagnosis from the latest complete `rawInput` of any update of the `submit_diagnosis` call, not only from the first `tool_call`.
3. WHEN a Hunt that started ends without any Credits report, THE runner SHALL record `HUNT_CREDIT_CAP` as its Credits, SHALL set `creditsEstimated`, shown by `GET /api/hunts/:id`, and SHALL count it in the day's budget. A Hunt whose process never started SHALL record 0.
4. THE setting `HUNT_DAILY_MAX` (default 40, 1 to 500) SHALL limit the Hunts that may start per UTC day, automatic and operator together. A request beyond it, and a queued Hunt that would start beyond it, SHALL be recorded `cancelled` with the reason `daily_limit`.
5. WHEN a Hunt process starts, THE runner SHALL write `<workdir>/<huntId>.pid` with the pid and process group, and SHALL delete it when the process ends. At start, before stale Hunts are marked, THE runner SHALL kill (SIGTERM, SIGKILL after 2 s) the process group of every note whose process still runs a `kiro-cli` command line, and delete the notes. It SHALL NOT kill a process whose command line is not `kiro-cli`, whose group differs from the note, or whose note cannot be read.
6. WHEN a valid diagnosis was received before a `credit_cap` or `tool_limit` stop, THE runner SHALL validate it and, if it passes, end the Hunt `succeeded` / `diagnosed` with the stop in `stopDetail`.
7. IF the store throws when a Hunt ends, THE runner SHALL try once more; if that fails too it SHALL still publish `hunt.finished`, drop the Hunt from memory and log the error code only. A diagnosis that was not stored SHALL NOT be published.
8. THE summary and the fix hint SHALL have control characters, direction overrides, zero-width characters, URLs, markdown links and HTML tags removed and whitespace collapsed, and SHALL be cut to 400 and 300 characters. Web SHALL show both as plain text with an "AI generated" label.
9. WITH `NODE_ENV=production` and Hunts on, THE settings SHALL require `HUNT_WORKDIR`, and an existing folder SHALL be owned by the current user with mode 0700. The temp-dir default SHALL apply only outside production.
10. THE recorded live fixtures SHALL hold no `agent_message_chunk` line, and `tools/sanitize-replay` SHALL drop agent messages unless `--keep-messages` is given.
