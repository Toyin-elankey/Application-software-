import type { PrismaClient } from '@prisma/client';
import { logger } from '@/lib/logger';
import { cancelUnpaidOrderTx } from '@/server/orders/cancel';
import type { TenantScope } from '@/server/tenant';
import { applyVerifiedPayment } from './confirm';
import type { PaymentProvider } from './provider';

// Reservation expiry (06 §3, §4.5, FR-CHK-04). When the 30-minute reservation of an unpaid order runs
// out, the order is cancelled and its stock released, but only after one final verify of any payment
// that could still succeed. If the provider cannot be asked, the order is left alone and retried on the
// next sweep: cancelling without a verify could release stock for money that has already arrived.
//
// Lock order matches the confirmation path: Payment rows first, then the Order row. The two cannot
// deadlock, and a payment confirmed mid-sweep makes the cancellation a no-op.

export type ExpirySummary = { checked: number; cancelled: number; confirmed: number; deferred: number };

const SETTLEABLE_BEFORE_CANCEL = ['INITIALIZED', 'PENDING'] as const;

export async function expireDueReservations(
  db: PrismaClient,
  provider: PaymentProvider | null,
  options: { now?: Date; limit?: number; businessId?: string } = {},
): Promise<ExpirySummary> {
  const now = options.now ?? new Date();
  const due = await db.order.findMany({
    where: { status: 'PENDING_PAYMENT', reservationExpiresAt: { lte: now }, ...(options.businessId ? { businessId: options.businessId } : {}) },
    select: { id: true, businessId: true, payments: { select: { id: true, reference: true, status: true, provider: true } } },
    orderBy: { reservationExpiresAt: 'asc' },
    take: options.limit ?? 25,
  });
  const summary: ExpirySummary = { checked: due.length, cancelled: 0, confirmed: 0, deferred: 0 };

  for (const order of due) {
    const scope: TenantScope = { businessId: order.businessId };
    let deferred = false;
    let confirmed = false;

    for (const payment of order.payments) {
      if (!(SETTLEABLE_BEFORE_CANCEL as readonly string[]).includes(payment.status)) continue;
      if (!provider || payment.provider !== provider.name) {
        deferred = true;
        break;
      }
      try {
        const verified = await provider.verify(payment.reference);
        const outcome = await applyVerifiedPayment(db, scope, payment.reference, verified, now);
        if (outcome === 'confirmed') {
          confirmed = true;
          break;
        }
      } catch (error) {
        logger.warn({ msg: 'final verify failed before expiry; order left for the next sweep', orderId: order.id, error: error instanceof Error ? error.message : 'unknown' });
        deferred = true;
        break;
      }
    }

    if (confirmed) {
      summary.confirmed += 1;
      continue;
    }
    if (deferred) {
      summary.deferred += 1;
      continue;
    }
    try {
      const result = await cancelForExpiry(db, scope, order.id, now);
      if (result === 'cancelled') summary.cancelled += 1;
    } catch (error) {
      // One order that changed under us is retried on the next sweep; the others still run.
      logger.warn({ msg: 'expiry cancellation failed; order left for the next sweep', orderId: order.id, error: error instanceof Error ? error.message : 'unknown' });
      summary.deferred += 1;
    }
  }
  return summary;
}

async function cancelForExpiry(db: PrismaClient, scope: TenantScope, orderId: string, now: Date): Promise<'cancelled' | 'skipped'> {
  return db.$transaction(
    async (tx) => {
      const outcome = await cancelUnpaidOrderTx(tx, scope, orderId, {
        now,
        reason: 'payment_timeout',
        failureReason: 'reservation_expired',
        actorType: 'SYSTEM',
        actorId: null,
      });
      return outcome === 'cancelled' ? 'cancelled' : 'skipped';
    },
    { timeout: 15_000, maxWait: 10_000 },
  );
}
