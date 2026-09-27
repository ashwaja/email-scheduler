import { config as loadEnvironment } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

loadEnvironment({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });

const configurationSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  API_ORIGIN: z.string().url().default('http://localhost:4000'),
  WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().url(),
  ELASTICSEARCH_URL: z.string().url(),
  SESSION_SECRET: z.string().min(32),
  ENCRYPTION_KEY_BASE64: z.string().min(1),
  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),
  GOOGLE_CALLBACK_URL: z.string().url().default('http://localhost:4000/api/auth/google/callback'),
  SLACK_CLIENT_ID: z.string().default(''),
  SLACK_CLIENT_SECRET: z.string().default(''),
  SLACK_CALLBACK_URL: z.string().url().default('http://localhost:4000/api/auth/slack/callback'),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(5),
  STALE_SENDING_RECOVERY_SECONDS: z.coerce.number().int().min(60).max(3600).default(120),
  MIN_EMAIL_INTERVAL_MS: z.coerce.number().int().min(0).default(2000),
  MAX_EMAILS_PER_HOUR_PER_SENDER: z.coerce.number().int().min(1).default(200),
  MAX_EMAILS_PER_HOUR_PER_BATCH: z.coerce.number().int().min(1).default(200),
    OUTBOX_LEASE_SECONDS: z.coerce.number().int().min(30).max(900).default(120),
  ADMIN_EMAILS: z.string().default('').transform((value) =>
    value.split(',').map((email) => email.trim().toLowerCase()).filter(Boolean),
  ),
});

export const config = configurationSchema.parse(process.env);
export type AppConfig = z.infer<typeof configurationSchema>;
