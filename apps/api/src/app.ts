import cors from 'cors';
import express, { Router } from 'express';
import session from 'express-session';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { RedisStore } from 'connect-redis';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { config, type AppConfig } from './config.js';
import { errorHandler, notFoundHandler } from './errors.js';
import { logger } from './logger.js';
import { redis } from './redis.js';
import { createAuthRouter } from './auth/routes.js';
import { passport } from './auth/passport.js';
import { requireUser } from './auth/require-user.js';
import { createSenderRouter } from './senders/routes.js';
import { createSchedulingRouter } from './scheduling/routes.js';
import { prisma } from './database.js';
import { emailQueue } from './queue/email-queue.js';
import { searchIndexedEmails } from './search/emails.js';

function createAdminRouter() {
  const router = Router();
  router.use(requireUser);
  router.use((request, response, next) => {
    const allowed = config.ADMIN_EMAILS.map((email) => email.toLowerCase());
    const current = request.user?.email?.toLowerCase();
    if (!current || !allowed.includes(current)) {
      response.status(403).json({ error: { code: 'ADMIN_FORBIDDEN', message: 'This account is not on the admin allow-list.' } });
      return;
    }
    next();
  });

  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath('/admin/queues');
  createBullBoard({
    queues: [new BullMQAdapter(emailQueue)],
    serverAdapter,
  });
  router.use('/queues', serverAdapter.getRouter());
  return router;
}

function createSearchRouter() {
  const router = Router();
  router.get('/search', requireUser, async (request, response) => {
    const query = String(request.query.q ?? '').trim();
    const requestedStatus = String(request.query.status ?? '');
    const status = ['scheduled', 'sent', 'failed'].includes(requestedStatus) ? requestedStatus : undefined;
    const limit = Math.min(50, Math.max(1, Number(request.query.limit ?? 20) || 20));

    try {
      const emails = await searchIndexedEmails(request.user!.id, query, status, limit);
      response.json({ emails });
      return;
    } catch (error) {
      logger.warn({ err: error }, 'Elasticsearch search failed; using PostgreSQL fallback');
    }

    const emails = await prisma.scheduledEmail.findMany({
      where: {
        batch: { ownerId: request.user!.id },
        ...(status
          ? { status: status.toUpperCase() as 'SCHEDULED' | 'SENT' | 'FAILED' }
          : {}),
        ...(query ? {
          OR: [
            { recipient: { contains: query, mode: 'insensitive' } },
            { batch: { subject: { contains: query, mode: 'insensitive' } } },
          ],
        } : {}),
      },
      orderBy: [{ scheduledAt: 'desc' }, { id: 'asc' }],
      take: limit,
      select: {
        id: true,
        recipient: true,
        status: true,
        scheduledAt: true,
        sentAt: true,
        batch: { select: { subject: true } },
      },
    });

    response.json({ emails: emails.map((email) => ({
      id: email.id,
      recipient: email.recipient,
      subject: email.batch.subject,
      status: email.status.toLowerCase(),
      scheduledAt: email.scheduledAt,
      sentAt: email.sentAt,
    })) });
  });

  return router;
}

export function createApp(settings: AppConfig = config) {
  const app = express();
  app.disable('x-powered-by');
  if (settings.NODE_ENV === 'production') app.set('trust proxy', 1);
  app.use(helmet());
  app.use(cors({ origin: settings.WEB_ORIGIN, credentials: true }));
  app.use(pinoHttp({ logger }));
  app.use(express.json({ limit: '1mb' }));
  app.use(session({
    name: 'reachinbox.sid',
    secret: settings.SESSION_SECRET,
    store: new RedisStore({ client: redis, prefix: 'reachinbox:session:' }),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: settings.NODE_ENV === 'production',
      maxAge: 8 * 60 * 60 * 1000,
    },
  }));
  app.use(passport.initialize());
  app.use(passport.session());

  app.use('/api/auth', createAuthRouter());
  app.use('/api/senders', createSenderRouter());
  app.use('/api', createSchedulingRouter());
  app.use('/api', createSearchRouter());
  app.use('/admin', createAdminRouter());

  app.get('/api/health', (_request, response) => {
    response.status(200).json({ status: 'ok' });
  });

  app.use('/api', notFoundHandler);
  app.use(errorHandler);
  return app;
}
