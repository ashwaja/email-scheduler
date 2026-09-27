import { Queue } from 'bullmq';
import type { Job } from 'bullmq';
import { redis } from '../redis.js';

export const emailQueueName = 'email-delivery' as const;

export interface EmailJobData {
  emailId: string;
}

export type EmailQueue = Queue<EmailJobData, void, 'send-email'>;

export const emailQueue: EmailQueue = new Queue<EmailJobData, void, 'send-email'>(emailQueueName, {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  },
});

export async function addEmailJobToQueue(
  queue: EmailQueue,
  emailId: string,
  scheduledAt: Date,
): Promise<Job<EmailJobData, void, 'send-email'>> {
  const jobId = `email-${emailId}`;
  const current = await queue.getJob(jobId);
  if (current) {
    const state = await current.getState();
    if (state === 'failed') {
      await current.retry('failed');
      return current;
    }
    if (state !== 'completed') return current;
    await current.remove();
  }

  return queue.add('send-email', { emailId }, {
    jobId,
    delay: Math.max(0, scheduledAt.getTime() - Date.now()),
  });
}

export function addEmailJob(emailId: string, scheduledAt: Date) {
  return addEmailJobToQueue(emailQueue, emailId, scheduledAt);
}
