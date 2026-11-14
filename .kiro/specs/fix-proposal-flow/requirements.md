# Requirements Document

## Introduction

`fix-proposal-flow` is the sixth product spec of Haunted Ops, after `foundation`, `haunted-lab`, `ingest-haunt-score`, `scene-engine` and `exorcist-agent`. It continues a succeeded Hunt. A second headless agent, the fixer, writes a minimal fix for the culprit commit. If its patch fails the checks, or the agent fails, the proposal is a `git revert` of the culprit commit. The API pushes the fix to the lab repository as a branch, opens a pull request, and watches it. A human merges the pull request on GitHub. When it is merged, the API asks the lab to deploy the merged commit, and the house is clean again once the normal ingest closes the Incident.

The target is gate G-MVP on 25 Nov 2026: break, hunt, AI fix pull request on GitHub, a human merges it, the lab deploys it, the house is clean again, end to end on the Mac.

Decisions taken by the user and binding for this document:

- The fix is an AI patch with a revert fallback.
- Human approval is merging the pull request on GitHub. Nobody approves through the Haunted Ops API or UI, and the API never merges.

Out of scope: the lab side of the deploy (`fix-deploy`, a separate spec in the `haunted-lab` repo; here its contract is only called, and tests use a fake route), a public webhook for GitHub, EC2 isolation of the test run (`deploy-demo`), `propose_fix` as an MCP tool (it is not used: the server runs the fixer, not the Exorcist), replays and sound.

## Glossary

- **Workspace**, **API**, **Web**, **Shared**, **Service**, **Incident**, **Table mode**, **Scene**, **Room**, **SSE stream**, **Hunt**, **Hunt runner**, **Valid diagnosis**, **Diagnosis**, **Evidence handle**, **Credits**, **Kill switch**, **Untrusted data**, **Fake kiro-cli**, **Hunt working folder**: as defined in the earlier specs.
- **Lab repo**: the GitHub repository `Akar-Samudra-Artifisial/Haunted-Lab`, named by `LAB_GITHUB_REPO`. It holds `services/<service>/`, `packages/lab-common/` and the scenario branches.
- **Pinned branch**: `main` and every `scenario/*` branch of the Lab repo. Their SHAs are pinned in `scenario-shas.json` of the lab and never change.
- **Culprit commit** (C): the `culpritSha` of the Valid diagnosis of a succeeded Hunt.
- **Culprit Service** (S): the `culpritService` of that diagnosis, the Service whose code is fixed.
- **Deployed commit** (D): the commit that the lab runs for S when the proposal starts: the `sha` of the latest Deploy Record of S in the observability API.
- **Proposal**: the record of one fix for one succeeded Hunt, from `drafting` to `deployed`, `rejected` or `failed`.
- **Incident branch**: `incident/<huntId>`, created at D, the base of the pull request and the ref that the lab deploys.
- **Fix branch**: `exorcist/<huntId>`, D plus one fix commit, the head of the pull request.
- **Fix commit**: the one commit on the Fix branch.
- **Fixer**: the headless `kiro-cli` agent `exorcist-fixer` that edits files in the Fixer working folder.
- **Fixer working folder**: a folder outside every git repository, without `.git`, holding the export of `services/<S>/` and a read-only copy of `packages/lab-common/` at D.
- **Export**: the pristine copy of the Fixer working folder, kept next to it, against which the result is compared.
- **Patch**: the set of changed and new files of the Fixer working folder compared with the Export.
- **Patch kind**: `ai_patch` (the Fixer's patch) or `revert` (`git revert --no-edit C` on top of D).
- **Check**: one named test that a candidate must pass: `scope`, `size`, `forbidden_file`, `syntax`, `tests`, and for the merged result `merge_scope`.
- **Candidate**: a Patch (or a revert) applied to a fresh clone at D, before it is accepted.
- **Check run**: the run of the service's tests on a Candidate, under `node --permission`.
- **AI fail reason**: why the Patch was not used: `scope`, `size`, `forbidden_file`, `tests_failed`, `agent_failed`, `timeout`, `budget`, `daily_limit`.
- **Fail reason**: why a Proposal ended `checks_failed` or `failed`.
- **Fine-grained token**: the GitHub personal access token `GITHUB_TOKEN`, limited to the Lab repo with Contents and Pull requests read and write.
- **Chaos deploy contract**: the lab route `POST /chaos/deploy-fix` described in the design.
- **G-MVP**: the gate of 25 Nov 2026.

## Requirements

### Requirement 1: Settings and startup

**User Story:** As the operator of the demo, I want the fix flow off by default and impossible to start half configured, so that a missing token or a wrong repository never shows up in the middle of a demo.

#### Acceptance Criteria

1. THE settings SHALL read `FIX_ENABLED` (default `false`), `GITHUB_TOKEN`, `LAB_GITHUB_REPO`, `CHAOS_URL` (default `http://127.0.0.1:4100`, loopback unless `LAB_ALLOW_REMOTE`), `CHAOS_TOKEN`, `FIX_MODEL`, `FIX_CREDIT_CAP` (default 1.5), `FIX_TIMEOUT_MS` (default 120000), `FIX_MAX_TOOL_CALLS` (default 30), `FIX_TEST_TIMEOUT_MS` (default 90000), `FIX_POLL_MS` (default 30000), `FIX_BRANCH_TTL_DAYS` (default 7) and `FIX_WORKDIR`, each with the bounds of the design, and SHALL name an invalid variable and never its value.
2. WHEN `FIX_ENABLED=true`, THE settings SHALL require `HUNTS_ENABLED=true`, `GITHUB_TOKEN`, `LAB_GITHUB_REPO` in the form `owner/name`, `CHAOS_TOKEN`, a pinned `FIX_MODEL` (not `auto`), and `git` and the `kiro-cli` of `KIRO_CLI_PATH` as executable files.
3. THE settings SHALL accept a `GITHUB_TOKEN` only in the form of a fine-grained token (`github_pat_` and the allowed characters) and SHALL refuse a classic token (`ghp_`), an OAuth token and a placeholder.
4. WHEN `FIX_ENABLED=true`, THE API SHALL call `GET /repos/<repo>` once at startup, SHALL exit with a message that names `GITHUB_TOKEN` or `LAB_GITHUB_REPO` (never the value) when the answer is not 200 or the token cannot push, SHALL make sure the labels `exorcist`, `ai_patch` and `revert` exist, and SHALL log the days left before the token expires when GitHub reports them.
5. WHEN `FIX_ENABLED=false`, THE API SHALL start no fixer, make no call to GitHub, and answer `POST /api/hunts/:id/proposal` with 404.

### Requirement 2: Branch model in the Lab repo

**User Story:** As the owner of the lab, I want the scenario branches and `main` never to change, so that the pinned SHAs of the scenarios stay valid for every test and every replay.

#### Acceptance Criteria

1. FOR a succeeded Hunt with the Culprit Service S and the Deployed commit D, THE API SHALL create the Incident branch `incident/<huntId>` at D, and the Fix branch `exorcist/<huntId>` with exactly one Fix commit on top of D.
2. THE API SHALL open the pull request with head `exorcist/<huntId>` and base `incident/<huntId>`.
3. THE API SHALL build a branch name only from a `huntId` that matches the CUID pattern, and SHALL refuse to build one from anything else.
4. THE API SHALL never push to, create, force-push, rename or delete `main` or a `scenario/*` branch, and SHALL push only the two branch names of this requirement, without force.
5. IF the Incident branch or the Fix branch of this Hunt already exists on the remote, THEN THE API SHALL treat a branch at the commit it would push (D, or the Fix commit) as already pushed, SHALL delete and push again a branch at another commit that no open pull request uses (a leftover of a partial push), and SHALL end the attempt with the Fail reason `branch_exists`, leaving both branches as they are, when an open pull request uses one of them.
6. THE Fix commit SHALL have a fixed author and committer, a message made of the one-line summary and the Hunt id, and no hook or signing configuration involved.

### Requirement 3: The fixer agent and its process

**User Story:** As a security reviewer, I want the fixer to be able to read and write files in one folder and nothing else, so that a prompt injection in a diff cannot reach a shell, the network, a token or another folder.

#### Acceptance Criteria

1. THE agent `.kiro/agents/exorcist-fixer.json` SHALL be a headless `kiro-cli chat --no-interactive` agent whose only tools are `fs_read` and `fs_write`, both limited to its working folder, with no shell, no MCP server, no web tool and no `includeMcpJson`.
2. THE run SHALL enforce the allow-list three times: in the agent file, with `--trust-tools=fs_read,fs_write` on the command line, and by the API reading every `tool_call` of the stream.
3. THE API SHALL stop the Fixer at once as `agent_failed` when a tool call names any other tool, or when the `path` of an `fs_read` or `fs_write` input is not inside the Fixer working folder after resolution.
4. THE API SHALL judge a repeated call id again unless the later event names the same tool with a path inside the folder, as Requirement 25.1 of `exorcist-agent` does for Hunts.
5. THE Fixer process SHALL use a model pinned by `FIX_MODEL`, its own process group, an output cap, a note `<proposalId>.pid` that the startup reaper handles, and the limits `FIX_CREDIT_CAP`, `FIX_TIMEOUT_MS` and `FIX_MAX_TOOL_CALLS`. A limit that is reached SHALL end the run with the AI fail reason `agent_failed`, or `timeout` for the time limit.
6. THE Fixer process SHALL receive an environment that holds only the whitelisted names of the design, and SHALL NOT receive the GitHub token, a lab token, a database URL, a chaos token or any other name.
7. THE Fixer SHALL write no output that the API reads as a result: the API ignores the agent's text and reads only the Patch.

### Requirement 4: Fixer working folder and prompt

**User Story:** As the owner of the demo, I want the fixer to see only the code it may change and the facts it needs, so that it makes the smallest change and nothing else.

#### Acceptance Criteria

1. THE Fixer working folder SHALL be outside every git repository, SHALL hold no `.git` and no `.kiro/steering`, and SHALL hold only the files of `services/<S>/` and a read-only copy of `packages/lab-common/` at D.
2. THE API SHALL fill it from its own clone of the Lab repo with `git archive` at D, and SHALL NOT run any command inside the folder.
3. THE prompt SHALL be built from a fixed template and these validated data only: the sanitized summary and fix hint of the Valid diagnosis, the culprit deploy id and short SHA, the Service name, the file list of the folder, and the diff of C limited to `services/<S>/` and cut at 64 KiB.
4. THE API SHALL wrap every piece of lab or model text in the prompt as untrusted data, and the prompt SHALL tell the Fixer to make the smallest change that removes the cause while keeping the behaviour, to change only files under `services/<S>/src/`, and to write nothing else.
5. WHEN the Fixer ends, THE API SHALL delete the Fixer working folder and the Export, whatever the result.

### Requirement 5: Patch checks

**User Story:** As a reviewer, I want a patch that touches only the code of the culprit service, stays small, and passes the service's tests, so that I can read it in a minute and trust that it removes the cause.

#### Acceptance Criteria

1. THE API SHALL compute the Patch by comparing the Fixer working folder with the Export itself, SHALL open no file through a symlink, and SHALL treat a symlink, a special file, a binary file, a file that is not valid UTF-8 and a path that is not normalized as `forbidden_file`.
2. THE Check `scope` SHALL pass only when every changed or new file is under `services/<S>/src/`.
3. THE Check `forbidden_file` SHALL fail for a changed `package.json`, lockfile, script, configuration file or file outside `src/`, for a deleted file, for a change that deletes or skips tests, for a new file at the top level of the service, and for any file of `packages/lab-common/`.
4. THE Check `size` SHALL pass only when the Patch changes at most 60 lines (added plus deleted, counted by `git diff --numstat` in the clone) in at most 5 files.
5. THE API SHALL apply the Patch to a fresh clone at D by writing the file contents, SHALL run `node --check` on every changed `.js` and `.mjs` file as the Check `syntax`, and SHALL run the Check run as the Check `tests`.
6. A Patch SHALL be accepted if and only if every Check passes. The result of every Check SHALL be recorded as `{ name, ok }` in the order they ran, and a Patch with no change SHALL fail with the AI fail reason `scope`.
7. THE API SHALL record the files changed by C that the Patch also touches as the informational Check `touches_culprit_files`, which never fails a Patch.

### Requirement 6: The test run

**User Story:** As the owner of the Mac, I want the code the model wrote to run its tests with as little reach as the platform allows, and I want the design to say honestly how little that is.

#### Acceptance Criteria

1. THE Check run SHALL execute the tests of the service with a fixed command line: `node --permission` with read access to the clone and the Node installation, write access to one temporary folder inside the clone, no child process, no worker, no addon and no network where `--allow-net` is available, run as `node --test` over the test files of `services/<S>/`, from a fixed list of arguments and not from a package script.
2. THE Check run SHALL use an environment that holds only `PATH`, SHALL start in the clone, SHALL use its own process group, and SHALL stop with the AI fail reason `timeout` after `FIX_TEST_TIMEOUT_MS` (default 90 s), killing the whole group.
3. WHEN a service has no test file, THE Check `tests` SHALL fail with `tests_failed` unless `FIX_REQUIRE_TESTS=false`, and the result SHALL say that no test ran.
4. THE design SHALL state what isolation the Mac gets and what EC2 gets (separate OS user, no instance role, no IMDS, no network, done in `deploy-demo`), and SHALL NOT claim a boundary that the platform does not give.

### Requirement 7: The revert fallback

**User Story:** As the operator, I want a proposal even when the AI patch fails, because reverting the culprit commit is always a legitimate and reviewable fix.

#### Acceptance Criteria

1. WHEN the Patch is rejected, or the Fixer fails, is not allowed to start (Requirement 8) or the agent is not configured, THE API SHALL prepare a revert: `git revert --no-edit C` on top of D in a fresh clone.
2. THE revert SHALL be used only when C is a commit with one parent, is an ancestor of D, applies cleanly, and changes only files under `services/<S>/`; otherwise THE Proposal SHALL end with the Fail reason `revert_unavailable` or `revert_conflict`.
3. THE revert SHALL get the Checks `scope` (the whole of `services/<S>/`), `forbidden_file` (no binary, symlink or special file) and `tests`, and SHALL NOT be subject to `size`; the Proposal SHALL end `checks_failed` when the revert fails a Check.
4. THE Proposal SHALL record the AI fail reason of the rejected Patch together with the kind `revert`.

### Requirement 8: Credits and daily limits

**User Story:** As the owner of the Kiro budget, I want the fixer to cost what a Hunt costs, counted in the same day, so that the demo cannot spend more than the caps allow.

#### Acceptance Criteria

1. THE Fixer SHALL stop when the Credits of its run reach `FIX_CREDIT_CAP`, and a run that ends without a Credits report SHALL be recorded at `FIX_CREDIT_CAP` with the flag `creditsEstimated`, as for Hunts.
2. THE Credits of every Proposal SHALL count in the daily budget with the Credits of the Hunts, and a Fixer SHALL NOT start when the day's total plus `FIX_CREDIT_CAP` is over `HUNT_DAILY_CREDIT_CAP`; the Proposal SHALL then use the revert with the AI fail reason `budget`.
3. A Fixer run SHALL count as one start against `HUNT_DAILY_MAX`, and a Fixer SHALL NOT start when the day's starts have reached it; the Proposal SHALL then use the revert with the AI fail reason `daily_limit`.
4. THE Kill switch SHALL stop a running Fixer and SHALL prevent a new Proposal from starting; a Proposal that is already `open` SHALL keep being watched.

### Requirement 9: Git and GitHub calls and the token

**User Story:** As a security reviewer, I want the GitHub token to live in one place and to reach only GitHub, so that no log, argument, file, agent or pull request text can ever carry it.

#### Acceptance Criteria

1. THE API SHALL run every git command with `execFile` and an argument array, with `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_TERMINAL_PROMPT=0`, `core.hooksPath=/dev/null` and no shell.
2. THE API SHALL give the token to `git push` and `git fetch` only through `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_0` and `GIT_CONFIG_VALUE_0` (an `http.extraHeader` for `https://github.com/` only) in the environment of that one process, and SHALL NOT put it in a URL, an argument, a file, the remote configuration or the environment of any other process.
3. THE API SHALL send REST calls only to `https://api.github.com`, with `redirect: 'error'`, a timeout, a cap on the size of the body it reads, and the headers of the design.
4. WHEN GitHub answers 403 or 429 with a rate limit, THE API SHALL wait for `retry-after` or the reset time (bounded) and retry a bounded number of times, and a conditional request that answers 304 SHALL cost no retry.
5. THE token SHALL never appear in argv, in a log line, in an error message, in an SSE event, in an HTTP answer, in the Fixer or test environment, in a fixture, or in the text of a pull request.
6. THE API SHALL give the user-visible error only a fixed code (for example `github_unauthorized`, `github_rate_limited`, `github_unavailable`, `push_rejected`), never a message of git or GitHub.

### Requirement 10: Pull request text

**User Story:** As a human who merges a pull request, I want to see why, what and how it was checked, in plain text that cannot ping people, load images or send me to another site.

#### Acceptance Criteria

1. THE title SHALL be `Exorcist: ` followed by a one-line summary of the fix, at most 72 characters in all.
2. THE body SHALL be rendered from a fixed template and SHALL contain: the Hunt link `WEB_ORIGIN/hunts/<huntId>`, the culprit deploy and SHA, the evidence list with its handles, the Patch kind, each Check with its result, the credits spent, and the sentence "AI generated, review before merging".
3. EVERY piece of model or lab text in the title and body SHALL be sanitized: control, direction and zero-width characters removed, HTML, images and markdown links removed, every `@` followed by a zero-width space so that it names nobody, `#` before digits broken so that it links nothing, whitespace collapsed, and a length cap per field and for the whole body.
4. THE body SHALL contain links only to `https://github.com/<repo>/` and to `WEB_ORIGIN`.
5. THE pull request SHALL get the labels `exorcist` and the Patch kind, SHALL NOT request reviewers and SHALL NOT enable auto-merge.

### Requirement 11: Watching the pull request

**User Story:** As the operator, I want the API to notice the merge by itself and to refuse to deploy anything that is not what it proposed.

#### Acceptance Criteria

1. THE API SHALL poll every `open` Proposal every `FIX_POLL_MS` (30 s) with `GET /repos/<repo>/pulls/<n>` and a conditional request (`If-None-Match`), and SHALL NOT need a public webhook.
2. WHEN the pull request is closed without a merge, THE Proposal SHALL become `rejected`.
3. WHEN the pull request is merged, THE API SHALL read the merge commit M, the head SHA of the pull request and the login of the merger (null when GitHub names no one), and the Proposal SHALL become `merged` only when the head SHA equals the `headSha` that the API pushed.
4. IF the head SHA differs from the pushed `headSha`, THEN THE Proposal SHALL become `failed` with the Fail reason `head_changed` and nothing SHALL be deployed.
5. WHEN the API restarts, THE API SHALL resume the watch of every `open` Proposal, SHALL treat a `drafting` Proposal as `failed` with `api_restart`, and SHALL continue a `merged` Proposal to its deploy.

### Requirement 12: Deploying the merged fix

**User Story:** As the operator, I want the lab to run the merged commit and only a commit that the human merged, so that the house is clean again by a change somebody reviewed.

#### Acceptance Criteria

1. WHEN a Proposal is `merged`, THE API SHALL fetch `incident/<huntId>`, SHALL check that its head equals M, and SHALL check the Check `merge_scope` (the diff from D to M touches only files under `services/<S>/` and is not larger than the pushed Patch for `ai_patch`), and SHALL check that the tree of M equals the tree of the pushed head (`merge_content`), before it calls the lab. A Deploy Record of M by `exorcist` that already exists SHALL NOT be deployed again.
2. THE API SHALL call the Chaos deploy contract `POST /chaos/deploy-fix` with the bearer `CHAOS_TOKEN` and the body `{ service, ref, sha }`, with `ref` equal to `incident/<huntId>` and `sha` equal to M, and SHALL send the token only to `CHAOS_URL`.
3. THE Proposal SHALL become `deployed` only after the lab answers success and the observability API lists a Deploy Record of S with `sha` equal to M and `actor` equal to `exorcist`.
4. IF the lab refuses the deploy, or the checks of 12.1 fail, or the record does not appear within `FIX_DEPLOY_CONFIRM_MS` of the merge (the Proposal stays `merged` and is looked at again on every poll until then), THEN THE Proposal SHALL become `failed` with a fixed Fail reason (`ref_moved`, `merge_scope`, `merge_content`, `deploy_rejected`, `deploy_unavailable`, `deploy_unconfirmed`), and a transient error SHALL be retried a bounded number of times first.
5. THE API SHALL NOT close the Incident, and the Proposal SHALL NOT change an Incident: after `deployed`, the normal ingest closes the Incident once the signals recover.

### Requirement 13: The Proposal model

**User Story:** As a developer, I want one proposal per succeeded Hunt with a status that only moves forward, so that the table, the scene and the gate all read the same truth.

#### Acceptance Criteria

1. THE Proposal SHALL store `kind`, `status`, `failReason`, `aiFailReason`, `prNumber`, `prUrl`, `branch`, `baseBranch`, `headSha`, `mergeSha`, `mergedBy`, `checks`, `credits`, `creditsEstimated`, `attempt` and its timestamps, and SHALL NOT store `approvedBy`.
2. THE status SHALL be one of `drafting`, `checks_failed`, `open`, `merged`, `deployed`, `rejected`, `failed`, and SHALL move only along these edges: `drafting` to `open`, `checks_failed` or `failed`; `open` to `merged`, `rejected` or `failed`; `merged` to `deployed` or `failed`; the other statuses are final.
3. THE database SHALL refuse a status that skips an edge to a final state it has no right to, a `prUrl` that is not on `github.com`, an `open` Proposal without `prNumber`, `headSha` and `branch`, and a `deployed` Proposal without `mergeSha`.
4. THE API SHALL create one Proposal per succeeded Hunt automatically when `FIX_ENABLED=true`; at most one Proposal of a Hunt SHALL be active (`drafting`, `open` or `merged`) at a time.
5. THE migration SHALL map the old values: `draft` to `drafting`, `open` to `open`, `approved` to `open`, `merged` to `merged`, `rejected` to `rejected`, and SHALL drop `approvedBy`.

### Requirement 14: Routes and events

**User Story:** As a client of the API, I want to read a proposal, watch it change live, and retry a failed one as an operator.

#### Acceptance Criteria

1. `GET /api/proposals/:id` SHALL be public, SHALL answer the Proposal view without any token, local path or raw model text, and SHALL answer 404 for an unknown or malformed id.
2. `POST /api/hunts/:id/proposal` SHALL need `Authorization: Bearer $HUNT_ADMIN_TOKEN`, SHALL answer 202 when it starts a new attempt for a succeeded Hunt whose last Proposal is `failed` or `checks_failed` (or that has none), and SHALL answer 409 when a Proposal is active, when the last one is `rejected` (a person closed it) or `deployed`, or when the Hunt did not succeed; 503 while the Kill switch is off; and 404 when `FIX_ENABLED=false`.
3. THE API SHALL publish the SSE events `proposal.started`, `proposal.checks`, `proposal.opened`, `proposal.merged`, `proposal.deployed`, `proposal.rejected` and `proposal.failed`, each with a payload that has a validator in Shared, and in an order that follows the status graph.
4. `GET /api/services` and `GET /api/hunts/:id` SHALL carry the latest Proposal summary of the Hunt (or `null`), and the web reducer SHALL apply the events to it.
5. THE routes and events SHALL stay under the existing rate limit, SSE limits and error filter.

### Requirement 15: Branch cleanup

**User Story:** As the owner of the lab repo, I want old proposal branches to disappear without any risk to `main`, the scenarios or an open pull request.

#### Acceptance Criteria

1. A cleanup job SHALL run at start and every hour, and SHALL delete a branch only when its name matches `incident/<cuid>` or `exorcist/<cuid>` exactly, it is older than `FIX_BRANCH_TTL_DAYS` (7 days), and it is the head or base of no open pull request.
2. THE job SHALL delete the branches of a closed or merged pull request at once when the Proposal is final and 7 days old, and SHALL never touch `main`, a `scenario/*` branch, a branch of another name, or a branch of a Proposal that is not final.
3. THE job SHALL delete through the REST API one branch at a time, SHALL log only counts, and SHALL survive an error on one branch.

### Requirement 16: Table mode

**User Story:** As a user of Table mode, I want to see the proposal under the hunt with everything the scene shows.

#### Acceptance Criteria

1. THE Table SHALL show a proposal row under the Hunt of a Service: kind, status, the Checks with their result, a link to the pull request that opens `github.com` (with `rel="noopener noreferrer"`), and "merged by @login" when merged.
2. THE live region SHALL announce a Proposal change in one short sentence (opened, merged, deployed, rejected, failed), once per change, and the section SHALL be reachable by keyboard with visible focus.

### Requirement 17: Scene

**User Story:** As a viewer of the demo, I want to see the Exorcist write the fix, see it pinned on the door while it waits, and see the room cleansed when it is deployed.

#### Acceptance Criteria

1. WHILE a Proposal is `drafting`, THE Scene SHALL show the Exorcist writing a glowing scroll in the Room of the Hunt; WHILE it is `open`, the scroll SHALL be pinned on the door of the Room.
2. WHEN a Proposal becomes `deployed`, THE Scene SHALL sweep a cleansing light through the Room, and the Room SHALL return to calm when the Incident closes through the normal state; WHEN it becomes `rejected`, `failed` or `checks_failed`, the scroll SHALL fade.
3. WITH `prefers-reduced-motion`, THE Scene SHALL show static states for the same phases, and the Scene label and the Table cell SHALL be made by the same helper so that they never differ.

### Requirement 18: Gate G-MVP

**User Story:** As the team, I want one script that proves the whole loop and waits for a human, so that the gate is honest.

#### Acceptance Criteria

1. THE script `scripts/gmvp-fix.mjs` SHALL apply a scenario through the chaos API, wait for the Hunt to succeed, and wait for the Proposal to be `open`.
2. THE script SHALL print the pull request URL and wait up to 15 minutes for a human to merge it, SHALL NEVER merge, close or edit the pull request itself, and SHALL fail the gate when the time ends.
3. THE script SHALL then wait for the Proposal to be `deployed` and for the Incident to close, print a table (scenario, kind, checks, pull request, merged by, credits, durations, result), and reset the lab, also on failure and on Ctrl-C.
4. THE pure parts of the script SHALL be unit tested with `node:test`, and the script SHALL send the chaos token only to the chaos URL and never print any token.

### Requirement 19: Documents and steering

**User Story:** As a new developer, I want to set up the token and run the gate from the documents alone.

#### Acceptance Criteria

1. `docs/DEV.md` SHALL describe the fine-grained token setup (one repository, Contents and Pull requests read and write, nothing else), `FIX_ENABLED` and the caps, what runs where, the isolation limits of the test run on the Mac, and how to run the gate.
2. `.kiro/steering/security.md` SHALL carry the GitHub token rules and the fixer boundaries, and `.kiro/steering/structure.md` SHALL list the new folders.
3. `docs/KIRO_USAGE.md` SHALL get one line per finished task.
