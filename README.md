# ReachInbox Email Scheduler

A TypeScript monorepo implementing a Google-authenticated email scheduler with PostgreSQL persistence, Redis-backed BullMQ queues, and a Vite dashboard.

## Stack

- API: Express + TypeScript
- Database: PostgreSQL + Prisma
- Queue: BullMQ + Redis
- Search: Elasticsearch
- Frontend: React + Vite + TypeScript
- Auth: Google OAuth + session cookies

## Prerequisites

- Node.js 20+
- npm
- Docker Desktop or Docker Engine

## Local setup

1. Install dependencies:
   npm install
2. Start infrastructure:
   docker compose -f infra/compose.yaml up -d
3. Copy environment defaults:
   copy .env.example .env
4. Update the values in `.env` before first use, especially:
   - `SESSION_SECRET`
   - `ENCRYPTION_KEY_BASE64`
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
5. Generate Prisma client and apply migrations:
   npm run db:generate
   npm run db:migrate

Google sign-in requires an OAuth client configured for the callback URL in `.env`; the repository does not include live Google credentials. Slack OAuth credentials are **optional** for the core application and demo. Set `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET` only if you want to connect Slack cap notifications. Leaving them blank does not prevent email scheduling or delivery.

## Run the app

Terminal 1:
  npm run dev --workspace @scheduler/api

Terminal 2:
  npm run dev --workspace @scheduler/web

Required for scheduled delivery (run each in its own terminal):
  npm run dev:dispatcher
  npm run dev:worker

Under-five-minute reviewer demo: see [docs/demo-runbook.md](docs/demo-runbook.md).

Rebuild the Elasticsearch email search index from PostgreSQL (compiled command):
  npm run build --workspace @scheduler/api
  node apps/api/dist/search/rebuild.js

## Core routes

- `GET /api/health`
- `GET /api/auth/google`
- `GET /api/auth/google/callback`
- `GET /api/auth/me`
- `POST /api/auth/logout`
- `GET /api/senders`
- `POST /api/senders/ethereal`
- `DELETE /api/senders/:id`
- `POST /api/email-batches`
- `GET /api/emails`
- `GET /api/search`
- `GET /admin/queues`

## Notes

- Redis is used for BullMQ jobs, session storage, and rate-limiting counters.
- Slack cap notifications are deduplicated per sender and UTC hour, retried up to three times with bounded backoff, and never block email rescheduling. Slack webhook URLs are encrypted at rest and excluded from API responses and logs.
- PostgreSQL remains the source of truth for scheduled records and outbox events.
- The dispatcher restores scheduled rows and recovers stale worker claims. A crash before SMTP submission can be retried; a crash after submission begins is marked outcome-unconfirmed and is not resent automatically, because SMTP acceptance cannot be committed atomically with PostgreSQL.
- Elasticsearch is a searchable projection. Search falls back to PostgreSQL during Elasticsearch outages; the outbox retries failed incremental indexing, and the rebuild command recreates the index from all PostgreSQL email states.
- SMTP delivery uses Ethereal test accounts by default; production credentials should be supplied via the configured secret flow.

## Build and validation

npm run typecheck
npm run build

## Verification status

- The database-backed API suite passed: 35 tests with `TEST_DATABASE_URL` configured.
- Elasticsearch connection, index mapping/creation, real indexing and search, idempotency, and rebuild were verified against the local Docker Elasticsearch service.
- Live Google and Slack OAuth still require operator-provided credentials and were not verified as live integrations.
- R23 design fidelity remains blocked: no usable Figma reference, screenshot, or export is available in the repository.
