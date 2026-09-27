import { randomUUID } from 'node:crypto';
import { OutboxTopic } from '@prisma/client';
import { Worker, type Job } from 'bullmq';
import { createTransport, getTestMessageUrl } from 'nodemailer';
import { config } from './config.js';
import { prisma } from './database.js';
import { logger } from './logger.js';
import { redis } from './redis.js';
import { emailQueueName, type EmailJobData } from './queue/email-queue.js';
import { decryptSecret } from './security/secrets.js';
import { delayActiveJob } from './queue/delay-active-job.js';
import { notifySenderCap } from './slack/notifications.js';

const hourWindowMs = 60 * 60 * 1000;
const reserveRateSlotScript = `
local now = tonumber(ARGV[1])
local interval = tonumber(ARGV[2])
local senderLimit = tonumber(ARGV[3])
local batchLimit = tonumber(ARGV[4])
local hourEnd = tonumber(ARGV[5])
local hourMs = 3600000
local senderCount = tonumber(redis.call('GET', KEYS[1]) or '0')
local batchCount = tonumber(redis.call('GET', KEYS[2]) or '0')

if senderCount >= senderLimit or batchCount >= batchLimit then
  return {0, hourEnd}
end

local nextSendAt = tonumber(redis.call('GET', KEYS[3]) or tostring(now))
local reservationAt = math.max(now, nextSendAt)
if reservationAt >= hourEnd then
  return {2, hourEnd}
end

redis.call('INCR', KEYS[1])
redis.call('INCR', KEYS[2])
redis.call('PEXPIREAT', KEYS[1], hourEnd + hourMs)
redis.call('PEXPIREAT', KEYS[2], hourEnd + hourMs)
local nextReservation = reservationAt + interval
redis.call('SET', KEYS[3], nextReservation, 'PX', math.max(hourMs, nextReservation - now + hourMs))
return {1, reservationAt}
`;
const acquireSenderStartScript = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local lockTtl = redis.call('PTTL', KEYS[1])
if lockTtl >= 0 then
  return {0, math.max(1, lockTtl)}
end

local lastStart = tonumber(redis.call('GET', KEYS[2]) or '0')
local retryAfter = lastStart + tonumber(ARGV[2]) - now
if retryAfter > 0 then
  return {0, retryAfter}
end

redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[3])
return {1, 0}
`;
const releaseSenderStartScript = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return 0
end

local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
redis.call('SET', KEYS[2], now, 'PX', ARGV[2])
redis.call('DEL', KEYS[1])
return 1
`;

function createIndexEvent(emailId: string) {
  return {
    id: randomUUID(),
    emailId,
    topic: OutboxTopic.INDEX_EMAIL,
    idempotencyKey: `index-email:${emailId}:${randomUUID()}`,
    payload: { emailId },
  };
}

async function updateClaimedEmailAndQueueIndex(
  emailId: string,
  claimStartedAt: Date,
  data: Parameters<typeof prisma.scheduledEmail.update>[0]['data'],
  beforeSmtpSubmission = false,
) {
  return prisma.$transaction(async (transaction) => {
    const updated = await transaction.scheduledEmail.updateMany({
      where: {
        id: emailId,
        status: 'SENDING',
        startedAt: claimStartedAt,
        ...(beforeSmtpSubmission ? { smtpSubmissionStartedAt: null } : {}),
      },
      data,
    });
    if (updated.count === 0) return false;
    await transaction.outboxEvent.create({ data: createIndexEvent(emailId) });
    return true;
  });
}

async function claimEmailForSending(emailId: string) {
  const startedAt = new Date();
  return prisma.$transaction(async (transaction) => {
    const claimed = await transaction.scheduledEmail.updateMany({
      where: { id: emailId, status: 'SCHEDULED' },
      data: {
        status: 'SENDING',
        startedAt,
        smtpSubmissionStartedAt: null,
        attempts: { increment: 1 },
      },
    });
    if (claimed.count === 0) return null;
    await transaction.outboxEvent.create({ data: createIndexEvent(emailId) });
    return startedAt;
  });
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function getUtcHourKey(date: Date) {
  const utc = new Date(date);
  const start = new Date(Date.UTC(
    utc.getUTCFullYear(),
    utc.getUTCMonth(),
    utc.getUTCDate(),
    utc.getUTCHours(),
  ));
  return start.toISOString();
}

async function reserveSenderSlot(senderId: string, batchId: string, batchLimit: number) {
  const now = Date.now();
  const hourStart = Date.parse(getUtcHourKey(new Date(now)));
  const hourEnd = hourStart + hourWindowMs;
  const senderKey = `scheduler:sender:${senderId}:hour:${hourStart}`;
  const batchKey = `scheduler:batch:${batchId}:hour:${hourStart}`;
  const pacingKey = `scheduler:sender:${senderId}:next-send-at`;
  const [decision, timestamp] = await redis.eval(
    reserveRateSlotScript,
    3,
    senderKey,
    batchKey,
    pacingKey,
    String(now),
    String(config.MIN_EMAIL_INTERVAL_MS),
    String(config.MAX_EMAILS_PER_HOUR_PER_SENDER),
    String(Math.min(batchLimit, config.MAX_EMAILS_PER_HOUR_PER_BATCH)),
    String(hourEnd),
  ) as [number, number];

  if (decision === 1) {
    return { allowed: true as const, reservationAt: new Date(timestamp) };
  }
  return { allowed: false as const, capped: decision === 0, retryAt: new Date(timestamp) };
}

async function acquireSenderStartGate(senderId: string) {
  const lockKey = `scheduler:sender:${senderId}:send-start-lock`;
  const lastStartKey = `scheduler:sender:${senderId}:last-send-start`;
  const lockToken = randomUUID();
  const intervalMs = config.MIN_EMAIL_INTERVAL_MS;
  const lockTtlMs = Math.max(intervalMs + 1000, 30_000);
  const lastStartTtlMs = Math.max(intervalMs + 1000, 60_000);

  for (;;) {
    const [acquired, retryAfterMs] = await redis.eval(
      acquireSenderStartScript,
      2,
      lockKey,
      lastStartKey,
      lockToken,
      String(intervalMs),
      String(lockTtlMs),
    ) as [number, number];

    if (acquired === 1) {
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await redis.eval(
          releaseSenderStartScript,
          2,
          lockKey,
          lastStartKey,
          lockToken,
          String(lastStartTtlMs),
        );
      };
    }

    await wait(Math.max(1, retryAfterMs));
  }
}

async function processEmailJob(job: Job<EmailJobData>, token?: string) {
  const { emailId } = job.data;
  const email = await prisma.scheduledEmail.findUnique({
    where: { id: emailId },
    select: {
      id: true,
      recipient: true,
      status: true,
      scheduledAt: true,
      batch: {
        select: {
          id: true,
          ownerId: true,
          subject: true,
          body: true,
          hourlyLimit: true,
          sender: {
            select: {
              id: true,
              emailAddress: true,
              smtpHost: true,
              smtpPort: true,
              smtpSecure: true,
              smtpUsername: true,
              passwordCiphertext: true,
              passwordNonce: true,
              passwordAuthTag: true,
            },
          },
        },
      },
    },
  });

  if (!email) {
        logger.warn({ emailId }, 'Email record missing during worker processing.');
        return;
      }

      if (email.status === 'SENT' || email.status === 'FAILED') return;
      const claimStartedAt = await claimEmailForSending(emailId);
      if (!claimStartedAt) return;

      let rateResult: Awaited<ReturnType<typeof reserveSenderSlot>>;
      try {
        rateResult = await reserveSenderSlot(email.batch.sender.id, email.batch.id, email.batch.hourlyLimit);
      } catch (error) {
        await updateClaimedEmailAndQueueIndex(emailId, claimStartedAt, {
          status: 'SCHEDULED',
          startedAt: null,
          smtpSubmissionStartedAt: null,
        });
        throw error;
      }

      if (!rateResult.allowed) {
        const retryAt = rateResult.retryAt;
        await updateClaimedEmailAndQueueIndex(emailId, claimStartedAt, {
          status: 'SCHEDULED',
          scheduledAt: retryAt,
          startedAt: null,
          smtpSubmissionStartedAt: null,
        });
        if (rateResult.capped) await notifySenderCap(email.batch.sender.id, email.batch.ownerId);
        logger.info({ emailId, retryAt: retryAt.toISOString() }, 'Sender rate limit reached; rescheduled email');
        if (!token) throw new Error('BullMQ did not provide the active email job lock token.');
        return await delayActiveJob(job, retryAt, token);
      }

      await wait(Math.max(0, rateResult.reservationAt.getTime() - Date.now()));

      const sender = email.batch.sender;
      const password = decryptSecret({
        ciphertext: sender.passwordCiphertext,
        nonce: sender.passwordNonce,
        authTag: sender.passwordAuthTag,
      });

      const transport = createTransport({
        host: sender.smtpHost,
        port: sender.smtpPort,
        secure: sender.smtpSecure,
        auth: { user: sender.smtpUsername, pass: password },
      });

      let releaseStartGate: (() => Promise<void>) | undefined;
      let submissionStarted = false;
      let info: Awaited<ReturnType<typeof transport.sendMail>>;
      try {
        releaseStartGate = await acquireSenderStartGate(sender.id);
        const submissionClaimed = await updateClaimedEmailAndQueueIndex(
          emailId,
          claimStartedAt,
          { smtpSubmissionStartedAt: new Date() },
          true,
        );
        if (!submissionClaimed) {
          await releaseStartGate();
          return;
        }
        submissionStarted = true;

        const sendPromise = transport.sendMail({
          from: sender.emailAddress,
          to: email.recipient,
          subject: email.batch.subject,
          text: email.batch.body,
          html: `<p>${email.batch.body.replace(/\n/g, '<br />')}</p>`,
        });
        await releaseStartGate();
        info = await sendPromise;
      } catch (error) {
        if (releaseStartGate) await releaseStartGate();
        if (submissionStarted) {
          await updateClaimedEmailAndQueueIndex(emailId, claimStartedAt, {
            status: 'FAILED',
            failureCode: 'SMTP_SEND_FAILED',
            failureMessage: error instanceof Error ? error.message : 'Unknown SMTP send failure',
          });
          logger.error({ emailId, err: error }, 'Email send failed');
        }
        throw error;
      } finally {
        await transport.close();
      }

      const previewUrl = getTestMessageUrl(info);
      const markedSent = await updateClaimedEmailAndQueueIndex(emailId, claimStartedAt, {
        status: 'SENT',
        sentAt: new Date(),
        providerMessageId: info.messageId,
        previewUrl: previewUrl === false ? null : previewUrl ?? null,
      });
      if (markedSent) logger.info({ emailId, messageId: info.messageId }, 'Email sent successfully');
      else logger.warn({ emailId }, 'SMTP accepted the email after its database claim had been superseded');
    }

    export function createEmailWorker(queueName = emailQueueName, concurrency = config.WORKER_CONCURRENCY) {
      const emailWorker = new Worker<EmailJobData>(queueName, async (job, token) => {
        await processEmailJob(job, token);
      }, {
      connection: redis,
          concurrency,
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 5000 },
      });

      emailWorker.on('active', (job) => {
        logger.info({ jobId: job.id, emailId: job.data.emailId }, 'Worker activated email job');
      });

      emailWorker.on('failed', (job, error) => {
        logger.error({ jobId: job?.id, emailId: job?.data.emailId, err: error }, 'Email worker failed');
      });

      return emailWorker;
    }

    export const worker = createEmailWorker();

    process.once('SIGINT', async () => {
      await worker.close();
      await redis.quit();
      await prisma.$disconnect();
      process.exit(0);
    });

    process.once('SIGTERM', async () => {
      await worker.close();
      await redis.quit();
      await prisma.$disconnect();
      process.exit(0);
    });

    logger.info({ concurrency: config.WORKER_CONCURRENCY }, 'Email worker started');
