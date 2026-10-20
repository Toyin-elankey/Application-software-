import type { PrismaClient } from '@prisma/client';
import { logger } from '@/lib/logger';
import { runDueJobs, type RunSummary } from '@/server/jobs/runner';
import { expireDueReservations, type ExpirySummary } from './expire';
import { reconcileStalePayments, type ReconcileSummary } from './reconcile';
import { refundReconcileHandler, sweepStaleRefunds } from '@/server/refunds/service';
import { getPaymentProvider } from './resolve';
import { paymentVerifyHandler } from './verifyJob';

// Runs payment work: due verify jobs (webhook follow-up and retries) and reservation expiry. Called
// after a webhook response and by the scheduled runner endpoint. Never throws to the caller: a failure
// here must not change a webhook response or an order.

export async function drainPaymentJobs(db: PrismaClient, options: { limit?: number; now?: Date } = {}): Promise<RunSummary | null> {
  let provider;
  try {
    provider = getPaymentProvider();
  } catch {
    logger.error({ msg: 'payment jobs not run: no payment provider is available' });
    return null;
  }
  try {
    return await runDueJobs(db, { 'payment.verify': paymentVerifyHandler(db, provider), 'refund.reconcile': refundReconcileHandler(db, provider) }, options);
  } catch (error) {
    logger.error({ msg: 'payment job runner failed', error: error instanceof Error ? error.message : 'unknown' });
    return null;
  }
}

export type MaintenanceSummary = {
  jobs: RunSummary | null;
  expiry: ExpirySummary | null;
  reconcile: ReconcileSummary | null;
  refunds: { checked: number; updated: number; deferred: number } | null;
};

/** Expiry sweep, then the due jobs. Each part is independent: one failing does not stop the other. */
export async function runPaymentMaintenance(db: PrismaClient, options: { now?: Date; limit?: number } = {}): Promise<MaintenanceSummary> {
  let provider = null;
  try {
    provider = getPaymentProvider();
  } catch {
    logger.error({ msg: 'payment maintenance: no payment provider; pending payments will not be verified' });
  }

  let expiry: ExpirySummary | null = null;
  try {
    expiry = await expireDueReservations(db, provider, { now: options.now, limit: options.limit });
  } catch (error) {
    logger.error({ msg: 'reservation expiry sweep failed', error: error instanceof Error ? error.message : 'unknown' });
  }

  let reconcile: ReconcileSummary | null = null;
  if (provider) {
    try {
      reconcile = await reconcileStalePayments(db, provider, { now: options.now, limit: options.limit });
    } catch (error) {
      logger.error({ msg: 'reconciliation failed', error: error instanceof Error ? error.message : 'unknown' });
    }
  }

  let refunds: MaintenanceSummary['refunds'] = null;
  if (provider) {
    try {
      refunds = await sweepStaleRefunds(db, provider, { now: options.now, limit: options.limit });
    } catch (error) {
      logger.error({ msg: 'refund sweep failed', error: error instanceof Error ? error.message : 'unknown' });
    }
  }

  const jobs = await drainPaymentJobs(db, { limit: options.limit, now: options.now });
  return { jobs, expiry, reconcile, refunds };
}
