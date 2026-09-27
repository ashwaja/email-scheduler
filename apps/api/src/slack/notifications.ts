import { randomUUID } from 'node:crypto';
import { prisma } from '../database.js';
import { logger } from '../logger.js';
import { redis } from '../redis.js';
import { decryptSecret } from '../security/secrets.js';

const attemptsLimit = 3;
const notificationTimeoutMs = 3000;

function utcHourKey(date: Date) {
  return new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    date.getUTCHours(),
  )).toISOString();
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

/** Slack notification failures are best-effort and must never escape into email processing. */
export async function notifySenderCap(senderId: string, ownerId: string) {
  try {
    const dedupeKey = `scheduler:slack-cap:${senderId}:${utcHourKey(new Date())}`;
    const claimed = await redis.set(dedupeKey, randomUUID(), 'EX', 60 * 60, 'NX');
    if (!claimed) return;

    const installation = await prisma.slackInstallation.findUnique({
      where: { ownerId },
      select: {
        webhookCiphertext: true,
        webhookNonce: true,
        webhookAuthTag: true,
        channelName: true,
      },
    });
    if (!installation) return;

    const webhookUrl = decryptSecret({
      ciphertext: installation.webhookCiphertext,
      nonce: installation.webhookNonce,
      authTag: installation.webhookAuthTag,
    });
    const body = JSON.stringify({
      text: `Email sender cap reached for this hour. The scheduler has paused delivery until the next hourly window. Channel: ${installation.channelName ?? 'Slack channel'}`,
    });

    for (let attempt = 1; attempt <= attemptsLimit; attempt += 1) {
      let failure: 'network' | 'timeout' | 'http' = 'network';
      let statusCode: number | undefined;
      try {
        const response = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.timeout(notificationTimeoutMs),
        });
        if (response.ok) return;
        failure = 'http';
        statusCode = response.status;
      } catch (error) {
        failure = error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network';
      }

      if (attempt === attemptsLimit) {
        logger.warn({ senderId, ownerId, attempt, failure, statusCode }, 'Slack cap notification failed after bounded retries');
        return;
      }
      await wait(200 * 2 ** (attempt - 1));
    }
  } catch {
    // Do not log exception details: fetch/decryption errors can contain the webhook URL.
    logger.warn({ senderId, ownerId }, 'Slack cap notification could not be attempted');
  }
}
