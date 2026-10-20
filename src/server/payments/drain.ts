import type { PrismaClient } from '@prisma/client';
import { logger } from '@/lib/logger';
import { runDueJobs, type RunSummary } from '@/server/jobs/runner';
import { paymentVerifyHandler } from './verifyJob';
import { getPaymentProvider } from './resolve';

// Runs due payment jobs. Called after a webhook response and by the scheduled job runner endpoint.
// Never throws: a failure here must not change the webhook response or the order.
export async function drainPaymentJobs(db: PrismaClient, options: { limit?: number; now?: Date } = {}): Promise<RunSummary | null> {
  let provider;
  try {
    provider = getPaymentProvider();
  } catch {
    logger.error({ msg: 'payment jobs not run: no payment provider is available' });
    return null;
  }
  try {
    return await runDueJobs(db, { 'payment.verify': paymentVerifyHandler(db, provider) }, options);
  } catch (error) {
    logger.error({ msg: 'payment job runner failed', error: error instanceof Error ? error.message : 'unknown' });
    return null;
  }
}
