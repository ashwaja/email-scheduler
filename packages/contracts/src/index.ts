import { z } from 'zod';

export const apiVersion = 'v1';

export const scheduleEmailBatchSchema = z.object({
	senderId: z.string().min(1),
	subject: z.string().trim().min(1).max(998),
	body: z.string().min(1).max(250_000),
	recipients: z.array(z.string().trim().email().max(254)).min(1).max(5000),
	startsAt: z.string().datetime({ offset: true }),
	delayBetweenEmailsMs: z.number().int().min(0).max(3_600_000),
	hourlyLimit: z.number().int().min(1).max(100_000),
}).strict();

export const emailListQuerySchema = z.object({
	view: z.enum(['scheduled', 'sent', 'failed']).default('scheduled'),
	cursor: z.string().min(1).optional(),
	limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

export const searchQuerySchema = z.object({
	q: z.string().trim().max(200).optional(),
	status: z.enum(['scheduled', 'sent', 'failed']).optional(),
	limit: z.coerce.number().int().min(1).max(50).default(20),
}).strict();

export type ScheduleEmailBatchInput = z.infer<typeof scheduleEmailBatchSchema>;
export type EmailListQuery = z.infer<typeof emailListQuerySchema>;
export type SearchQuery = z.infer<typeof searchQuerySchema>;

export type EmailStatus = 'scheduled' | 'sending' | 'sent' | 'failed';

export interface EmailListItem {
	id: string;
	email: string;
	subject: string;
	scheduledAt: string;
	sentAt: string | null;
	status: EmailStatus;
}
