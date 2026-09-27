import { OutboxStatus, OutboxTopic } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { prisma } from './database.js';
import { logger } from './logger.js';
import { redis } from './redis.js';
import { addEmailJob, emailQueue } from './queue/email-queue.js';
import { indexEmailById } from './search/emails.js';
import { reconcileScheduledEmails, recoverStaleSendingEmails } from './scheduling/recovery.js';

const claimSize = 50;
const staleRecoveryIntervalMs = 5000;
let stopping = false;

interface ClaimedOutboxEvent {
  id: string;
  topic: OutboxTopic;
  emailId: string | null;
  attempts: number;
  lockedBy: string;
}

interface ClaimedOutboxRow {
  id: string;
  topic: OutboxTopic;
  emailId: string | null;
  attempts: number;
}

async function claimEvents(): Promise<ClaimedOutboxEvent[]> {
  const lockedBy = randomUUID();
  return prisma.$transaction(async (transaction) => {
    const events = await transaction.$queryRaw<ClaimedOutboxRow[]>`
      SELECT id, topic, "emailId", "attempts"
      FROM outbox_events
      WHERE ("status" = 'PENDING' AND "availableAt" <= NOW())
        OR ("status" = 'LEASED' AND "lockedAt" < NOW() - INTERVAL '120 seconds')
      ORDER BY "createdAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${claimSize}
    `;

    for (const event of events) {
      await transaction.outboxEvent.update({
        where: { id: event.id },
        data: {
          status: OutboxStatus.LEASED,
          lockedAt: new Date(),
          lockedBy,
          attempts: { increment: 1 },
        },
      });
    }

    return events.map((event) => ({
      ...event,
      attempts: event.attempts + 1,
      lockedBy,
    }));
  });
}

async function publishEvent(event: ClaimedOutboxEvent) {
  if (!event.emailId) {
    throw new Error(`Unsupported outbox event ${event.id} (${event.topic}).`);
  }

  if (event.topic === OutboxTopic.INDEX_EMAIL) {
    await indexEmailById(event.emailId);
    await prisma.outboxEvent.updateMany({
      where: { id: event.id, lockedBy: event.lockedBy, status: OutboxStatus.LEASED },
      data: {
        status: OutboxStatus.PUBLISHED,
        publishedAt: new Date(),
        lockedAt: null,
        lockedBy: null,
        lastError: null,
      },
    });
    return;
  }

  if (event.topic !== OutboxTopic.SEND_EMAIL) {
    throw new Error(`Unsupported outbox event ${event.id} (${event.topic}).`);
  }

  const email = await prisma.scheduledEmail.findUnique({
    where: { id: event.emailId },
    select: { status: true, scheduledAt: true },
  });
  if (email?.status === 'SCHEDULED') {
    await addEmailJob(event.emailId, email.scheduledAt);
  }

  await prisma.outboxEvent.updateMany({
    where: { id: event.id, lockedBy: event.lockedBy, status: OutboxStatus.LEASED },
    data: {
      status: OutboxStatus.PUBLISHED,
      publishedAt: new Date(),
      lockedAt: null,
      lockedBy: null,
      lastError: null,
    },
  });
}

async function retryEvent(event: ClaimedOutboxEvent, error: unknown) {
  const waitMs = Math.min(300_000, 1000 * 2 ** Math.min(event.attempts, 8));
  const message = error instanceof Error ? error.message.slice(0, 500) : 'Unknown queue publication error';
  await prisma.outboxEvent.updateMany({
    where: { id: event.id, lockedBy: event.lockedBy, status: OutboxStatus.LEASED },
    data: {
      status: OutboxStatus.PENDING,
      availableAt: new Date(Date.now() + waitMs),
      lockedAt: null,
      lockedBy: null,
      lastError: message,
    },
  });
  logger.error({ outboxId: event.id, attempts: event.attempts, err: error }, 'Queue publication failed; retry scheduled');
}

async function dispatchPendingEvents() {
  const events = await claimEvents();
  for (const event of events) {
    try {
      await publishEvent(event);
    } catch (error) {
      await retryEvent(event, error);
    }
  }
  return events.length;
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function runDispatcher() {
  await reconcileScheduledEmails();
  await recoverStaleSendingEmails();
  logger.info('Outbox dispatcher started');
  let nextStaleRecoveryAt = Date.now() + staleRecoveryIntervalMs;
  while (!stopping) {
    try {
      const processed = await dispatchPendingEvents();
      if (Date.now() >= nextStaleRecoveryAt) {
        await recoverStaleSendingEmails();
        nextStaleRecoveryAt = Date.now() + staleRecoveryIntervalMs;
      }
      await wait(processed > 0 ? 20 : 1000);
    } catch (error) {
      logger.error({ err: error }, 'Outbox dispatch cycle failed');
      await wait(2000);
    }
  }
  await emailQueue.close();
  await prisma.$disconnect();
  await redis.quit();
}

process.once('SIGINT', () => { stopping = true; });
process.once('SIGTERM', () => { stopping = true; });

void runDispatcher().catch((error: unknown) => {
  logger.fatal({ err: error }, 'Outbox dispatcher stopped unexpectedly');
  process.exitCode = 1;
});
