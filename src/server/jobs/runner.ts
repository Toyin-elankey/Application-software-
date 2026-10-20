import type { PrismaClient } from '@prisma/client';
import { logger } from '@/lib/logger';

// Postgres job runner (02 §3, 03 §3). Jobs are rows in "Job". A runner claims due jobs with
// FOR UPDATE SKIP LOCKED, so several runners can work at once without taking the same job. A job
// that throws is retried with exponential backoff until maxAttempts, then marked FAILED for staff.
//
// Handlers must be idempotent: a crash after the work but before the status update runs the job again.

export type JobContext = {
  id: string;
  businessId: string | null;
  payload: Record<string, unknown>;
  attempts: number;
};

export type JobHandler = (job: JobContext) => Promise<void>;

export type RunSummary = { claimed: number; succeeded: number; retried: number; failed: number };

const LOCK_MS = 5 * 60_000;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 60 * 60_000;

/** Backoff after the Nth failed attempt: 30s, 1m, 2m, ... capped at one hour. */
export function backoffMs(attempts: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS);
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'unknown error';
  return message.slice(0, 500);
}

export async function runDueJobs(
  db: PrismaClient,
  handlers: Record<string, JobHandler>,
  options: { limit?: number; now?: Date } = {},
): Promise<RunSummary> {
  const now = options.now ?? new Date();
  const limit = options.limit ?? 10;
  const summary: RunSummary = { claimed: 0, succeeded: 0, retried: 0, failed: 0 };

  const claimed = await db.$transaction(async (tx) => {
    const due = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Job"
      WHERE ((status = 'PENDING' AND "runAt" <= ${now}) OR (status = 'RUNNING' AND "lockedUntil" < ${now}))
        AND attempts < "maxAttempts"
      ORDER BY "runAt" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED`;
    if (due.length === 0) return [];
    const ids = due.map((row) => row.id);
    await tx.job.updateMany({
      where: { id: { in: ids } },
      data: { status: 'RUNNING', attempts: { increment: 1 }, lockedUntil: new Date(now.getTime() + LOCK_MS) },
    });
    return tx.job.findMany({ where: { id: { in: ids } }, select: { id: true, businessId: true, type: true, payload: true, attempts: true, maxAttempts: true } });
  });

  summary.claimed = claimed.length;
  for (const job of claimed) {
    const handler = handlers[job.type];
    if (!handler) {
      await db.job.update({ where: { id: job.id }, data: { status: 'FAILED', lockedUntil: null, lastError: 'unknown job type' } });
      summary.failed += 1;
      continue;
    }
    try {
      await handler({ id: job.id, businessId: job.businessId, payload: job.payload as Record<string, unknown>, attempts: job.attempts });
      await db.job.update({ where: { id: job.id }, data: { status: 'SUCCEEDED', lockedUntil: null, lastError: null } });
      summary.succeeded += 1;
    } catch (error) {
      const message = describeError(error);
      if (job.attempts >= job.maxAttempts) {
        await db.job.update({ where: { id: job.id }, data: { status: 'FAILED', lockedUntil: null, lastError: message } });
        summary.failed += 1;
        logger.error({ msg: 'job failed permanently', jobId: job.id, type: job.type, attempts: job.attempts });
      } else {
        await db.job.update({
          where: { id: job.id },
          data: {
            status: 'PENDING',
            lockedUntil: null,
            lastError: message,
            runAt: new Date(now.getTime() + backoffMs(job.attempts)),
          },
        });
        summary.retried += 1;
        logger.warn({ msg: 'job will be retried', jobId: job.id, type: job.type, attempts: job.attempts });
      }
    }
  }
  return summary;
}
