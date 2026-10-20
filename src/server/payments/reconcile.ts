import type { PrismaClient } from '@prisma/client';
import { logger } from '@/lib/logger';
import { applyVerifiedPayment } from './confirm';
import type { PaymentProvider } from './provider';

// Reconciliation (06 §4.5): a payment still awaiting a result 10 minutes after it was created is
// verified with the provider. This catches a customer who paid but whose webhook and return page never
// arrived. Provider errors defer the payment to the next run and change nothing.

export const RECONCILE_AFTER_MS = 10 * 60 * 1000;

export type ReconcileSummary = { checked: number; confirmed: number; unchanged: number; deferred: number };

const CONFIRMED_OUTCOMES = new Set(['confirmed', 'late_reinstated', 'late_success']);

export async function reconcileStalePayments(
  db: PrismaClient,
  provider: PaymentProvider,
  options: { now?: Date; limit?: number; businessId?: string } = {},
): Promise<ReconcileSummary> {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - RECONCILE_AFTER_MS);
  const stale = await db.payment.findMany({
    where: {
      status: { in: ['INITIALIZED', 'PENDING'] },
      provider: provider.name,
      createdAt: { lte: cutoff },
      ...(options.businessId ? { businessId: options.businessId } : {}),
    },
    select: { reference: true, businessId: true },
    orderBy: { createdAt: 'asc' },
    take: options.limit ?? 25,
  });
  const summary: ReconcileSummary = { checked: stale.length, confirmed: 0, unchanged: 0, deferred: 0 };

  for (const payment of stale) {
    try {
      const verified = await provider.verify(payment.reference);
      const outcome = await applyVerifiedPayment(db, { businessId: payment.businessId }, payment.reference, verified, now);
      if (CONFIRMED_OUTCOMES.has(outcome)) summary.confirmed += 1;
      else summary.unchanged += 1;
    } catch (error) {
      summary.deferred += 1;
      logger.warn({ msg: 'reconciliation verify failed; payment left for the next run', error: error instanceof Error ? error.message : 'unknown' });
    }
  }
  return summary;
}
