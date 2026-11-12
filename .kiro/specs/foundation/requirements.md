# Requirements Document

## Introduction

`foundation` is the first product spec of Haunted Ops. It creates the workspace, the shared types package, the PostgreSQL schema, a NestJS API shell with a server-sent events (SSE) stream, a Vite + React web shell with an empty scene mount point and a table area, a security baseline and the local dev setup.

It does not poll Prometheus or compute the haunt score (`ingest-haunt-score`), draw the PixiJS scene (`scene-engine`), run hunts or the MCP server (`exorcist-agent`), open pull requests (`fix-proposal-flow`) or deploy (`deploy-demo`). It prepares the data models and event types those specs need.

It is a dependency of gate G1 (16 Nov 2026, "chaos changes the score in the table"), together with `haunted-lab` and `ingest-haunt-score`.

## Glossary

- **Workspace**: the pnpm monorepo at the repository root.
- **API**: the NestJS application in `apps/api`.
- **Web**: the Vite + React application in `apps/web`.
- **Shared**: the package `packages/shared` with types and plain validators used by API and Web.
- **Service**: one lab service shown as a room: `gate`, `orders`, `payments` or `ledger`.
- **Haunt level**: an integer from 0 (calm) to 4 (dark room) describing the state of a Service.
- **Signal**: one recorded measurement of a Service: `error_rate`, `p95_ms` or `up`.
- **Incident**: a period in which a Service is unhealthy.
- **Hunt**: one Exorcist investigation of an Incident.
- **Evidence**: one ordered step of a Hunt's evidence chain.
- **Proposal**: a fix proposed by a Hunt, tracked through its pull request.
- **Event bus**: the in-process publisher of domain events. There is no Redis.
- **Event**: a domain event with a numeric id, a name and a JSON payload.
- **Ring buffer**: the in-memory store of the last 500 Events used for resume.
- **Stream**: one open SSE connection from a client to `GET /api/events`.
- **Resync**: an SSE event telling a client to reload state because resume is not possible.
- **Boot id**: 12 random hex characters chosen once per API process. Event ids are `<bootId>-<n>`, so an id from an earlier process is never mistaken for one of the current process.
- **Client IP**: `req.ip` as computed by Express with `trust proxy` set to `TRUST_PROXY_HOPS`.
- **Table mode**: the accessible, text-based view of Service state in Web.
- **Test database**: the PostgreSQL database named by `TEST_DATABASE_URL`, separate from `DATABASE_URL`.

## Requirements

### Requirement 1: Workspace and root scripts

**User Story:** As a developer, I want one workspace with uniform scripts, so that I can check and build everything with single commands.

#### Acceptance Criteria

1. THE Workspace SHALL contain the pnpm packages `apps/api`, `apps/web` and `packages/shared`, each written in TypeScript strict mode and targeting Node 26.
2. WHEN `pnpm typecheck` runs at the root, THE Workspace SHALL type check every package and exit non-zero if any package has a type error.
3. WHEN `pnpm lint` runs at the root, THE Workspace SHALL lint every package and exit non-zero if any package has a lint error.
4. WHEN `pnpm test` runs at the root with no database configured, THE Workspace SHALL run every unit test and exit zero if they all pass.
5. WHEN `pnpm build` runs twice on identical sources and an identical lockfile, THE Workspace SHALL produce byte-identical build output, building Shared before the packages that depend on it.
6. THE Workspace SHALL use pnpm only, and every dependency in every `package.json` SHALL be pinned to an exact version.

### Requirement 2: Shared types and validators

**User Story:** As a developer, I want API and Web to share one definition of state and event payloads, so that they cannot drift apart.

#### Acceptance Criteria

1. THE Shared package SHALL export the types for Service state, Haunt level, Signal kind, SSE event names and SSE event payloads.
2. THE Shared package SHALL export plain validator functions, without a schema library, for Service state and for every SSE event payload.
3. IF a validator receives input of any shape, THEN THE validator SHALL return a result object with either the typed value or a list of error paths, and SHALL NOT throw.
4. THE API and THE Web SHALL import these types and validators from Shared and SHALL NOT redefine them.
5. THE Haunt level validator SHALL accept only integers from 0 to 4.

### Requirement 3: Database schema, migrations and seed

**User Story:** As a developer, I want a versioned PostgreSQL schema with a seed, so that every environment starts from the same state.

#### Acceptance Criteria

1. THE API SHALL define through Prisma the models `Service`, `Signal`, `Incident`, `Hunt`, `Evidence` and `Proposal` with the fields listed in the design, linked by foreign keys.
2. THE schema SHALL provide an index for reading the latest Signals per Service and a rule that allows at most one open Incident per Service.
3. WHEN `prisma migrate deploy` runs against an empty database, THE schema SHALL be created from the migrations committed in the repository.
4. WHEN the seed runs, THE API SHALL upsert exactly the four Services `gate`, `orders`, `payments` and `ledger` with fixed room positions, and running the seed again SHALL leave exactly four Services with unchanged positions.
5. IF an Incident is opened for a Service that already has an open Incident, THEN THE database SHALL reject the write.
6. THE Evidence model SHALL enforce a unique order number per Hunt.

### Requirement 4: Configuration

**User Story:** As an operator, I want the API to refuse to start with bad configuration, so that mistakes show up at startup and not at runtime.

#### Acceptance Criteria

1. WHEN the API starts, THE API SHALL validate `DATABASE_URL`, `PORT` and `WEB_ORIGIN` before it listens.
2. IF a required variable is missing or invalid, THEN THE API SHALL exit with a non-zero code and print a message that names every offending variable.
3. THE validation SHALL require `PORT` to be an integer from 1 to 65535, `WEB_ORIGIN` to be an origin made of scheme, host and optional port with no path, and `DATABASE_URL` to use the `postgres` or `postgresql` scheme.
4. THE API SHALL NOT print or log the value of any configuration variable, including in validation errors.
5. WHERE the optional variables `SSE_MAX_CLIENTS`, `SSE_MAX_CLIENTS_PER_IP` or `RATE_LIMIT_MAX` are set, THE API SHALL validate them as positive integers, and WHERE they are unset THE API SHALL use the defaults 100, 5 and 30.
6. WHERE `TRUST_PROXY_HOPS` is set, THE API SHALL validate it as an integer from 0 to 3, and WHERE it is unset THE API SHALL use 0; THE API SHALL never trust every proxy.
7. WHERE `HOST` is set, THE API SHALL validate it as an IP literal or a hostname and listen on it, and WHERE it is unset THE API SHALL listen on `127.0.0.1`.

### Requirement 5: Health and service state routes

**User Story:** As a client, I want to read the current service state over HTTP, so that I can render the house before any event arrives.

#### Acceptance Criteria

1. WHEN a client requests `GET /healthz` and the database answers, THE API SHALL respond 200 with `{ "status": "ok", "db": "up" }`.
2. IF the database does not answer within 2 seconds, THEN THE API SHALL respond 503 with `{ "status": "degraded", "db": "down" }`.
3. WHEN a client requests `GET /api/services`, THE API SHALL respond 200 with the array of Service state in the fixed room order.
4. THE response of `GET /api/services` SHALL pass the Shared Service state validator for every element.
5. IF a client requests an unknown route, THEN THE API SHALL respond 404 with a JSON error body that contains no stack trace.

### Requirement 6: SSE event stream

**User Story:** As a client, I want a live event stream that I can resume after a drop, so that the view stays correct on an unstable connection.

#### Acceptance Criteria

1. WHEN a client requests `GET /api/events`, THE API SHALL respond with content type `text/event-stream`, `Cache-Control: no-cache` and `X-Accel-Buffering: no`, and keep the connection open.
2. WHEN an Event is published, THE API SHALL assign it an integer sequence number greater than that of every earlier Event of the same boot and send it to every open Stream as `id` (`<bootId>-<n>`), `event` and `data` fields, with the payload as JSON.
3. WHILE a Stream is open, THE API SHALL send an event named `heartbeat` every 15 seconds, without an id, and SHALL NOT store heartbeats in the Ring buffer.
4. THE API SHALL keep the last 500 Events in the Ring buffer, dropping the oldest first.
5. WHEN a client connects with a `Last-Event-ID` header, or with a `lastEventId` query parameter when no header is present, and that id is within the Ring buffer range, THE API SHALL send first every Event with a greater id in order, and then live Events, with no Event skipped or repeated.
6. IF the supplied id is not of the form `<bootId>-<n>`, older than the oldest retained Event minus one, or greater than the latest id, THEN THE API SHALL send a `resync` event (reason `malformed`, `too_old` or `ahead`), replay nothing, and continue with live Events.
7. IF the number of open Streams equals `SSE_MAX_CLIENTS`, THEN THE API SHALL respond 503 with a `Retry-After` header to a new request.
8. WHEN a client disconnects, THE API SHALL remove its subscription and heartbeat timer.
9. WHEN the API receives a shutdown signal, THE API SHALL end every Stream and release the Event bus before the process exits.
10. IF the number of open Streams from one client IP equals `SSE_MAX_CLIENTS_PER_IP`, THEN THE API SHALL respond 503 with a `Retry-After` header to a new request from that IP, and THE API SHALL release the slot on every close path (client disconnect, backpressure, maximum age, shutdown).
11. IF the unsent output of a Stream exceeds 64 KiB, THEN THE API SHALL destroy that Stream and release its slot.
12. WHEN a Stream has been open for the maximum stream age (30 minutes by default), THE API SHALL end it cleanly.
13. THE API SHALL generate a random Boot id per process, SHALL send it first on every Stream in a `connected` event, and SHALL format every Event id as `<bootId>-<n>`.
14. IF the supplied resume id is well formed but carries a different Boot id, THEN THE API SHALL send a `resync` event with reason `restarted` and replay nothing.
15. THE API SHALL set the HTTP server `requestTimeout` and `headersTimeout` explicitly, and these timeouts SHALL NOT end an open Stream.

### Requirement 7: Security baseline

**User Story:** As an operator, I want safe defaults in place from the first commit, so that later specs inherit them.

#### Acceptance Criteria

1. THE API SHALL allow cross-origin requests only from the exact origin in `WEB_ORIGIN` and SHALL NOT send CORS allow headers for any other origin.
2. THE API SHALL send standard security headers on every response.
3. IF a request body is larger than 32 KiB, THEN THE API SHALL respond 413 without parsing the body.
4. THE API SHALL generate a request id for every request, return it in the `X-Request-Id` response header and include it in every log line for that request.
5. THE API SHALL write one structured JSON log line per request with timestamp, level, request id, method, path without query string, status and duration, and SHALL NOT log headers, request bodies, query strings or environment variables.
6. WHEN a log entry contains a field whose name suggests a secret, such as token, key, secret, password, authorization or cookie, THE logger SHALL replace its value with `[redacted]`.
7. THE API SHALL apply a global rate limit guard to requests with the methods POST, PUT, PATCH and DELETE, and WHEN the limit is exceeded THE API SHALL respond 429 with a `Retry-After` header; GET requests and Streams SHALL NOT count.
8. IF an unhandled error occurs, THEN THE API SHALL respond 500 with a generic JSON body and SHALL NOT include the stack trace or internal messages.
9. WHEN any logged string contains a PostgreSQL connection string or a URL with `user:password@` credentials, THE logger SHALL replace the connection string, or the credentials part of the URL, with `[redacted]`.
10. THE API SHALL derive the client IP used by the rate limit and the per-IP Stream cap from `req.ip`, honouring exactly `TRUST_PROXY_HOPS` proxies.

### Requirement 8: Web shell and SSE client

**User Story:** As a user, I want a page that shows whether it is live and lists the services, so that I can trust what I see.

#### Acceptance Criteria

1. THE Web SHALL render a header with the product name and the connection status, a scene mount area and a Table mode area.
2. THE scene mount area SHALL be an empty, labelled element without any PixiJS dependency.
3. WHEN the Web loads, THE Web SHALL open a Stream and show one of the statuses `live`, `reconnecting` or `offline`, where `live` means the Stream is open and an Event or heartbeat arrived in the last 45 seconds.
4. IF the Stream errors or closes, THEN THE Web SHALL show `reconnecting` and retry with exponential backoff from 1 second, doubling to a cap of 30 seconds, with jitter, and SHALL reset the delay after a successful open.
5. IF the browser reports no network, or 5 consecutive attempts fail, THEN THE Web SHALL show `offline` and keep retrying at the capped delay.
6. WHEN the Web connects or reconnects, or receives a `resync` event, THE Web SHALL load `GET /api/services` and replace its Service state with the response.
7. WHEN a reconnect happens, THE Web SHALL send the last received Event id as `lastEventId` so that the API can resume.
8. THE Table mode area SHALL list each Service with its name and Haunt level as text, and THE connection status SHALL be announced in a polite live region and SHALL NOT rely on color alone.
9. THE Web SHALL call only `GET /api/services` and `GET /api/events`, at a base URL taken from `VITE_API_BASE_URL`.
10. IF a `service.updated` event is applied while a `GET /api/services` snapshot is in flight, THEN THE Web SHALL merge the snapshot by `updatedAt` so that the snapshot never overwrites a newer event.
11. WHEN the Web receives a `resync` event, THE Web SHALL clear its stored Event id; WHEN it receives a `connected` event with a Boot id different from the previous one, THE Web SHALL clear its stored Event id and load `GET /api/services`.
12. IF a Stream request fails with a `Retry-After` header, THEN THE Web SHALL wait at least that long (capped at 5 minutes) before the next attempt.
13. THE Web SHALL keep the Service list ordered by room position, row (y) first, then column (x), also when a new Service appears.

### Requirement 9: Dev experience and test databases

**User Story:** As a developer, I want a documented local setup and safe database tests, so that I can run everything on my Mac.

#### Acceptance Criteria

1. THE repository SHALL contain `docs/DEV.md` that describes prerequisites (Node 26, pnpm, Homebrew `postgresql@17`), starting and stopping PostgreSQL, creating the dev and test databases, the environment variable names, migrate and seed, running API and Web, and running tests.
2. THE repository SHALL contain `.env.example` with variable names and placeholder values only.
3. THE unit tests SHALL NOT require a database.
4. WHEN `TEST_DATABASE_URL` is not set, THE integration tests SHALL be skipped and SHALL print a visible message saying so.
5. IF `TEST_DATABASE_URL` is equal to `DATABASE_URL`, THEN THE integration tests SHALL refuse to run.
6. WHEN an integration test run starts, THE test setup SHALL apply the migrations to the Test database and clear its tables.
