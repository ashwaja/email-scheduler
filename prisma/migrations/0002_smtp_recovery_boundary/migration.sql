ALTER TABLE "scheduled_emails"
ADD COLUMN "smtpSubmissionStartedAt" TIMESTAMP(3);

UPDATE "scheduled_emails"
SET "smtpSubmissionStartedAt" = COALESCE("startedAt", "updatedAt")
WHERE "status" = 'SENDING';

CREATE INDEX "scheduled_emails_status_startedAt_idx"
ON "scheduled_emails"("status", "startedAt");