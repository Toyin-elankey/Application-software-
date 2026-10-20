import type { PrismaClient } from '@prisma/client';
import { logger } from '@/lib/logger';
import { canTransition } from '@/server/orders/stateMachine';
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
    const result = await cancelForExpiry(db, scope, order.id, now);
    if (result === 'cancelled') summary.cancelled += 1;
  }
  return summary;
}

async function cancelForExpiry(db: PrismaClient, scope: TenantScope, orderId: string, now: Date): Promise<'cancelled' | 'skipped'> {
  return db.$transaction(
    async (tx) => {
      const payments = await tx.$queryRaw<{ id: string; status: string }[]>`
        SELECT id, status::text AS status FROM \"Payment\"
        WHERE \"orderId\" = ${orderId}::uuid AND \"businessId\" = ${scope.businessId}::uuid
        ORDER BY id FOR UPDATE`;
      // A payment confirmed while the sweep was verifying wins. The order is not cancelled.
      if (payments.some((p) => p.status === 'SUCCEEDED')) return 'skipped';

      const [order] = await tx.$queryRaw<{ id: string; status: string; version: number }[]>`
        SELECT id, status::text AS status, version FROM \"Order\"
        WHERE id = ${orderId}::uuid AND \"businessId\" = ${scope.businessId}::uuid FOR UPDATE`;
      if (!order || order.status !== 'PENDING_PAYMENT') return 'skipped';

      const transition = canTransition('PENDING_PAYMENT', 'CANCELLED', 'SYSTEM');
      if (!transition.ok) throw new Error(transition.reason);

      // Release the reservation: reserved goes down, and a movement records it.
      const items = await tx.orderItem.findMany({
        where: { orderId, variantId: { not: null } },
        select: { variantId: true, quantity: true, sku: true },
        orderBy: { variantId: 'asc' },
      });
      for (const item of items) {
        if (!item.variantId) continue;
        const variant = await tx.productVariant.findFirst({
          where: { id: item.variantId, businessId: scope.businessId },
          select: { trackInventory: true },
        });
        if (!variant?.trackInventory) continue;
        const released = await tx.$executeRaw`
          UPDATE \"ProductVariant\" SET reserved = reserved - ${item.quantity}, \"updatedAt\" = now()
          WHERE id = ${item.variantId}::uuid AND \"businessId\" = ${scope.businessId}::uuid AND reserved >= ${item.quantity}`;
        if (released !== 1) throw new Error(`reservation release refused for ${item.sku}: books are inconsistent`);
        await tx.inventoryMovement.create({
          data: {
            businessId: scope.businessId,
            variantId: item.variantId,
            delta: item.quantity,
            reason: 'RESERVATION_RELEASED',
            orderId,
            actorType: 'SYSTEM',
            note: 'reservation expired',
          },
        });
      }

      // Awaiting payments are closed as abandoned. A later success is still processed (06 §5).
      await tx.payment.updateMany({
        where: { orderId, businessId: scope.businessId, status: { in: ['INITIALIZED', 'PENDING'] } },
        data: { status: 'ABANDONED', failureReason: 'reservation_expired', verifiedAt: now },
      });

      const moved = await tx.order.updateMany({
        where: { id: orderId, businessId: scope.businessId, version: order.version, status: 'PENDING_PAYMENT' },
        data: { status: 'CANCELLED', cancelledAt: now, cancelReason: 'payment_timeout', version: { increment: 1 } },
      });
      if (moved.count !== 1) throw new Error('order changed during expiry; retry');

      await tx.orderStatusEvent.create({
        data: {
          orderId,
          fromStatus: 'PENDING_PAYMENT',
          toStatus: 'CANCELLED',
          actorType: 'SYSTEM',
          reason: 'payment_timeout',
          metadata: { releasedLines: items.length },
        },
      });
      return 'cancelled';
    },
    { timeout: 15_000, maxWait: 10_000 },
  );
}
