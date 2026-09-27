import { OutboxStatus, OutboxTopic } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { prisma } from '../database.js';
import { logger } from '../logger.js';
import { addEmailJobToQueue, emailQueue, type EmailQueue } from '../queue/email-queue.js';

const reconcilePageSize = 500;
const enqueueGroupSize = 25;
const staleRecoveryPageSize = 100;

export async function reconcileScheduledEmails(queue: EmailQueue = emailQueue) {
  let cursor: string | undefined;
  let restored = 0;

  for (;;) {
    const emails = await prisma.scheduledEmail.findMany({
      where: { status: 'SCHEDULED' },
      orderBy: { id: 'asc' },
      take: reconcilePageSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, scheduledAt: true },
    });
    if (emails.length === 0) break;

    for (let index = 0; index < emails.length; index += enqueueGroupSize) {
      const group = emails.slice(index, index + enqueueGroupSize);
      await Promise.all(group.map((email) => addEmailJobToQueue(queue, email.id, email.scheduledAt)));
      restored += group.length;
    }
    cursor = emails.at(-1)?.id;
    if (emails.length < reconcilePageSize) break;
  }

  logger.info({ restored }, 'Scheduled-email queue reconciliation completed');
  return restored;
}

export async function recoverStaleSendingEmails(
  queue: EmailQueue = emailQueue,
  now = new Date(),
) {
  const staleBefore = new Date(now.getTime() - config.STALE_SENDING_RECOVERY_SECONDS * 1000);
  const candidates = await prisma.scheduledEmail.findMany({
    where: { status: 'SENDING', startedAt: { lt: staleBefore } },
    orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
    take: staleRecoveryPageSize,
    select: {
      id: true,
      attempts: true,
      scheduledAt: true,
      startedAt: true,
      smtpSubmissionStartedAt: true,
    },
  });

  let rescheduled = 0;
  let markedUnconfirmed = 0;

  for (const email of candidates) {
    if (!email.startedAt) continue;

    const job = await queue.getJob(`email-${email.id}`);
    if (job && await job.getState() === 'active') continue;

    const canRetry = email.smtpSubmissionStartedAt === null;
    const recovered = await prisma.$transaction(async (transaction) => {
      const update = await transaction.scheduledEmail.updateMany({
        where: {
          id: email.id,
          status: 'SENDING',
          attempts: email.attempts,
          startedAt: email.startedAt,
          smtpSubmissionStartedAt: canRetry ? null : { not: null },
        },
        data: canRetry
          ? {
              status: 'SCHEDULED',
              startedAt: null,
              failureCode: null,
              failureMessage: null,
            }
          : {
              status: 'FAILED',
              failureCode: 'SMTP_OUTCOME_UNCONFIRMED',
              failureMessage: 'The worker stopped after SMTP submission began. Delivery may have succeeded, so this email was not retried to avoid a duplicate.',
            },
      });
      if (update.count === 0) return false;

      const recoveryKey = `${email.id}:${email.attempts}`;
      await transaction.outboxEvent.createMany({
        data: [
          {
            id: randomUUID(),
            emailId: email.id,
            topic: OutboxTopic.INDEX_EMAIL,
            idempotencyKey: `index-email:${email.id}:recovery:${recoveryKey}`,
            payload: { emailId: email.id },
          },
          ...(canRetry ? [{
            id: randomUUID(),
            emailId: email.id,
            topic: OutboxTopic.SEND_EMAIL,
            idempotencyKey: `send-email-recovery:${recoveryKey}`,
            payload: { emailId: email.id },
          }] : []),
        ],
      });
      return true;
    });

    if (!recovered) continue;
    if (canRetry) {
      rescheduled += 1;
      await addEmailJobToQueue(queue, email.id, email.scheduledAt);
    } else {
      markedUnconfirmed += 1;
    }
  }

  if (rescheduled || markedUnconfirmed) {
    logger.warn({ rescheduled, markedUnconfirmed }, 'Stale email worker claims recovered');
  }
  return { rescheduled, markedUnconfirmed };
}