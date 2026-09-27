import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { ScheduleEmailBatchInput } from '@scheduler/contracts';
import { config } from '../config.js';
import { prisma } from '../database.js';
import { AppError } from '../errors.js';

interface ScheduleResult {
  batchId: string;
  recipientCount: number;
  reused: boolean;
}

function uniqueRecipients(recipients: string[]) {
  const seen = new Set<string>();
  return recipients.flatMap((recipient) => {
    const key = recipient.trim().toLowerCase();
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ address: recipient.trim(), key }];
  });
}

function requestHash(input: ScheduleEmailBatchInput, recipients: Array<{ address: string; key: string }>) {
  const canonical = {
    senderId: input.senderId,
    subject: input.subject,
    body: input.body,
    startsAt: new Date(input.startsAt).toISOString(),
    delayBetweenEmailsMs: input.delayBetweenEmailsMs,
    hourlyLimit: input.hourlyLimit,
    recipients: recipients.map(({ key }) => key),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

async function findExistingBatch(ownerId: string, idempotencyKey: string, hash: string): Promise<ScheduleResult | null> {
  const existing = await prisma.emailBatch.findUnique({
    where: { ownerId_idempotencyKey: { ownerId, idempotencyKey } },
    select: { id: true, recipientCount: true, requestHash: true },
  });
  if (!existing) return null;
  if (existing.requestHash !== hash) {
    throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', 'This idempotency key was already used for different email content.');
  }
  return { batchId: existing.id, recipientCount: existing.recipientCount, reused: true };
}

export async function scheduleEmailBatch(
  ownerId: string,
  idempotencyKey: string,
  input: ScheduleEmailBatchInput,
): Promise<ScheduleResult> {
  const startsAt = new Date(input.startsAt);
  if (startsAt.getTime() <= Date.now()) {
    throw new AppError(400, 'START_TIME_IN_PAST', 'The start time must be in the future.');
  }
  if (input.hourlyLimit > config.MAX_EMAILS_PER_HOUR_PER_SENDER || input.hourlyLimit > config.MAX_EMAILS_PER_HOUR_PER_BATCH) {
    throw new AppError(400, 'HOURLY_LIMIT_TOO_HIGH', 'The requested hourly limit exceeds the configured maximum.');
  }

  const recipients = uniqueRecipients(input.recipients);
  const hash = requestHash(input, recipients);
  const existing = await findExistingBatch(ownerId, idempotencyKey, hash);
  if (existing) return existing;

  const sender = await prisma.emailSender.findFirst({
    where: { id: input.senderId, ownerId, enabled: true },
    select: { id: true },
  });
  if (!sender) {
    throw new AppError(404, 'SENDER_NOT_FOUND', 'An enabled sender was not found for this account.');
  }

  const delayBetweenMs = Math.max(input.delayBetweenEmailsMs, config.MIN_EMAIL_INTERVAL_MS);
  const batchId = randomUUID();
  const scheduled = recipients.map((recipient, sequence) => ({
    id: randomUUID(),
    batchId,
    sequence,
    recipient: recipient.address,
    recipientKey: recipient.key,
    scheduledAt: new Date(startsAt.getTime() + sequence * delayBetweenMs),
  }));

  try {
    return await prisma.$transaction(async (transaction) => {
      const raced = await transaction.emailBatch.findUnique({
        where: { ownerId_idempotencyKey: { ownerId, idempotencyKey } },
        select: { id: true, recipientCount: true, requestHash: true },
      });
      if (raced) {
        if (raced.requestHash !== hash) {
          throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', 'This idempotency key was already used for different email content.');
        }
        return { batchId: raced.id, recipientCount: raced.recipientCount, reused: true };
      }

      await transaction.emailBatch.create({
        data: {
          id: batchId,
          ownerId,
          senderId: sender.id,
          idempotencyKey,
          requestHash: hash,
          subject: input.subject,
          body: input.body,
          startsAt,
          delayBetweenMs,
          hourlyLimit: input.hourlyLimit,
          recipientCount: scheduled.length,
        },
      });

      await transaction.scheduledEmail.createMany({
        data: scheduled.map((email) => ({ ...email, status: 'SCHEDULED' })),
      });

      await transaction.outboxEvent.createMany({
        data: scheduled.flatMap((email) => [
          {
            id: randomUUID(),
            emailId: email.id,
            topic: 'SEND_EMAIL',
            idempotencyKey: `send-email:${email.id}`,
            payload: { emailId: email.id },
          },
          {
            id: randomUUID(),
            emailId: email.id,
            topic: 'INDEX_EMAIL',
            idempotencyKey: `index-email:${email.id}:created`,
            payload: { emailId: email.id },
          },
        ]),
      });

      return { batchId, recipientCount: scheduled.length, reused: false };
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const concurrent = await findExistingBatch(ownerId, idempotencyKey, hash);
      if (concurrent) return concurrent;
    }
    throw error;
  }
}
