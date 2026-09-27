# R20: Five-minute local demo runbook

This runbook uses the current local implementation. The **five-minute clock is for the reviewer walkthrough**; do the one-time install, database migration, and Google OAuth setup first. A clean machine may take longer than five minutes to download Docker images, install npm packages, or finish first-time OAuth consent. Google login requires credentials supplied by the operator; none are included in `.env.example`.

## Prerequisites and one-time setup

- Windows PowerShell, Node.js 20 or newer, npm, and Docker Desktop (or Docker Engine with Compose).
- Work from the project root, for example `C:\Users\ashur\OneDrive\Desktop\assesment`.
- A Google OAuth client configured with redirect URI `http://localhost:4000/api/auth/google/callback`. Set its client ID and secret in `.env`. The app does not provide live Google credentials.
- Network access for provisioning and using Ethereal test SMTP accounts.

From the project root, start local PostgreSQL, Redis, and Elasticsearch:

```powershell
docker compose -f infra/compose.yaml up -d
docker compose -f infra/compose.yaml ps
```

The services bind to PostgreSQL `localhost:5432`, Redis `localhost:6379`, and Elasticsearch `localhost:9200`. Compose uses local development credentials. Do not expose these defaults beyond the local machine.

Create `.env` from `.env.example` if it does not exist. Do not overwrite an existing configured `.env`:

```powershell
Copy-Item .env.example .env
```

Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` to the OAuth client values. Keep the local callback URLs and origins unless you have changed the ports. Replace `SESSION_SECRET` with at least 32 random characters and set `ENCRYPTION_KEY_BASE64` to base64 encoding of exactly 32 random bytes. Generate candidate values with:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Put the first output in `SESSION_SECRET`, the second in `ENCRYPTION_KEY_BASE64`. `.env.example` already points `DATABASE_URL`, `REDIS_URL`, and `ELASTICSEARCH_URL` at the local Compose services. Slack client values are blank and Slack is not needed for the basic demo. To show the protected Bull Board, set `ADMIN_EMAILS` to the exact email address used to sign in.

Install dependencies and prepare the database:

```powershell
npm install
npm run db:generate
npm run db:migrate
```

## Start the application

Open four PowerShell terminals at the project root and run one command in each:

```powershell
npm run dev:api
```

```powershell
npm run dev:dispatcher
```

```powershell
npm run dev:worker
```

```powershell
npm run dev:web
```

Open `http://localhost:5173`. The API serves on port 4000. **The API, dispatcher, and worker are all required for actual scheduling and delivery; the web process is required for the dashboard demo.** PostgreSQL and Redis are required. Elasticsearch is used for search; if unavailable, the app has a PostgreSQL search fallback, but the Elasticsearch-backed search portion of this demo cannot be demonstrated. Slack and Bull Board are optional to the core demo.

## Reviewer walkthrough (about 3–4 minutes)

1. **Sign in (30–45 seconds):** use Google sign-in with the configured OAuth test account. Confirm the dashboard and profile appear.
2. **Choose a sender (30 seconds):** in Compose, select an existing sender or choose **New Ethereal sender**. Ethereal is a test mailbox; do not enter production credentials.
3. **Schedule one message (45 seconds):** enter a recipient address, a unique subject such as `R20 demo 14:32`, a short body, and a start time roughly 30 seconds ahead. Keep the hourly limit at its allowed default and submit.
4. **Show it queued/scheduled (20 seconds):** open Scheduled and confirm the recipient, subject, scheduled status, and time. The dispatcher publishes durable schedule records to BullMQ; the worker waits until due.
5. **Show delivery (30–60 seconds):** watch the worker terminal for `Worker activated email job` and `Email sent successfully`, then refresh the dashboard and confirm the message moves to Sent. The Ethereal account captures test mail; this UI does not display the Ethereal preview link.
6. **Show search (20 seconds):** search by the unique subject or recipient and confirm the sent email appears. With Elasticsearch healthy, this uses the Elasticsearch search path.
7. **Optional (30 seconds):** if signed in with an address listed in `ADMIN_EMAILS`, open `http://localhost:5173/admin/queues` to show Bull Board. To demonstrate cap deferral quickly, prepare the environment with a sender cap of 1 and multiple recipients before the walkthrough; do not wait for the next UTC hour during the demo. The actual rollover behavior is covered by automated tests.

The default sender cap is 200 emails/hour, so an hourly-cap event is not a useful live step with defaults. Slack notifications additionally require a real Slack installation and are not configured by this example environment.

## Reliability notes for the reviewer

- PostgreSQL is the source of truth for users, senders, batches, email status, and outbox events.
- BullMQ stores scheduled work in Redis. The dispatcher publishes pending outbox events and reconciles persisted schedules after restart.
- Stable email IDs are used as BullMQ job IDs; a database claim and idempotency constraints prevent duplicate processing of the same schedule.
- Redis performs atomic sender and batch hourly reservations across workers. If a cap is reached, the same job is delayed to the next UTC hour rather than dropped.
- Startup recovery handles stale `SENDING` records according to whether SMTP submission may have begun. Ambiguous SMTP outcomes are not automatically resent, avoiding accidental duplicate mail.
- Elasticsearch is a rebuildable projection. `INDEX_EMAIL` outbox events retry indexing failures, while search can fall back to PostgreSQL during an Elasticsearch outage. No Elasticsearch call is required to submit email through SMTP.
- These failure paths are exercised by automated tests; the reviewer does not need to stop services or trigger a live outage.

To rebuild Elasticsearch from PostgreSQL, build the API and invoke the compiled entry directly:

```powershell
npm run build --workspace @scheduler/api
node apps/api/dist/search/rebuild.js
```

This is the documented rebuild invocation. Do not use the `search:rebuild` workspace script as a substitute for this verified compiled command.

## Test and build commands

Run these from the project root. The API suite currently contains **35 tests**. Database-backed API tests need a migrated test database and `TEST_DATABASE_URL`; set it for the current PowerShell session:

```powershell
$env:TEST_DATABASE_URL="postgresql://scheduler:local-development-only@localhost:5432/scheduler_test?schema=public"
npm run test --workspace @scheduler/api
```

If preparing a fresh test database, create it in local PostgreSQL and apply migrations with `DATABASE_URL` temporarily pointed to that database before running the suite.

```powershell
npm run test --workspace @scheduler/web
npm run typecheck
npm run build
```

The frontend test command runs the current web Vitest suite. Root typecheck and build cover contracts, API, and web.

## Troubleshooting

- **Docker service is stopped:** run `docker compose -f infra/compose.yaml up -d`, then `docker compose -f infra/compose.yaml ps`.
- **PostgreSQL unavailable:** check that the Compose `postgres` service is healthy and port 5432 is free; confirm `DATABASE_URL` uses the local credentials and database.
- **Redis unavailable:** check the `redis` service and port 6379; `REDIS_URL` must include the configured local password.
- **Elasticsearch unavailable:** check the `elasticsearch` service and port 9200. The application can fall back to PostgreSQL search, but Elasticsearch search cannot be demonstrated until it responds.
- **Missing environment values:** verify `.env` exists at the repository root. Configure 32+ character `SESSION_SECRET`, a valid 32-byte base64 `ENCRYPTION_KEY_BASE64`, and Google client values for login.
- **`TEST_DATABASE_URL` missing or tests fail to connect:** set the PowerShell variable above and make sure `scheduler_test` exists and has migrations applied.
- **Port already in use:** stop the other process using 4000, 5173, 5432, 6379, or 9200, or update the service and application configuration consistently.

## Compact demo checklist

- [ ] PostgreSQL, Redis, and Elasticsearch are up; API, dispatcher, worker, and web are running.
- [ ] Sign in and open the dashboard.
- [ ] Select or create an Ethereal sender; schedule a near-future message.
- [ ] Confirm Scheduled status, then confirm Sent status after worker delivery.
- [ ] Search by the unique subject or recipient.
- [ ] Explain PostgreSQL/outbox, BullMQ/Redis, idempotency, rate caps, restart recovery, and Elasticsearch retry/fallback.
- [ ] Optional: show Bull Board or preconfigured cap deferral.
