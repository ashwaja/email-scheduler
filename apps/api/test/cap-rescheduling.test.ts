import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DelayedError, Queue, Worker } from 'bullmq';
import { config as loadEnvironment } from 'dotenv';
import IORedis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { delayActiveJob } from '../src/queue/delay-active-job.js';

loadEnvironment({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });

const redisUrl = process.env.REDIS_URL;
const queueName = `cap-rescheduling-${randomUUID()}`;
const jobId = 'email-stable-id';
const testSuite = redisUrl ? describe : describe.skip;

testSuite('hourly-cap job rescheduling', () => {
  let queue: Queue;
  let queueConnection: IORedis;
  let workerConnections: IORedis[];
  let workers: Worker[];
  let processCount: number;
  let signalDelayed: () => void;
  let signalResumed: (resumedJobId: string) => void;
  let delayed: Promise<void>;
  let resumed: Promise<string>;

  beforeAll(async () => {
    queueConnection = new IORedis(redisUrl!, { maxRetriesPerRequest: null });
    workerConnections = [];
    workers = [];
    processCount = 0;
    delayed = new Promise((resolve) => { signalDelayed = resolve; });
    resumed = new Promise((resolve) => { signalResumed = resolve; });
    queue = new Queue(queueName, { connection: queueConnection });

    const processJob = async (job: Parameters<Worker['processFn']>[0], token?: string) => {
      processCount += 1;
      if (processCount === 1) {
        try {
          await delayActiveJob(job, new Date(Date.now() + 1500), token!);
        } catch (error) {
          if (error instanceof DelayedError) signalDelayed();
          throw error;
        }
      }
      signalResumed(job.id ?? '');
    };

    for (let index = 0; index < 2; index += 1) {
      const connection = queueConnection.duplicate({ maxRetriesPerRequest: null });
      workerConnections.push(connection);
      workers.push(new Worker(queueName, processJob, { connection, concurrency: 1 }));
    }

    await Promise.all([queue.waitUntilReady(), ...workers.map((worker) => worker.waitUntilReady())]);
  });

  afterAll(async () => {
    await Promise.all(workers.map((worker) => worker.close()));
    await queue.obliterate({ force: true });
    await queue.close();
    await Promise.all([queueConnection, ...workerConnections].map((connection) => connection.quit()));
  });

  it('keeps the stable job delayed and resumes it instead of completing it', async () => {
    const completed = new Promise<void>((resolve) => {
      for (const worker of workers) {
        worker.on('completed', (completedJob) => {
          if (completedJob.id === jobId) resolve();
        });
      }
    });
    await queue.add('send-email', { emailId: 'stable-id' }, { jobId });

    await delayed;
    const delayedJob = await queue.getJob(jobId);
    expect(delayedJob).toBeDefined();
    expect(await delayedJob!.getState()).toBe('delayed');
    expect(delayedJob!.id).toBe(jobId);
    expect(processCount).toBe(1);

    await expect(resumed).resolves.toBe(jobId);
  await completed;
    expect(await queue.getJobState(jobId)).toBe('completed');
    expect(processCount).toBe(2);
  }, 15_000);
});