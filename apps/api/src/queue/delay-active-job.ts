import { DelayedError, type Job } from 'bullmq';

export async function delayActiveJob(job: Pick<Job, 'moveToDelayed'>, runAt: Date, token: string): Promise<never> {
  await job.moveToDelayed(runAt.getTime(), token);
  throw new DelayedError();
}