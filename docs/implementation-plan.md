# Email Scheduler Assignment Plan

This document is the working requirements checklist and architecture baseline. `Required` means stated by the assignment; `Decision` means an implementation choice; `External` means completion needs account access or credentials outside the repository.

## Progress

- Requirements and architecture baseline: recorded.
- The repository uses npm workspaces; dependencies are installed. Local Docker Compose PostgreSQL, Redis, and Elasticsearch services were started and verified available.
- Prisma client generation and database migrations completed against local PostgreSQL.
- Real Elasticsearch verification completed against the local Docker service, including index creation/mapping, indexing, search, idempotency, rebuild, and count comparison.
- The database-backed API suite passed: 35 tests with `TEST_DATABASE_URL` configured. API typecheck and production build also passed.
- R13 Slack OAuth/notification behavior and R15-R18 profile, dashboard, compose/parser, and frontend build paths are implemented and automated checks pass. Live Google and Slack OAuth still require operator-provided credentials; those live integrations have not been verified.
- R23 remains blocked because no usable Figma reference, screenshot, or export is available. R21 external repository/submission steps are not completed.

## Requirements Traceability

| ID | Requirement | Planned implementation | Verification |
|---|---|---|---|
| R01 | TypeScript + Express API | `apps/api`, strict TypeScript, Express routers and services | API typecheck and Supertest |
| R02 | PostgreSQL or MySQL persistence | PostgreSQL + Prisma schema/migrations | Migration and integration tests |
| R03 | BullMQ backed by Redis; no cron | BullMQ delayed jobs and Redis; event-loop outbox dispatcher only | Search dependency/config; restart integration test |
| R04 | Persist schedules through restart | PostgreSQL records + transactional outbox + Redis persistence + startup reconciliation | Stop/restart test with a future job |
| R05 | Idempotency and no duplicate queue sends | Required idempotency key, DB unique constraints, deterministic BullMQ IDs, conditional DB claim | Duplicate API and concurrent worker tests |
| R06 | Ethereal SMTP and multiple senders | Real Ethereal test account provisioning; encrypted sender credentials; sender selection | Provision/send smoke test; preview URL |
| R07 | Searchable scheduled/sent email records | Elasticsearch index keyed by email ID; SQL remains canonical | Index/search integration tests |
| R08 | Live BullMQ dashboard | Bull Board mounted on protected admin route | Authenticated dashboard smoke test |
| R09 | Configurable worker concurrency | `WORKER_CONCURRENCY` environment setting | Worker configuration test |
| R10 | Minimum delay between sends | Redis atomic per-sender slot reservation; compose delay and configured floor | Concurrent reservation tests |
| R11 | Configurable hourly cap safe across workers | Redis atomic sender/window counters; batch cap bounded by configured sender maximum | Multi-client Lua script tests |
| R12 | Cap delays jobs, does not drop them | Move active BullMQ job to the next UTC hour while retaining its stable ID | Saturation test checks eventual send |
| R13 | Slack OAuth and real notification on cap | OAuth installation with incoming-webhook, encrypted storage, one notification per sender/window | Automated session-state/replay, AES-GCM, mocked webhook success/failure/retry/concurrency, and worker-rescheduling tests; live Slack credentials remain external |
| R14 | Google OAuth login | Google OAuth authorization-code flow; server-side Redis session | OAuth callback/session tests and live login |
| R15 | User profile and logout | `/auth/me`, secure cookie session, profile image with initial fallback, logout errors surfaced | API auth tests; frontend typecheck and production build |
| R16 | Dashboard tabs and schedule/send lists | Scheduled/sent views, successful-send-only result, search, refresh, cursor pagination, and distinct loading/empty/error states | API regression test for sent-only; full API suite and frontend production build |
| R17 | Compose subject/body/file/start/delay/hourly cap | RFC-style CSV/text parsing, header handling, file limits, duplicate/invalid/rejected counts, validated schedule request | Parser tests and server-side API validation tests |
| R18 | React/Next + modern CSS + TypeScript | React, Vite, TypeScript, responsive CSS and focused frontend parser tests | Full TypeScript checks, frontend tests, and production build |
| R19 | Run instructions and env documentation | Root README plus `.env.example`; Compose and process commands | Follow clean-start instructions |
| R20 | Demo <= 5 minutes | `docs/demo-runbook.md` separates one-time local setup from a timed sign-in, schedule, delivery, and search walkthrough; optional admin/cap steps are identified | Manual reviewer checklist; setup and process commands cross-checked against Compose and workspace scripts |
| R21 | Private GitHub repo and named access | External submission action | Requires user's GitHub authorization; not representable as source code |
| R22 | State assumptions, shortcuts, trade-offs | README architecture and limitations section | Documentation review |
| R23 | Figma fidelity | Inspect reference and implement matching layout | Figma returns 401/403 in this environment; requires supplied screenshot/export to verify |

## Architecture

The npm-workspaces TypeScript monorepo has three runtime concerns: the Express API, a queue/outbox dispatcher, and BullMQ workers. PostgreSQL is the source of truth for users, senders, batches, email state, and pending queue publications. Redis holds BullMQ state, sessions, and atomic sender pacing/rate reservations. Elasticsearch is a rebuildable search projection, never the source of truth. The React dashboard consumes the API through same-origin requests.

A schedule request validates and persists a batch, individual email rows, and outbox rows in one PostgreSQL transaction. The dispatcher claims outbox rows with leases, publishes delayed jobs using stable email IDs as BullMQ job IDs, then acknowledges those rows. Failed publication is retried with backoff; startup reconciliation checks scheduled rows against queue publication state. The worker checks and claims the DB row, atomically reserves a sender slot and hourly capacity in Redis, and either delays the BullMQ job or submits it through Nodemailer to Ethereal. DB state transitions and search indexing are explicit service operations.

SMTP does not offer an idempotency transaction shared with PostgreSQL. If a worker loses its connection after SMTP may have accepted a message but before success is persisted, automatic resend could duplicate mail. The implementation will favor at-most-once submission: stale in-flight sends become failed with an `outcome unconfirmed` reason and are not automatically resent. This boundary is documented and tested; exactly-once delivery cannot honestly be guaranteed over ordinary SMTP.

## Folder Structure

```text
apps/
  api/src/                 Express application, auth, email/sender APIs, services, queue, workers, integrations
  web/src/                 React app, dashboard features, shared UI, API client
packages/
  contracts/src/            Shared Zod schemas and API types
prisma/                     PostgreSQL schema and migrations
infra/                      Docker Compose and local service configuration
docs/                       This plan, operational runbook, and demo steps
tests/                      Cross-process and infrastructure integration tests
```

Files will be added only as an implementation phase needs them; this is a target boundary map, not a requirement to create empty directories or placeholder modules.

## Data Model

- `User`: Google subject (unique), display name, email, avatar, timestamps.
- `EmailSender`: owning user, Ethereal address, encrypted SMTP credentials, enabled state, timestamps.
- `EmailBatch`: owner, sender, idempotency key, subject/body, start time, inter-email delay, requested hourly limit, recipient count, creation time; unique `(user_id, idempotency_key)`.
- `Email`: batch, recipient, stable sequence, scheduled time, status (`scheduled`, `sending`, `sent`, `failed`), attempt metadata, sent time, safe failure code/message, unique batch-recipient identity.
- `QueueOutbox`: email/job ID, event type, lease/attempt metadata, publication timestamp; unique event identity.
- `SlackInstallation`: user, encrypted incoming-webhook URL, installation state/timestamps. Secrets are never returned by API.

Google sessions live in Redis. Elasticsearch documents mirror searchable email fields and use the email primary key as document ID. Redis owns expiring hourly counters, pacing slots, and notification-dedupe keys.

## API Design

- `GET /api/auth/google`, `GET /api/auth/google/callback`, `GET /api/auth/me`, `POST /api/auth/logout`
- `GET /api/senders`, `POST /api/senders/ethereal`, `DELETE /api/senders/:id`
- `POST /api/email-batches` (requires `Idempotency-Key`; subject, body, recipient list, sender, start time, delay, requested cap)
- `GET /api/emails?status=scheduled|sent|failed&cursor=...`
- `GET /api/search?q=...&status=...`
- `GET /api/auth/slack`, `GET /api/auth/slack/callback`, `DELETE /api/auth/slack`
- `GET /admin/queues` protected by authenticated admin allow-list

Ownership is checked for every user-owned record; request/response schemas are shared from `packages/contracts`. Email listing is paginated. CSV parsing happens in the browser for immediate feedback and is repeated/validated by the backend before persistence.

## Queue, Worker, and Rate-Limit Design

BullMQ delayed jobs represent planned send times. A stable job ID is derived from the persisted email ID. Worker concurrency comes from `WORKER_CONCURRENCY`. A Redis Lua operation atomically reserves the next sender send slot and increments global-per-sender and batch-per-sender UTC-hour counters; it returns either an allowed reservation or a delay until the next eligible window. The effective spacing is at least the environment-configured minimum and respects the batch setting. When capacity is exhausted the worker moves the same active BullMQ job to the next hour rather than failing or deleting it. A Redis `SET NX` notification marker ensures only one Slack alert for a sender/hour cap event.

The compose cap cannot exceed `MAX_EMAILS_PER_HOUR_PER_SENDER`; both values are environment/config controlled. Redis persistence is enabled in local Docker configuration. PostgreSQL remains the recovery source if Redis needs queue reconstruction. For 1,000 simultaneous schedules, each recipient has a durable row and delayed job; concurrency bounds active SMTP work, and Redis reservations spread work over time. Ordering is preserved by batch sequence where possible, but independent batches for one sender may interleave fairly under concurrency.

## Authentication and External Integrations

Google OAuth is a real authorization-code flow; Google client ID/secret and the exact callback URL must be configured by the operator. Sessions use Redis storage and HTTP-only, same-site cookies; production cookies require HTTPS. Slack uses OAuth with the `incoming-webhook` scope so the user selects a destination channel; installation state is validated and the webhook is encrypted at rest. Disconnect removes the stored installation, and a missing integration is a no-op. Ethereal accounts are provisioned through Ethereal's test-account API via Nodemailer and their credentials are encrypted using an environment-provided 32-byte key. No credential or webhook is committed or returned to the browser.

## Frontend Structure

The React app contains auth/session state, a dashboard shell, scheduled/sent table views, a compose dialog, sender selection/provisioning, Slack connect/disconnect controls, shared form/table/feedback components, and a typed API client. The CSV/text parser handles headers, delimiters, duplicate addresses, and malformed rows, then displays accepted/rejected counts. All asynchronous screens provide loading, empty, error, and success feedback. The visual direction will be implemented from the assignment's dashboard requirements; exact Figma matching cannot be confirmed until its inaccessible frame is shared in a viewable form.

## Infrastructure and Configuration

Docker Compose provides PostgreSQL, Redis with append-only persistence, and Elasticsearch. API, dispatcher, and worker are distinct package scripts so they can be independently restarted or scaled. The web dev server proxies `/api` to Express. Configuration is parsed and validated once at process startup. Secrets are required through environment variables and excluded from Git. Elasticsearch and Slack failures do not make SQL-backed email history unavailable.

Expected configuration includes database/Redis/Elasticsearch URLs; session secret; Google OAuth ID/secret/callback; encryption key; Ethereal account provisioning settings; worker concurrency; minimum send interval; maximum sender and batch hourly caps; Slack OAuth ID/secret/callback; API/web origins; and admin email allow-list.

## Development Phases

1. Record this requirements baseline; create workspace scripts, TypeScript conventions, and Docker services.
2. Add PostgreSQL schema, migrations, validated configuration, and health checks.
3. Add Google login/session handling, ownership middleware, Ethereal sender provisioning, and sender UI/API.
4. Add schedule validation, transactional email/batch/outbox writes, outbox dispatcher, and idempotent delayed jobs.
5. Add worker state transitions, Redis atomic pacing/hourly reservations, job rescheduling, and live Slack OAuth notifications.
6. Add Elasticsearch indexing/search and protected Bull Board.
7. Build the responsive React dashboard, compose/parser, scheduled and sent views, Slack controls.
8. Add integration tests, complete README/runbook, run the restart and rate-limit demo checklist.

Each phase will be implemented and validated before expanding to the next. The checklist above will be updated as requirements become implemented and verified.

## Testing Strategy

- Unit: schema validation, recipient parsing, idempotency rules, scheduling timestamps, SMTP error classification, and Redis Lua decision logic.
- API: authenticated ownership, duplicate idempotency keys, sender provisioning behavior, pagination, and Slack-not-connected behavior.
- Redis/Postgres integration: outbox lease recovery, queue job deduplication, concurrent sender reservations from multiple clients, spacing, hourly cap deferral, and eventual delivery after rollover.
- Restart: create a future schedule, stop API/worker, restart with Redis/Postgres retained, verify one send and preserved scheduled time.
- Search: indexing, stable document IDs, query/filter behavior, and recovery after Elasticsearch outage.
- Frontend: parser, compose validation, loading/empty/error/success views, profile/logout, and schedule/list API flows.
- Live manual checks: Google OAuth, real Ethereal delivery/preview, Slack OAuth notification, protected Bull Board, and browser responsiveness.

## Demo Strategy

The timed local walkthrough is documented in `docs/demo-runbook.md`: sign in, choose or provision an Ethereal sender, schedule a near-future email, show Scheduled then Sent, and search by recipient or subject. First-time dependency installation, service startup, and OAuth configuration happen before the timed walkthrough. Restart recovery and hourly-cap rollover are explained and covered by automated tests rather than requiring a reviewer to reproduce failures during the short demo. Live Google or Slack credentials are external configuration and are not supplied by the repository.

## Failure Cases, Assumptions, and Trade-offs

- A down Redis delays publication; durable outbox rows retry rather than dropping schedules.
- A lost Redis queue can be reconstructed from scheduled PostgreSQL records; preserve DB and Redis volumes for normal restart behavior.
- An SMTP rejection is recorded as failed. An ambiguous in-flight outcome is not retried automatically to avoid duplicates; operator review is safer than a false exactly-once claim.
- Slack not installed means notification is skipped; Slack API failure is logged/retried without stopping email work.
- Elasticsearch failure leaves SQL history available and the index is rebuildable.
- All scheduling timestamps use UTC; counters use UTC-hour windows.
- The dashboard's per-batch cap is bounded by the configured per-sender maximum. Multiple batches share the sender-wide counter.
- At-most-once SMTP submission is chosen over automatic retry after uncertain acceptance; ordinary SMTP cannot atomically coordinate delivery with the relational transaction.
- The Figma frame could not be read (Figma returned 401/403), so visual matching remains an explicit verification gap.
- Creating a private GitHub repository, granting access to `Mitrajit` and `Yadav036`, and recording/uploading a demo require the user's GitHub/account access. They will be documented, not falsely reported as completed.
- Originality comes from a purpose-built domain model, explicit transactional outbox and rate-reservation behavior, and project-specific tests. No tutorial repository or copied implementation will be used. Any supplied visual assets will be credited as appropriate.
