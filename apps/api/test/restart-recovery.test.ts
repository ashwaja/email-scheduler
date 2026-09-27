import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Queue, type Worker } from 'bullmq';
import express from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const { sendMailMock, sendTimes } = vi.hoisted(() => ({
  sendTimes: [] as number[],
  sendMailMock: vi.fn(async () => {
    sendTimes.push(Date.now());
    return { messageId: 'mock-ethereal-message' };
  }),
}));

vi.mock('nodemailer', () => ({
  createTransport: vi.fn(() => ({ sendMail: sendMailMock, close: vi.fn() })),
  getTestMessageUrl: vi.fn(() => false),
}));

vi.mock('../src/security/secrets.js', () => ({
  decryptSecret: vi.fn(() => 'mock-smtp-password'),
  encryptSecret: vi.fn(),
}));

vi.mock('@elastic/elasticsearch', () => ({
  Client: class {
    indices = { create: vi.fn().mockRejectedValue(new Error('Elasticsearch unavailable')) };
  },
}));

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const testSuite = testDatabaseUrl ? describe : describe.skip;
const queueName = `restart-recovery-${randomUUID()}`;
const trackedOwners: string[] = [];
const trackedSenders: string[] = [];
const activeWorkers: Worker[] = [];

testSuite('scheduled email restart and stale-send recovery', () => {
  let prisma: typeof import('../src/database.js').prisma;
  let redis: typeof import('../src/redis.js').redis;
  let emailQueue: typeof import('../src/queue/email-queue.js').emailQueue;
  let recovery: typeof import('../src/scheduling/recovery.js');
  let scheduleEmailBatch: typeof import('../src/scheduling/service.js').scheduleEmailBatch;
  let createEmailWorker: typeof import('../src/worker.js').createEmailWorker;
  let defaultWorker: typeof import('../src/worker.js').worker;
  let createSenderRouter: typeof import('../src/senders/routes.js').createSenderRouter;
  let createSchedulingRouter: typeof import('../src/scheduling/routes.js').createSchedulingRouter;
  let errorHandler: typeof import('../src/errors.js').errorHandler;
  let notFoundHandler: typeof import('../src/errors.js').notFoundHandler;
  let config: typeof import('../src/config.js').config;
  let queue: Queue<{ emailId: string }, void, 'send-email'>;
  const trackedBatches: string[] = [];

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl!;
    process.env.MIN_EMAIL_INTERVAL_MS = '500';
    process.env.ELASTICSEARCH_URL = 'http://127.0.0.1:1';
    ({ prisma } = await import('../src/database.js'));
    ({ redis } = await import('../src/redis.js'));
    ({ emailQueue } = await import('../src/queue/email-queue.js'));
    ({ config } = await import('../src/config.js'));
    recovery = await import('../src/scheduling/recovery.js');
    ({ scheduleEmailBatch } = await import('../src/scheduling/service.js'));
    ({ createSenderRouter } = await import('../src/senders/routes.js'));
    ({ createSchedulingRouter } = await import('../src/scheduling/routes.js'));
    ({ errorHandler, notFoundHandler } = await import('../src/errors.js'));
    ({ createEmailWorker, worker: defaultWorker } = await import('../src/worker.js'));

    await prisma.$connect();
    await emailQueue.waitUntilReady();
    await defaultWorker.close();
    queue = new Queue(queueName, { connection: redis });
    await queue.waitUntilReady();
  });

  afterEach(async () => {
    await Promise.all(activeWorkers.splice(0).map((worker) => worker.close()));
    await queue.obliterate({ force: true });
    for (const batchId of trackedBatches.splice(0)) {
      const batch = await prisma.emailBatch.findUnique({ where: { id: batchId }, select: { senderId: true } });
      if (batch) {
        const keys = await redis.keys(`scheduler:batch:${batchId}:hour:*`);
        if (keys.length) await redis.del(...keys);
      }
      await prisma.emailBatch.deleteMany({ where: { id: batchId } });
    }
    for (const ownerId of trackedOwners.splice(0)) {
      for (const senderId of trackedSenders.splice(0)) {
        const keys = await redis.keys(`scheduler:sender:${senderId}:*`);
        if (keys.length) await redis.del(...keys);
        const notifications = await redis.keys(`scheduler:slack-cap:${senderId}:*`);
        if (notifications.length) await redis.del(...notifications);
      }
      await prisma.emailBatch.deleteMany({ where: { ownerId } });
      await prisma.emailSender.deleteMany({ where: { ownerId } });
      await prisma.user.deleteMany({ where: { id: ownerId } });
    }
    vi.restoreAllMocks();
    sendMailMock.mockClear();
    sendMailMock.mockImplementation(async () => {
      sendTimes.push(Date.now());
      return { messageId: 'mock-ethereal-message' };
    });
    sendTimes.length = 0;
  });

  afterAll(async () => {
    await Promise.all(activeWorkers.splice(0).map((worker) => worker.close()));
    await queue.close();
    await emailQueue.close();
    await redis.quit();
    await prisma.$disconnect();
  });

  async function createOwnerAndSender() {
    const suffix = randomUUID();
    const owner = await prisma.user.create({
      data: {
        googleSubject: `recovery-test-${suffix}`,
        email: `recovery-${suffix}@example.com`,
        name: 'Recovery test',
      },
    });
    trackedOwners.push(owner.id);

    const sender = await prisma.emailSender.create({
      data: {
        ownerId: owner.id,
        label: 'Test sender',
        emailAddress: `sender-${suffix}@example.com`,
        smtpHost: 'smtp.ethereal.email',
        smtpPort: 587,
        smtpSecure: false,
        smtpUsername: `sender-${suffix}`,
        passwordCiphertext: 'test-ciphertext',
        passwordNonce: 'test-nonce',
        passwordAuthTag: 'test-tag',
      },
    });
    trackedSenders.push(sender.id);
    return { owner, sender, suffix };
  }

  async function createScheduledBatch(
    owner: { id: string },
    sender: { id: string },
    startsInMs: number,
    options: { startsAt?: string; recipients?: string[]; hourlyLimit?: number; delayBetweenEmailsMs?: number } = {},
  ) {
    const suffix = randomUUID();
    const input = {
      senderId: sender.id,
      subject: `Restart test ${suffix}`,
      body: 'Test delivery after recovery.',
      recipients: options.recipients ?? [`recipient-${suffix}@example.com`],
      startsAt: options.startsAt ?? new Date(Date.now() + startsInMs).toISOString(),
      delayBetweenEmailsMs: options.delayBetweenEmailsMs ?? 0,
      hourlyLimit: options.hourlyLimit ?? Math.min(5, config.MAX_EMAILS_PER_HOUR_PER_BATCH),
    };
    const idempotencyKey = `recovery:${suffix}`;
    const result = await scheduleEmailBatch(owner.id, idempotencyKey, input);
    trackedBatches.push(result.batchId);
    const email = await prisma.scheduledEmail.findFirstOrThrow({
      where: { batchId: result.batchId },
      orderBy: { sequence: 'asc' },
    });

    return { owner, sender, input, idempotencyKey, result, email, batchId: result.batchId };
  }

  async function createScheduledEmail(startsInMs: number) {
    const { owner, sender } = await createOwnerAndSender();
    return createScheduledBatch(owner, sender, startsInMs);
  }

  async function waitForStatus(emailId: string, status: 'SENT' | 'FAILED', timeoutMs = 20_000) {
    const expiresAt = Date.now() + timeoutMs;
    while (Date.now() < expiresAt) {
      const email = await prisma.scheduledEmail.findUnique({ where: { id: emailId } });
      if (email?.status === status) return email;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Email ${emailId} did not reach ${status} before timeout.`);
  }

  async function waitForCondition<T>(
    condition: () => Promise<T | false | undefined>,
    timeoutMs = 20_000,
  ): Promise<T> {
    const expiresAt = Date.now() + timeoutMs;
    while (Date.now() < expiresAt) {
      const result = await condition();
      if (result !== undefined && result !== false) return result;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('Condition was not met before timeout.');
  }

  function startWorker(concurrency = config.WORKER_CONCURRENCY) {
    const worker = createEmailWorker(queueName, concurrency);
    activeWorkers.push(worker);
    return worker;
  }

  async function startAuthenticatedApi(users: Array<{ id: string; email: string; name: string; avatarUrl: string | null }>) {
    const usersById = new Map(users.map((user) => [user.id, user]));
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => {
      const user = usersById.get(request.header('x-test-owner') ?? '');
      request.user = user;
      request.isAuthenticated = () => Boolean(user);
      next();
    });
    app.use('/api/senders', createSenderRouter());
    app.use('/api', createSchedulingRouter());
    app.use('/api', notFoundHandler);
    app.use(errorHandler);

    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const address = server.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${address.port}`,
      close: () => new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      }),
    };
  }

  it('keeps a future PostgreSQL/BullMQ schedule across worker restart and sends once', async () => {
    const firstWorker = startWorker();
    await firstWorker.waitUntilReady();

    const fixture = await createScheduledEmail(8_000);
    const scheduledAt = fixture.email.scheduledAt;
    expect(fixture.email.status).toBe('SCHEDULED');

    await recovery.reconcileScheduledEmails(queue);
    const jobId = `email-${fixture.email.id}`;
    const job = await queue.getJob(jobId);
    expect(job).toBeDefined();
    expect(await job!.getState()).toBe('delayed');

    await firstWorker.close();
    activeWorkers.splice(activeWorkers.indexOf(firstWorker), 1);
    const persistedJob = await queue.getJob(jobId);
    expect(await persistedJob!.getState()).toBe('delayed');
    expect((await prisma.scheduledEmail.findUniqueOrThrow({ where: { id: fixture.email.id } })).scheduledAt)
      .toEqual(scheduledAt);

    const restartedWorker = startWorker();
    await restartedWorker.waitUntilReady();
    const sent = await waitForStatus(fixture.email.id, 'SENT');

    expect(sent.sentAt!.getTime()).toBeGreaterThanOrEqual(scheduledAt.getTime());
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(sent.attempts).toBe(1);
    expect(await queue.getJobState(jobId)).toBe('completed');
  }, 30_000);

  it('recovers a stale pre-SMTP claim and safely processes it again', async () => {
    const fixture = await createScheduledEmail(60_000);
    const staleStartedAt = new Date(Date.now() - 10 * 60_000);
    await prisma.scheduledEmail.update({
      where: { id: fixture.email.id },
      data: {
        status: 'SENDING',
        startedAt: staleStartedAt,
        attempts: 1,
        scheduledAt: new Date(Date.now() - 1000),
        smtpSubmissionStartedAt: null,
      },
    });

    const outcome = await recovery.recoverStaleSendingEmails(queue);
    const recovered = await prisma.scheduledEmail.findUniqueOrThrow({ where: { id: fixture.email.id } });
    expect(outcome.rescheduled).toBe(1);
    expect(recovered.status).toBe('SCHEDULED');
    expect(recovered.startedAt).toBeNull();
    expect(await queue.getJob(`email-${fixture.email.id}`)).toBeDefined();

    const worker = startWorker();
    await worker.waitUntilReady();
    const sent = await waitForStatus(fixture.email.id, 'SENT');
    expect(sent.attempts).toBe(2);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
  });

  it('does not resend an ambiguous SMTP submission after stale recovery', async () => {
    const fixture = await createScheduledEmail(60_000);
    const staleStartedAt = new Date(Date.now() - 10 * 60_000);
    await prisma.scheduledEmail.update({
      where: { id: fixture.email.id },
      data: {
        status: 'SENDING',
        startedAt: staleStartedAt,
        attempts: 1,
        smtpSubmissionStartedAt: staleStartedAt,
      },
    });

    const outcome = await recovery.recoverStaleSendingEmails(queue);
    const failed = await prisma.scheduledEmail.findUniqueOrThrow({ where: { id: fixture.email.id } });
    expect(outcome.markedUnconfirmed).toBe(1);
    expect(failed.status).toBe('FAILED');
    expect(failed.failureCode).toBe('SMTP_OUTCOME_UNCONFIRMED');
    expect(await queue.getJob(`email-${fixture.email.id}`)).toBeUndefined();
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it('keeps repeated logical schedule requests to one row, outbox send, job, and SMTP call', async () => {
    const fixture = await createScheduledEmail(5_000);
    const repeated = await scheduleEmailBatch(fixture.owner.id, fixture.idempotencyKey, fixture.input);
    expect(repeated.batchId).toBe(fixture.result.batchId);
    expect(repeated.reused).toBe(true);
    expect(await prisma.scheduledEmail.count({ where: { batchId: fixture.result.batchId } })).toBe(1);
    expect(await prisma.outboxEvent.count({
      where: { emailId: fixture.email.id, topic: 'SEND_EMAIL' },
    })).toBe(1);

    await recovery.reconcileScheduledEmails(queue);
    await recovery.reconcileScheduledEmails(queue);
    expect(await queue.getJob(`email-${fixture.email.id}`)).toBeDefined();
    expect(await queue.getJobCounts('delayed')).toMatchObject({ delayed: 1 });

    const worker = startWorker();
    await worker.waitUntilReady();
    await waitForStatus(fixture.email.id, 'SENT');
    expect(sendMailMock).toHaveBeenCalledTimes(1);
  }, 20_000);

  it('uses the database claim to prevent concurrent duplicate sends for one email', async () => {
    const fixture = await createScheduledEmail(500);
    let releaseSmtp!: () => void;
    let signalSmtpStarted!: () => void;
    const smtpStarted = new Promise<void>((resolve) => { signalSmtpStarted = resolve; });
    const smtpGate = new Promise<void>((resolve) => { releaseSmtp = resolve; });
    sendMailMock.mockImplementationOnce(async () => {
      sendTimes.push(Date.now());
      signalSmtpStarted();
      await smtpGate;
      return { messageId: 'single-claimed-send' };
    });

    const workers = [startWorker(1), startWorker(1)];
    await Promise.all(workers.map((worker) => worker.waitUntilReady()));
    const jobIds = [`race-a-${fixture.email.id}`, `race-b-${fixture.email.id}`];
    await Promise.all(jobIds.map((jobId) => queue.add(
      'send-email',
      { emailId: fixture.email.id },
      { jobId },
    )));

    await smtpStarted;
    await waitForCondition(async () => {
      const states = await Promise.all(jobIds.map((jobId) => queue.getJobState(jobId)));
      return states.includes('completed');
    });
    const claimed = await prisma.scheduledEmail.findUniqueOrThrow({ where: { id: fixture.email.id } });
    expect(claimed.status).toBe('SENDING');
    expect(claimed.attempts).toBe(1);
    expect(sendMailMock).toHaveBeenCalledTimes(1);

    releaseSmtp();
    const sent = await waitForStatus(fixture.email.id, 'SENT');
    expect(sent.attempts).toBe(1);
    expect(await Promise.all(jobIds.map((jobId) => queue.getJobState(jobId))))
      .toEqual(['completed', 'completed']);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
  });

  it('shares the sender cap across workers, delays the capped job, and resumes it after the window clears', async () => {
    const { owner, sender } = await createOwnerAndSender();
    const startsAt = new Date(Date.now() + 500).toISOString();
    const hourlyLimit = Math.min(config.MAX_EMAILS_PER_HOUR_PER_SENDER, config.MAX_EMAILS_PER_HOUR_PER_BATCH);
    const first = await createScheduledBatch(owner, sender, 0, { startsAt, hourlyLimit });
    const second = await createScheduledBatch(owner, sender, 0, { startsAt, hourlyLimit });
    await prisma.slackInstallation.create({
      data: {
        ownerId: owner.id,
        webhookCiphertext: 'test-ciphertext',
        webhookNonce: 'test-nonce',
        webhookAuthTag: 'test-tag',
      },
    });

    const now = new Date();
    const hourStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours());
    const hourEnd = hourStart + 60 * 60 * 1000;
    const senderCounterKey = `scheduler:sender:${sender.id}:hour:${hourStart}`;
    const batchCounterKey = `scheduler:batch:${second.batchId}:hour:${hourStart}`;
    const pacingKey = `scheduler:sender:${sender.id}:next-send-at`;
    const notificationKey = `scheduler:slack-cap:${sender.id}:${new Date(hourStart).toISOString()}`;
    await redis.set(senderCounterKey, String(Math.max(0, config.MAX_EMAILS_PER_HOUR_PER_SENDER - 1)), 'EX', 7200);
    const slackFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Slack unavailable'));

    let releaseSmtp!: () => void;
    let signalSmtpStarted!: () => void;
    const smtpStarted = new Promise<void>((resolve) => { signalSmtpStarted = resolve; });
    const smtpGate = new Promise<void>((resolve) => { releaseSmtp = resolve; });
    sendMailMock.mockImplementationOnce(async () => {
      sendTimes.push(Date.now());
      signalSmtpStarted();
      await smtpGate;
      return { messageId: 'first-sender-slot' };
    });

    const workers = [startWorker(1), startWorker(1)];
    await Promise.all(workers.map((worker) => worker.waitUntilReady()));
    await recovery.reconcileScheduledEmails(queue);
    await smtpStarted;

    const delayedEmail = await waitForCondition(async () => {
      for (const email of [first.email, second.email]) {
        if (await queue.getJobState(`email-${email.id}`) === 'delayed') return email;
      }
      return undefined;
    });
    const delayedRow = await prisma.scheduledEmail.findUniqueOrThrow({ where: { id: delayedEmail.id } });
    expect(delayedRow.status).toBe('SCHEDULED');
    expect(delayedRow.scheduledAt.getTime()).toBe(hourEnd);
    expect(slackFetch).toHaveBeenCalledTimes(3);
    expect(sendMailMock).toHaveBeenCalledTimes(1);

    const allowedEmail = delayedEmail.id === first.email.id ? second.email : first.email;
    releaseSmtp();
    await waitForStatus(allowedEmail.id, 'SENT');
    expect(await queue.getJobState(`email-${delayedEmail.id}`)).toBe('delayed');

    await redis.del(senderCounterKey, batchCounterKey, pacingKey, notificationKey);
    const resumedAt = new Date(Date.now() + 500);
    await prisma.scheduledEmail.update({ where: { id: delayedEmail.id }, data: { scheduledAt: resumedAt } });
    const delayedJob = await queue.getJob(`email-${delayedEmail.id}`);
    await delayedJob!.changeDelay(resumedAt.getTime() - Date.now());

    const resumed = await waitForStatus(delayedEmail.id, 'SENT');
    expect(resumed.sentAt!.getTime()).toBeGreaterThanOrEqual(resumedAt.getTime());
    expect(sendMailMock).toHaveBeenCalledTimes(2);
  }, 25_000);

  it('does not violate the configured minimum send spacing with concurrent workers', async () => {
    const { owner, sender } = await createOwnerAndSender();
    const startsAt = new Date(Date.now() + 500).toISOString();
    const first = await createScheduledBatch(owner, sender, 0, { startsAt });
    const second = await createScheduledBatch(owner, sender, 0, { startsAt });
    const workers = [startWorker(1), startWorker(1)];
    await Promise.all(workers.map((worker) => worker.waitUntilReady()));
    await recovery.reconcileScheduledEmails(queue);

    await Promise.all([
      waitForStatus(first.email.id, 'SENT'),
      waitForStatus(second.email.id, 'SENT'),
    ]);

    expect(sendTimes).toHaveLength(2);
    const [earlier, later] = [...sendTimes].sort((left, right) => left - right);
    expect(later - earlier).toBeGreaterThanOrEqual(config.MIN_EMAIL_INTERVAL_MS);
  }, 20_000);

  it('records SMTP errors as FAILED without retrying the send', async () => {
    const fixture = await createScheduledEmail(500);
    sendMailMock.mockRejectedValueOnce(new Error('Ethereal rejected the message'));
    const worker = startWorker();
    await worker.waitUntilReady();
    await recovery.reconcileScheduledEmails(queue);

    const failed = await waitForStatus(fixture.email.id, 'FAILED');
    expect(failed.failureCode).toBe('SMTP_SEND_FAILED');
    expect(failed.failureMessage).toContain('Ethereal rejected');
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(await queue.getJobState(`email-${fixture.email.id}`)).toBe('failed');
  });

  it('keeps SMTP delivery successful when Elasticsearch indexing fails', async () => {
    const fixture = await createScheduledEmail(500);
    const { indexEmailById } = await import('../src/search/emails.js');
    await expect(indexEmailById(fixture.email.id)).rejects.toThrow('Elasticsearch unavailable');

    const worker = startWorker();
    await worker.waitUntilReady();
    await recovery.reconcileScheduledEmails(queue);
    const sent = await waitForStatus(fixture.email.id, 'SENT');

    expect(sent.status).toBe('SENT');
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(await prisma.outboxEvent.count({
      where: { emailId: fixture.email.id, topic: 'INDEX_EMAIL' },
    })).toBeGreaterThan(0);
  });

  it('returns only successfully sent emails in the sent view', async () => {
    const { owner, sender } = await createOwnerAndSender();
    const fixture = await createScheduledBatch(owner, sender, 60_000, {
      recipients: ['sent-view-one@example.com', 'sent-view-two@example.com'],
    });
    const emails = await prisma.scheduledEmail.findMany({ where: { batchId: fixture.batchId }, orderBy: { sequence: 'asc' } });
    const sentAt = new Date();
    await prisma.scheduledEmail.update({ where: { id: emails[0]!.id }, data: { status: 'SENT', sentAt } });
    await prisma.scheduledEmail.update({ where: { id: emails[1]!.id }, data: { status: 'FAILED' } });
    const api = await startAuthenticatedApi([owner]);

    try {
      const response = await fetch(`${api.url}/api/emails?view=sent`, {
        headers: { 'x-test-owner': owner.id },
      });
      expect(response.status).toBe(200);
      const result = await response.json() as { emails: Array<{ id: string; status: string }> };
      expect(result.emails.map((email) => email.id)).toContain(emails[0]!.id);
      expect(result.emails.map((email) => email.status)).not.toContain('failed');
      expect(result.emails.map((email) => email.id)).not.toContain(emails[1]!.id);
    } finally {
      await api.close();
    }
  });

  it('preserves each recipient schedule and applies the configured delay floor', async () => {
    const { owner, sender } = await createOwnerAndSender();
    const startsAt = new Date(Date.now() + 60_000);
    const recipients = ['one@example.com', 'two@example.com', 'three@example.com'];
    const fixture = await createScheduledBatch(owner, sender, 0, {
      startsAt: startsAt.toISOString(),
      recipients,
      delayBetweenEmailsMs: 1,
    });
    const batch = await prisma.emailBatch.findUniqueOrThrow({ where: { id: fixture.batchId } });
    const emails = await prisma.scheduledEmail.findMany({
      where: { batchId: fixture.batchId },
      orderBy: { sequence: 'asc' },
    });

    expect(batch.delayBetweenMs).toBe(config.MIN_EMAIL_INTERVAL_MS);
    expect(emails.map((email) => email.recipient)).toEqual(recipients);
    expect(emails.map((email) => email.scheduledAt.getTime())).toEqual(
      recipients.map((_, sequence) => startsAt.getTime() + sequence * batch.delayBetweenMs),
    );
  });

  it('keeps sender, batch, and email access scoped to the authenticated owner', async () => {
    const firstOwner = await createScheduledEmail(60_000);
    const secondOwner = await createScheduledEmail(60_000);
    const api = await startAuthenticatedApi([firstOwner.owner, secondOwner.owner]);

    try {
      const listResponse = await fetch(`${api.url}/api/emails?view=scheduled`, {
        headers: { 'x-test-owner': firstOwner.owner.id },
      });
      expect(listResponse.status).toBe(200);
      const listed = await listResponse.json() as { emails: Array<{ id: string }> };
      expect(listed.emails.map((email) => email.id)).toContain(firstOwner.email.id);
      expect(listed.emails.map((email) => email.id)).not.toContain(secondOwner.email.id);

      const deleteSender = await fetch(`${api.url}/api/senders/${secondOwner.sender.id}`, {
        method: 'DELETE',
        headers: { 'x-test-owner': firstOwner.owner.id },
      });
      expect(deleteSender.status).toBe(404);
      expect((await prisma.emailSender.findUniqueOrThrow({ where: { id: secondOwner.sender.id } })).enabled)
        .toBe(true);

      const scheduleWithOtherSender = await fetch(`${api.url}/api/email-batches`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `cross-owner:${randomUUID()}`,
          'x-test-owner': firstOwner.owner.id,
        },
        body: JSON.stringify({ ...secondOwner.input, senderId: secondOwner.sender.id }),
      });
      expect(scheduleWithOtherSender.status).toBe(404);
      expect((await scheduleWithOtherSender.json() as { error: { code: string } }).error.code)
        .toBe('SENDER_NOT_FOUND');

      const patchBatch = await fetch(`${api.url}/api/email-batches/${secondOwner.batchId}`, {
        method: 'PATCH',
        headers: { 'x-test-owner': firstOwner.owner.id },
      });
      const deleteEmail = await fetch(`${api.url}/api/emails/${secondOwner.email.id}`, {
        method: 'DELETE',
        headers: { 'x-test-owner': firstOwner.owner.id },
      });
      expect(patchBatch.status).toBe(404);
      expect(deleteEmail.status).toBe(404);
      expect((await prisma.scheduledEmail.findUniqueOrThrow({ where: { id: secondOwner.email.id } })).status)
        .toBe('SCHEDULED');
    } finally {
      await api.close();
    }
  });

  it('rejects malformed and past scheduling requests without creating batches', async () => {
    const fixture = await createScheduledEmail(60_000);
    const api = await startAuthenticatedApi([fixture.owner]);
    const batchCountBefore = await prisma.emailBatch.count({ where: { ownerId: fixture.owner.id } });

    try {
      const invalidRecipients = await fetch(`${api.url}/api/email-batches`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `invalid:${randomUUID()}`,
          'x-test-owner': fixture.owner.id,
        },
        body: JSON.stringify({ ...fixture.input, recipients: ['not-an-email'] }),
      });
      expect(invalidRecipients.status).toBe(400);
      expect((await invalidRecipients.json() as { error: { code: string } }).error.code)
        .toBe('INVALID_SCHEDULE');

      const pastStart = await fetch(`${api.url}/api/email-batches`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `past:${randomUUID()}`,
          'x-test-owner': fixture.owner.id,
        },
        body: JSON.stringify({ ...fixture.input, startsAt: new Date(Date.now() - 1000).toISOString() }),
      });
      expect(pastStart.status).toBe(400);
      expect((await pastStart.json() as { error: { code: string } }).error.code).toBe('START_TIME_IN_PAST');
      expect(await prisma.emailBatch.count({ where: { ownerId: fixture.owner.id } })).toBe(batchCountBefore);
    } finally {
      await api.close();
    }
  });
});
