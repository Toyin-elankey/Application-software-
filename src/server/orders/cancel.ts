import type { Prisma } from '@prisma/client';
import type { TenantScope } from '@/server/tenant';
import { AppError } from '@/server/http/problem';
import { canTransition } from './stateMachine';

// Cancels an order that is still awaiting payment and releases its reservation (FR-CHK-04, 06 §4.5).
// Shared by the reservation-expiry sweep, by staff and by the customer (FR-ORD-06). Locks Payment rows before the Order row, the
// same order the payment confirmation path uses, so the two cannot deadlock. The caller runs this inside
// its own transaction and writes any audit row in that same transaction.

export type CancelOptions = {
  now: Date;
  reason: 'payment_timeout' | 'cancelled_by_staff' | 'cancelled_by_customer';
  failureReason: 'reservation_expired' | 'cancelled_by_staff' | 'cancelled_by_customer';
  actorType: 'SYSTEM' | 'STAFF' | 'CUSTOMER';
  actorId: string | null;
  /** When set, the order must still be at this version (If-Match). */
  expectedVersion?: number;
};

export type CancelOutcome = 'cancelled' | 'already_paid' | 'not_pending';

const NOTES: Record<CancelOptions['reason'], string> = {
  payment_timeout: 'reservation expired',
  cancelled_by_staff: 'cancelled by staff',
  cancelled_by_customer: 'cancelled by customer',
};

export async function cancelUnpaidOrderTx(
  tx: Prisma.TransactionClient,
  scope: TenantScope,
  orderId: string,
  options: CancelOptions,
): Promise<CancelOutcome> {
  const payments = await tx.$queryRaw<{ id: string; status: string }[]>`
    SELECT id, status::text AS status FROM "Payment"
    WHERE "orderId" = ${orderId}::uuid AND "businessId" = ${scope.businessId}::uuid
    ORDER BY id FOR UPDATE`;
  // A payment that succeeded wins: the order is not cancelled.
  if (payments.some((p) => p.status === 'SUCCEEDED')) return 'already_paid';

  const [order] = await tx.$queryRaw<{ id: string; status: string; version: number }[]>`
    SELECT id, status::text AS status, version FROM "Order"
    WHERE id = ${orderId}::uuid AND "businessId" = ${scope.businessId}::uuid FOR UPDATE`;
  if (!order || order.status !== 'PENDING_PAYMENT') return 'not_pending';
  if (options.expectedVersion !== undefined && order.version !== options.expectedVersion) {
    throw new AppError(409, 'version_conflict', 'This order changed. Reload it and try again.', { currentVersion: order.version });
  }

  const transition = canTransition('PENDING_PAYMENT', 'CANCELLED', options.actorType);
  if (!transition.ok) throw new AppError(409, 'transition_refused', transition.reason);

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
      UPDATE "ProductVariant" SET reserved = reserved - ${item.quantity}, "updatedAt" = now()
      WHERE id = ${item.variantId}::uuid AND "businessId" = ${scope.businessId}::uuid AND reserved >= ${item.quantity}`;
    if (released !== 1) throw new Error(`reservation release refused for ${item.sku}: books are inconsistent`);
    await tx.inventoryMovement.create({
      data: {
        businessId: scope.businessId,
        variantId: item.variantId,
        delta: item.quantity,
        reason: 'RESERVATION_RELEASED',
        orderId,
        actorType: options.actorType,
        actorStaffId: options.actorType === 'STAFF' ? options.actorId : null,
        note: NOTES[options.reason],
      },
    });
  }

  // Awaiting payments are closed as abandoned. A later success is still processed (06 §5).
  await tx.payment.updateMany({
    where: { orderId, businessId: scope.businessId, status: { in: ['INITIALIZED', 'PENDING'] } },
    data: { status: 'ABANDONED', failureReason: options.failureReason, verifiedAt: options.now },
  });

  const moved = await tx.order.updateMany({
    where: { id: orderId, businessId: scope.businessId, version: order.version, status: 'PENDING_PAYMENT' },
    data: { status: 'CANCELLED', cancelledAt: options.now, cancelReason: options.reason, version: { increment: 1 } },
  });
  if (moved.count !== 1) throw new AppError(409, 'version_conflict', 'This order changed. Reload it and try again.');

  await tx.orderStatusEvent.create({
    data: {
      orderId,
      fromStatus: 'PENDING_PAYMENT',
      toStatus: 'CANCELLED',
      actorType: options.actorType,
      actorId: options.actorId,
      reason: options.reason,
      metadata: { releasedLines: items.length },
    },
  });
  return 'cancelled';
}
