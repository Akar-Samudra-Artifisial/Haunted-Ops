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
3. THE API SHALL stop the Fixer at once as `agent_failed` when a tool call names any other tool, or when the `path` of an `fs_read` or `fs_write` input is not inside the Fixer working folder after resolution. The titles `Read File` (`fs_read`), `Replace in File` and `Write File` (`fs_write`) of kiro-cli 3.3.0, pinned from recordings, SHALL be accepted with their recorded input shapes, and every other title SHALL be foreign.
4. THE API SHALL judge a repeated call id again unless the later event names the same tool with a path inside the folder, as Requirement 25.1 of `exorcist-agent` does for Hunts. The batch read shape of kiro-cli 3.3.0 (Requirement 25) and its edit shape (Requirement 26) SHALL be accepted under the same rules.
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

### Requirement 20: Findings of the first live run

**User Story:** As the operator, I want the test check to work on the real lab and a failed fixer run to say why, so that the next live run either passes or can be diagnosed.

#### Acceptance Criteria

1. WHEN a service's `package.json` has a `test` script that starts with `vitest`, THE Check run SHALL run that service's tests with the lab's own vitest from a dependency tree the API installs in `FIX_WORKDIR/deps/<lockfile hash>/` (`pnpm install --frozen-lockfile --ignore-scripts`, a fixed environment with no token, a timeout), reused while the lockfile is unchanged, linked into the candidate clone for the run only and never visible to the Fixer.
2. THE vitest run SHALL keep `node --permission`: reads limited to the clone, the tree and the `node` binary, writes limited to the clone's temporary folder, no `--allow-net`, no WASI; the test workers SHALL be forked children with their own `--permission` set and no child process, worker or addon grant; the vitest main process MAY have `--allow-child-process` and `--allow-addons`, and the design SHALL say that this is not a security boundary on the Mac.
3. AT startup and WHEN the lab `main` head or its lockfile changes, THE API SHALL run every test file of every vitest service at `main`, one file at a time, in the same sandbox; the files that pass SHALL form the sandbox-green set of the service, and the others SHALL be left out with the reason `needs_network`, `timeout` or `failed`.
4. THE `tests` Check of a candidate SHALL run only the sandbox-green set of its service; an empty set SHALL be recorded as a skipped `tests` Check (Requirement 21.5); the pull request body SHALL list the files that ran and the ones left out with their reason in fixed words; the Check entry SHALL stay `{ name: 'tests', ok }`, and the counts SHALL go to the log.
5. A failing test run SHALL write one log line with the runner, a fixed code, the counts, the first 2 KiB of stderr and the first failure message, with absolute paths removed, and SHALL NOT put them in the pull request or a public answer.
6. EVERY Fixer run SHALL keep its reduced stream in `FIX_WORKDIR/streams/<proposalId>.fixer.stream.jsonl` (mode 0600, removed after 7 days); WHEN a run is not used, THE API SHALL log `fixerHalt: { code, detail }` and store `<code>: <detail>` (at most 300 characters) in the internal column `Proposal.aiFailDetail`, which no public answer returns.
7. WITH `FIX_ENABLED=true`, THE API SHALL check the chaos token at startup with an authenticated route of the lab that changes nothing, and SHALL refuse to start with `CHAOS_TOKEN rejected by the lab` on a 401 or 403.
8. THE script `db:drift` SHALL compare the migrations with the Prisma schema through a shadow database taken from `TEST_DATABASE_URL`, and SHALL exit 0 when they match.

### Requirement 21: Recorded fixer shapes and an empty sandbox-green set

**User Story:** As the operator, I want the guard to let the real fixer work and an empty test set to be said out loud, so that the next live run neither stops on a known tool nor passes a patch silently untested.

#### Acceptance Criteria

1. THE guard SHALL map `Read File` to `fs_read` and `Replace in File` and `Write File` to `fs_write`, accept their recorded input shapes (`offset` and `limit` may be null), check the key `path` of each against the working folder, and stop an `fs_write` whose path is not under `services/<service>/src/` with the code `write_outside_scope`.
2. THE stop detail SHALL name the title, the event `kind` and the sorted key names of the input, and no value.
3. THE three recordings SHALL be kept sanitized as test fixtures and replay with no stop; a mutated copy (a foreign title, a path out of the folder, a write out of the service sources, an id reused by another title) SHALL stop.
4. A test file that fails at `main` SHALL be recorded with its first error line (cleaned, at most 200 characters) in the `test baseline` log.
5. WHEN a vitest service has no sandbox-green test file, THE `tests` Check SHALL be `{ name: 'tests', ok: true, skipped: true, detail: 'no sandbox-green tests for <service>' }`, the checks before it SHALL still gate the patch, the pull request body SHALL say near the top "No automated tests ran in the sandbox for this service. Review the diff carefully.", and the table SHALL show "tests skipped".

### Requirement 22: The agent copy after kiro-cli migrated it

**User Story:** As the operator, I want a good AI patch to be kept when kiro-cli rewrites the agent copy in its usual way, and refused when the copy was changed in any other way, so that the check neither throws away real fixes nor lets a widened agent through.

#### Acceptance Criteria

1. AFTER a Fixer run, THE API SHALL accept the agent copy when it equals the committed agent except that `tools` and `allowedTools` name the same two file tools in either spelling (`fs_read`/`read`, `fs_write`/`write`), `permissions.rules` holds only `allow` rules for `fs_read`, `fs_write` or `skill`, and `kiroUpgrade` is added; any other difference, and a copy that does not parse, SHALL end the run as `agent_failed`.
2. WHEN the copy is refused, THE API SHALL record `agent_changed` with the first differing key in `fixerHalt.detail`, and no value.
3. THE stream guard and the work folder SHALL stay the fence: a write outside `services/<service>/src/` and a read outside the work folder SHALL stop the run whatever the agent copy allows, and the design SHALL say why the widened rules of the migrated copy are acceptable.
4. `.kiro/agents/exorcist-fixer.json` SHALL stay committed in its unmigrated form.

### Requirement 23: The agent backup of the kiro-cli migration

**User Story:** As the operator, I want a correct AI patch to survive the backup file kiro-cli writes next to the agent copy, so that a good fix is not replaced by a revert for a file the fixer never wrote.

#### Acceptance Criteria

1. THE patch reader SHALL leave out `.kiro/agents/exorcist-fixer.json.bak` only when it is a regular file with one link whose bytes equal the exported agent file, SHALL never apply or push it, and SHALL keep every other `.bak` and every other new file under `.kiro/` unreadable.
2. AN unreadable entry SHALL fail the `forbidden_file` Check, not `scope`, and a patch SHALL still be accepted only when every Check passes.

### Requirement 24: Second review fixes

**User Story:** As a security reviewer, I want the fixer run to fail closed on what it cannot read, the checks to say what they really checked, and a merged fix to survive a passing outage, so that nothing unchecked is proposed and nothing reviewed is lost.

#### Acceptance Criteria

1. ONE malformed line of the Fixer stream (not JSON, or longer than the 1 MiB line cap) SHALL stop the run at once with the halt code `stream_malformed`; the Hunt runner's tolerance SHALL stay as it is.
2. A file-tool call whose arguments were never judged (no input, or only empty inputs) SHALL stop the run when an update reports any status other than `pending`, with the halt code `unjudged_input`.
3. THE `syntax` Check SHALL check TypeScript files (strip-only type removal, then `node --check`, in sandboxed children) as well as JavaScript; a file kind no checker knows SHALL make the check `skipped`, never `ok`; WHEN `syntax` and `tests` are both `skipped`, THE AI patch SHALL be refused with the AI fail reason `unchecked`.
4. AFTER the merge, ONLY `ref_moved`, `merge_scope`, `merge_content`, `head_changed` and `deploy_rejected` SHALL end a `merged` Proposal at once; any other error SHALL keep it `merged` and be retried on the next tick until `FIX_DEPLOY_CONFIRM_MS` from the merge, then end it `failed` / `deploy_unconfirmed`.
5. THE time the deploy was asked SHALL be stored with the Proposal (`deployAskedAt`), and after a restart THE API SHALL look for the Deploy Record before it asks again, and SHALL NOT ask again for a Proposal whose deploy was already asked.
6. THE export folder SHALL be read-only once filled; the agent folders and copy SHALL be left out of the patch only in their expected kind (folder, single-link file), and the copy SHALL be read without following a link.
7. THE sandbox-green set SHALL be made at the commit the candidate starts from, per service and commit; a candidate test file the set never saw SHALL be listed as not run, with the reason `not_at_base`.
8. THE Fixer SHALL get its own `HOME` (`FIX_WORKDIR/home`, mode 0700) holding only links to the kiro-cli data folder, and the lab install SHALL get a temporary empty `HOME` with the pnpm store named explicitly.

### Requirement 25: The batch read shape of kiro-cli 3.3.0

**User Story:** As the operator, I want the guard to let the real fixer read the way kiro-cli 3.3.0 reads, and still refuse anything it cannot judge, so that the live run is not halted on a known read and no read reaches outside the work folder.

#### Acceptance Criteria

1. THE guard SHALL identify a file tool first by `_meta.kiro.toolName` when the event has it: `read` is `fs_read`, `write` is `fs_write`, any other value (or a value that is not text) SHALL stop the run as `foreign_tool`. A title is the second source: the three recorded titles and the pattern `Reading <text>` on a `tool_call` of kind `read`. A title and a `toolName` that name different tools SHALL stop the run as `foreign_tool`.
2. FOR `fs_read` THE guard SHALL accept `{ path, offset?, limit? }` and `{ operations, summary? }` with 1 to 8 entries, each `{ mode, path, ... }` with `mode` one of `Line`, `Directory` or `Search`, every `path` inside the work folder by the rule of Requirement 3.3. THE mode `Image`, `image_paths`, an unknown or missing mode, an unknown key at either level, an empty list and more than 8 entries SHALL stop the run as `unknown_args`.
3. THE write shapes SHALL stay as they were, and a later event of a call id SHALL pass only when it names the same tool, by its title or by its `toolName`.
4. THE recorded event SHALL be kept sanitized as a test fixture (`read-operations.stream.jsonl`, with its `toolName`) and replay with no stop; a mutated copy (a path outside, `..`, an absolute path, `Image`, 9 entries, an unknown key, `toolName` `shell`, a title that disagrees with the `toolName`) SHALL stop.

### Requirement 26: The dynamic edit shape of kiro-cli 3.3.0

**User Story:** As the operator, I want the guard to let the real fixer write the way kiro-cli 3.3.0 writes, and still refuse any command or key it does not know, so that the live run is not halted on a known edit and no write reaches outside the service sources.

#### Acceptance Criteria

1. THE guard SHALL accept the title pattern `Editing <text>` (one line, no control character) on a `tool_call` of kind `edit` as `fs_write`, with `_meta.kiro.toolName` `write` first when the event has it. A title and a `toolName` that name different tools SHALL stop the run as `foreign_tool`.
2. FOR a call announced with that title THE guard SHALL accept only `{ command: "strReplace", path, oldStr, newStr, replace_all? }`, with `path` inside the work folder by the rule of Requirement 3.3, `oldStr` and `newStr` text within the size cap of one patch file, and no other key. A missing `command`, any other `command` value, an unknown key and a value of another type SHALL stop the run as `unknown_args`.
3. THE shapes of Requirement 3.3 and 25 SHALL stay as they were. A repeated call id SHALL keep its tool, and an update with `title: null` SHALL follow it.
4. THE recorded event and its update SHALL be kept sanitized as a test fixture (`edit-command.stream.jsonl`) and replay with no stop, and a fake `kiro-cli` that replays this shape SHALL produce an `ai_patch` Proposal; a mutated copy (another `command`, no `command`, a path outside, `..`, an absolute path, `oldStr` not text, an unknown key, `toolName` `shell`, the title `Editing x` with `toolName` `read`, a repeated id naming another tool) SHALL stop.
5. THE agent copy check and the `.bak` rule SHALL keep passing for the migrated agent (tools `read` and `write`) during a run that uses the `Reading` and `Editing` shapes.

### Requirement 27: Permission changes never follow links

**User Story:** As the operator, I want the fixer's own `HOME` to be rebuilt without ever touching what its links point at, so that a run cannot change the mode of my real kiro-cli folder.

#### Acceptance Criteria

1. THE functions that walk a folder to change modes (`makeReadOnly`, `makeWritable`) SHALL change only real files and folders found with `lstat`, SHALL skip every symlink (never `chmod` it, never follow it), and SHALL refuse (throw) when the folder they were given is itself a link.
2. `prepareHome` SHALL remove the old home by unlinking its links first and then removing the rest, and SHALL call `chmod` on no path under `home` other than `home` itself.
3. THE removal of a Proposal's folders and every other caller SHALL keep working.
4. THE runner SHALL NOT fall back to the real `HOME` under tests: a runner built without `parentEnv` SHALL throw when it prepares the fixer's home, and every test that builds a runner SHALL pass a `parentEnv` whose `HOME` is a temporary folder.
5. A guard test SHALL run the fix flow twice in one `FIX_WORKDIR` with a temporary parent home that holds `Library/Application Support/kiro-cli` (mode 0700, with a 0600 file), and afterwards both modes SHALL be unchanged and the file readable.
6. A property test SHALL cover random trees with links to targets outside them (Property 19).

### Requirement 28: One hardening pass before the live test

**User Story:** As the operator, I want every gap that a full audit of the live path found closed in one pass, so that the next live run is not another discovery run.

#### Acceptance Criteria

1. THE opt-in live test SHALL build its app through one exported helper (`apps/api/test-live/live-app.ts`) that always sets the runner's `parentEnv` to `HOME` and `LANG` of the environment and nothing else, runs the startup check and `ProposalRunner.start()` as `main.ts` does, and is used by the live test and by the parity test of 28.9. THE guard of the runner (a run under Vitest with no `parentEnv` throws) SHALL stay for every other test.
2. A setup error before the fixer process is spawned SHALL be recorded as `fixer_not_started: <class and message>` and SHALL NOT count in the day's starts (`agentStarted` is set after the spawn, and cleared when `kiro-cli` could not be executed); an error after the spawn SHALL be recorded as `step_error: <class and message>`. The text SHALL be one line of at most 200 characters, with an absolute path as `[path]` and token-like text as `[redacted]`. An unsafe export (`FixerWorkdirError` `export_unsafe`) SHALL end the Proposal `failed` / `export_unsafe`.
3. THE view `GET /api/proposals/:id` SHALL carry `aiFailReason` and `aiFailDetail`; `aiFailDetail` SHALL be null or one line of 1 to 300 characters with no absolute path and no token-like text, and the shared validator SHALL refuse anything else.
4. WHEN `_meta.kiro.toolName` is present THE guard SHALL take the tool from it alone (`read` is `fs_read`, `write` is `fs_write`; any other value, or a value that is not text, SHALL stop the run as `foreign_tool`), and the title SHALL only have to be one line of at most 200 characters with no control character; the kind SHALL not matter. WITHOUT `toolName` the recorded titles and the title patterns of Requirements 3.3, 25 and 26 SHALL stay as they are.
5. A `tool_call_update` of an accepted call id SHALL keep that id's tool whatever its title or `_meta` say (a missing `_meta`, `title: null` or a new one-line title is fine); the input it carries SHALL be judged again by the same rules, a `tool_id` that names another tool SHALL stop the run, and an update of an unknown id SHALL be refused as before. A repeated `tool_call` SHALL still name the same tool.
6. FOR `write` THE guard SHALL accept exactly `{ command: "create", path, content }`, `{ command: "strReplace", path, oldStr, newStr, replaceAll? }` and `{ command: "insert", path, content, insertLine? }` (`insertLine` a whole number from 0; `replace_all` stays accepted as the recorded spelling), each with an optional text `summary`, and the older snake_case family (`create`, `str_replace`, `append`, `insert` with `file_text`, `old_str`, `new_str`, `insert_line`); a call that carries `toolName` or an `Editing` title SHALL have a `command`. Every `path` SHALL be inside the work folder and under `services/<S>/src/` (a new file included), texts SHALL be within the size cap of one patch file, and any other command, a missing required key, a value of another type and an unknown key SHALL stop the run as `unknown_args`.
7. FOR `read` THE guard SHALL accept 1 to 8 operations `{ mode: "Line", path, offset?, limit? }` and `{ mode: "Directory", path, depth?, exclude_patterns? }` (`depth` a whole number from 0 to 5, at most 20 patterns of at most 100 characters), and the older `Search` operation. THE mode `Image` SHALL be refused with the reason `image_read`. THE stop detail SHALL name the refused tool name, command or key (cleaned, never a value).
8. SANITIZED fixtures SHALL cover `create`, `insert` with and without `insertLine`, `strReplace` with `replaceAll`, `Directory` with `depth`, `Image`, an update with a changed title and an update with no `_meta`, listed in `scripts/fixer-stream-shapes.mjs` as schema-derived, not recorded; every accepted shape SHALL pass and every refusal of 6 and 7 SHALL have a test.
9. A PARITY test SHALL build the app with the helper of 28.1 against a fake GitHub, a fake lab and a fake `kiro-cli` that replays, one run each, every fixture that edits `refunds.ts`, and each run SHALL end `ai_patch` with the checks passing (a fixture refused by design SHALL end `revert` with its reason and detail in the view); the mode of the parent `kiro-cli` folder SHALL be unchanged afterwards.
10. THE live test SHALL wait for the lab dependency tree and the test baseline before it starts the clock of the proposal, SHALL give the proposal its fixer timeout plus 60 seconds, SHALL print one line per status change, and on a failed expectation SHALL print first the status, kind, reasons, detail and checks of the proposal and the last 40 matching log lines, and at its start the `kiro-cli` version and the stream file name.
11. A PRE-FLIGHT script SHALL check, without calling the model and with one `OK` or `FAIL` line each, the `kiro-cli` version (3.3.0), `whoami`, the mode of the `kiro-cli` folder, the names of the environment variables the live test needs (never their values), the lab, Prometheus, the Test database and the read access of the token to the lab repository (only the HTTP status is printed), and SHALL exit 0 only when all pass.

### Requirement 29: The `Running: ` title and the purpose key

**User Story:** As the operator of the demo server, I want the fixer guard to read the calls that kiro-cli 3.3.0 sends with an API key login, which start the title with `Running: ` and add the model text `__tool_use_purpose` to the input, without letting anything else in.

#### Acceptance Criteria

1. THE guard SHALL remove exactly the key `__tool_use_purpose` from the input of a call and of an update before it judges them (any other unknown key SHALL still stop the run as `unknown_args`), and SHALL never print its text in a stop detail, log or recording. WITH `_meta.kiro.toolName` present, a title that starts with `Running: ` SHALL pass like any other one-line title. A call or an update that carries `_meta.kiro.mcpServerName` SHALL stop the run as `foreign_tool`, because `fs_read` and `fs_write` are built in and name no MCP server; a `toolName` other than `read` or `write` SHALL stop it as before. THE fake fixer SHALL have a fixture in this form that ends `finished` with its edit applied, and a fixture with a server name that stops; THE fixer stream sanitizer SHALL drop the key and keep `mcpServerName` only when it is `exorcist`.
