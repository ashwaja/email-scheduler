import { Router } from 'express';
import { emailListQuerySchema, scheduleEmailBatchSchema } from '@scheduler/contracts';
import { prisma } from '../database.js';
import { AppError } from '../errors.js';
import { requireUser } from '../auth/require-user.js';
import { scheduleEmailBatch } from './service.js';

const idempotencyKeyPattern = /^[A-Za-z0-9._:-]{8,128}$/;

export function createSchedulingRouter() {
  const router = Router();

  router.post('/email-batches', requireUser, async (request, response) => {
    const idempotencyKey = request.get('Idempotency-Key');
    if (!idempotencyKey || !idempotencyKeyPattern.test(idempotencyKey)) {
      throw new AppError(400, 'INVALID_IDEMPOTENCY_KEY', 'Provide an Idempotency-Key header between 8 and 128 safe characters.');
    }

    const parsed = scheduleEmailBatchSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        error: {
          code: 'INVALID_SCHEDULE',
          message: 'Correct the highlighted schedule fields and try again.',
          fields: parsed.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })),
        },
      });
      return;
    }

    const result = await scheduleEmailBatch(request.user!.id, idempotencyKey, parsed.data);
    response.status(result.reused ? 200 : 201).json(result);
  });

  router.get('/emails', requireUser, async (request, response) => {
    const parsed = emailListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw new AppError(400, 'INVALID_EMAIL_QUERY', 'The email list query is invalid.');
    }

    const { view, cursor, limit } = parsed.data;
    const emails = await prisma.scheduledEmail.findMany({
      where: {
        batch: { ownerId: request.user!.id },
        status: view === 'scheduled' ? 'SCHEDULED' : view === 'sent' ? 'SENT' : 'FAILED',
      },
      orderBy: view === 'scheduled'
        ? [{ scheduledAt: 'asc' }, { id: 'asc' }]
        : [{ updatedAt: 'desc' }, { id: 'asc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        recipient: true,
        scheduledAt: true,
        sentAt: true,
        status: true,
        batch: { select: { subject: true } },
      },
    });

    const hasMore = emails.length > limit;
    const page = hasMore ? emails.slice(0, limit) : emails;
    response.json({
      emails: page.map((email) => ({
        id: email.id,
        email: email.recipient,
        subject: email.batch.subject,
        scheduledAt: email.scheduledAt,
        sentAt: email.sentAt,
        status: email.status.toLowerCase(),
      })),
      nextCursor: hasMore ? page.at(-1)?.id ?? null : null,
    });
  });

  return router;
}
