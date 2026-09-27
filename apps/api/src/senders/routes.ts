import { Router } from 'express';
import { z } from 'zod';
import nodemailer from 'nodemailer';
import { prisma } from '../database.js';
import { AppError } from '../errors.js';
import { encryptSecret } from '../security/secrets.js';
import { requireUser } from '../auth/require-user.js';

const createSenderSchema = z.object({
  label: z.string().trim().min(1).max(80).optional(),
}).strict();

function publicSender(sender: {
  id: string;
  label: string;
  emailAddress: string;
  enabled: boolean;
  createdAt: Date;
}) {
  return {
    id: sender.id,
    label: sender.label,
    emailAddress: sender.emailAddress,
    enabled: sender.enabled,
    createdAt: sender.createdAt,
  };
}

export function createSenderRouter() {
  const router = Router();
  router.use(requireUser);

  router.get('/', async (request, response) => {
    const senders = await prisma.emailSender.findMany({
      where: { ownerId: request.user!.id },
      orderBy: { createdAt: 'desc' },
      select: { id: true, label: true, emailAddress: true, enabled: true, createdAt: true },
    });
    response.json({ senders });
  });

  router.post('/ethereal', async (request, response) => {
    const parsed = createSenderSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new AppError(400, 'INVALID_SENDER', 'Sender details are invalid.');
    }

    const account = await nodemailer.createTestAccount();
    const transport = nodemailer.createTransport({
      host: 'smtp.ethereal.email',
      port: 587,
      secure: false,
      auth: { user: account.user, pass: account.pass },
    });
    try {
      await transport.verify();
    } finally {
      transport.close();
    }

    const encrypted = encryptSecret(account.pass);
    const sender = await prisma.emailSender.create({
      data: {
        ownerId: request.user!.id,
        label: parsed.data.label ?? account.user,
        emailAddress: account.user,
        smtpHost: 'smtp.ethereal.email',
        smtpPort: 587,
        smtpSecure: false,
        smtpUsername: account.user,
        passwordCiphertext: encrypted.ciphertext,
        passwordNonce: encrypted.nonce,
        passwordAuthTag: encrypted.authTag,
      },
      select: { id: true, label: true, emailAddress: true, enabled: true, createdAt: true },
    });

    response.status(201).json({ sender: publicSender(sender) });
  });

  router.delete('/:senderId', async (request, response) => {
    const result = await prisma.emailSender.updateMany({
      where: { id: request.params.senderId, ownerId: request.user!.id },
      data: { enabled: false },
    });
    if (result.count === 0) {
      throw new AppError(404, 'SENDER_NOT_FOUND', 'Sender not found.');
    }
    response.status(204).end();
  });

  return router;
}
