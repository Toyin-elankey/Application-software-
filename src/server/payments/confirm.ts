import type { Prisma, PrismaClient } from '@prisma/client';
import { canTransition, type OrderStatus } from '@/server/orders/stateMachine';
import type { TenantScope } from '@/server/tenant';
import type { VerifiedTransaction } from './provider';

// Applies a server-side verification to a payment (06 §4.4, §5). This is the only place an order
// becomes paid. The input is a VerifiedTransaction from the provider's verify call, never a webhook
// body or a client claim.
//
// Locks: the Payment row, then the Order row, both FOR UPDATE, so concurrent deliveries of the same
// confirmation serialise. A repeat call finds the payment already processed and does nothing.
//
// Staff review: there is no StaffTask model yet (Stage 5 admin). Anything that needs a person writes
// an AuditLog entry with action PAYMENT_NEEDS_REVIEW and sets Payment.failureReason where it applies.

export type ConfirmOutcome =
  | 'confirmed' // order moved to PAYMENT_CONFIRMED, stock committed
  | 'already_processed' // payment was no longer INITIALIZED or PENDING
  | 'pending' // provider still reports PENDING; the job runner retries later
  | 'failed' // provider reports FAILED or ABANDONED
  | 'reference_mismatch' // provider transaction is for another reference; payment FAILED, flagged
  | 'currency_mismatch' // currency differs from what we charged; payment FAILED, flagged
  | 'amount_mismatch' // amount differs from what we charged; payment FAILED, flagged
  | 'duplicate_transaction' // the provider transaction belongs to another payment; payment FAILED, flagged
  | 'second_payment' // the order was already paid; payment SUCCEEDED, flagged, never auto-refunded
  | 'late_reinstated' // paid after the reservation expired; stock was still free, order re-confirmed
  | 'late_success' // money received for an order that cannot be confirmed; refund PENDING, flagged
  | 'not_found';

const AWAITING = ['INITIALIZED', 'PENDING'] as const;

// Paid, or past payment in some other way: a further successful payment is an anomaly.
const ALREADY_PAID: readonly OrderStatus[] = [
  'PAYMENT_CONFIRMED',
  'CONFIRMED',
  'PROCESSING',
  'READY_FOR_DISPATCH',
  'DISPATCHED',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'REFUND_PENDING',
  'REFUNDED',
];

/** The only cancellation that may be reversed by a late payment: the reservation expired. */
const REINSTATABLE_CANCEL_REASON = 'payment_timeout';

export async function applyVerifiedPayment(
  db: PrismaClient,
  scope: TenantScope,
  reference: string,
  verified: VerifiedTransaction,
  now = new Date(),
): Promise<ConfirmOutcome> {
  return db.$transaction(
    async (tx) => {
      const [payment] = await tx.$queryRaw<
        { id: string; status: string; orderId: string; amountMinor: bigint; currency: string }[]
      >`SELECT id, status, \"orderId\", \"amountMinor\", currency FROM \"Payment\"
        WHERE reference = ${reference} AND \"businessId\" = ${scope.businessId}::uuid FOR UPDATE`;
      if (!payment) return 'not_found';
      if (!(AWAITING as readonly string[]).includes(payment.status)) return 'already_processed';

      if (verified.status === 'PENDING') return 'pending';
      if (verified.status === 'FAILED' || verified.status === 'ABANDONED') {
        await tx.payment.update({
          where: { id: payment.id },
          data: { status: verified.status === 'FAILED' ? 'FAILED' : 'ABANDONED', failureReason: `provider_${verified.status.toLowerCase()}` },
        });
        return 'failed';
      }

      // SUCCESS: every identifier must match what we created. Anything else is not paid.
      if (verified.reference !== reference) {
        await failPayment(tx, scope, payment.id, 'reference_mismatch', now, { providerReference: verified.reference });
        return 'reference_mismatch';
      }
      if (verified.currency !== payment.currency) {
        await failPayment(tx, scope, payment.id, 'currency_mismatch', now, { currency: verified.currency });
        return 'currency_mismatch';
      }
      if (verified.amountMinor !== payment.amountMinor) {
        await failPayment(tx, scope, payment.id, 'amount_mismatch', now, {
          expectedMinor: payment.amountMinor.toString(),
          verifiedMinor: verified.amountMinor.toString(),
        });
        return 'amount_mismatch';
      }

      const [order] = await tx.$queryRaw<{ id: string; status: string; version: number }[]>`
        SELECT id, status::text AS status, version FROM \"Order\"
        WHERE id = ${payment.orderId}::uuid AND \"businessId\" = ${scope.businessId}::uuid FOR UPDATE`;
      if (!order) throw new Error('payment refers to a missing order');

      // providerTransactionId is unique. If another payment already holds this provider transaction,
      // this one is not paid. Checked before the write, because a failed unique insert would abort the
      // whole PostgreSQL transaction.
      const clash = await tx.payment.findUnique({
        where: { providerTransactionId: verified.providerTransactionId },
        select: { id: true },
      });
      if (clash && clash.id !== payment.id) {
        await failPayment(tx, scope, payment.id, 'duplicate_provider_transaction', now, {
          providerTransactionId: verified.providerTransactionId,
        });
        return 'duplicate_transaction';
      }

      await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: 'SUCCEEDED',
          providerTransactionId: verified.providerTransactionId,
          channel: verified.channel ?? null,
          paidAt: verified.paidAt ?? now,
          verifiedAt: now,
        },
      });

      if (order.status === 'PENDING_PAYMENT') {
        await confirmOrder(tx, scope, {
          orderId: payment.orderId,
          version: order.version,
          from: 'PENDING_PAYMENT',
          paidAt: verified.paidAt ?? now,
          reference,
          reason: 'payment_verified',
          note: 'payment verified with provider',
        });
        return 'confirmed';
      }

      if (order.status === 'CANCELLED') {
        const reason = await lastCancellationReason(tx, payment.orderId);
        if (reason === REINSTATABLE_CANCEL_REASON && (await reserveAll(tx, scope, payment.orderId))) {
          await confirmOrder(tx, scope, {
            orderId: payment.orderId,
            version: order.version,
            from: 'CANCELLED',
            paidAt: now,
            reference,
            reason: 'late_payment_reinstated',
            note: 'payment arrived after the reservation expired; stock was still available',
          });
          return 'late_reinstated';
        }
        // Money is recorded on the payment. The order stays cancelled; a refund is requested for staff.
        await tx.refund.create({
          data: {
            businessId: scope.businessId,
            paymentId: payment.id,
            orderId: payment.orderId,
            amountMinor: payment.amountMinor,
            reason: reason === REINSTATABLE_CANCEL_REASON ? 'late payment: stock no longer available' : 'payment received after cancellation',
            status: 'PENDING',
          },
        });
        await flagForStaff(tx, scope, payment.id, 'late_success', { orderId: payment.orderId, cancelReason: reason });
        return 'late_success';
      }

      if ((ALREADY_PAID as readonly string[]).includes(order.status)) {
        await tx.payment.update({ where: { id: payment.id }, data: { failureReason: 'second_payment_for_paid_order' } });
        await flagForStaff(tx, scope, payment.id, 'second_payment_for_paid_order', { orderId: payment.orderId, orderStatus: order.status });
        return 'second_payment';
      }

      throw new Error(`unexpected order status ${order.status} for a verified payment`);
    },
    { timeout: 15_000, maxWait: 10_000 },
  );
}

async function failPayment(
  tx: Prisma.TransactionClient,
  scope: TenantScope,
  paymentId: string,
  reason: string,
  now: Date,
  details: Record<string, unknown>,
): Promise<void> {
  await tx.payment.update({ where: { id: paymentId }, data: { status: 'FAILED', failureReason: reason, verifiedAt: now } });
  await flagForStaff(tx, scope, paymentId, reason, details);
}

/** Writes the review item. Staff see it in the audit log until a staff task queue exists (Stage 5). */
export async function flagForStaff(
  tx: Prisma.TransactionClient,
  scope: TenantScope,
  paymentId: string,
  reason: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  await tx.auditLog.create({
    data: {
      businessId: scope.businessId,
      actorType: 'SYSTEM',
      action: 'PAYMENT_NEEDS_REVIEW',
      entityType: 'Payment',
      entityId: paymentId,
      changes: { reason, ...details },
    },
  });
}

async function lastCancellationReason(tx: Prisma.TransactionClient, orderId: string): Promise<string | null> {
  const event = await tx.orderStatusEvent.findFirst({
    where: { orderId, toStatus: 'CANCELLED' },
    orderBy: { createdAt: 'desc' },
    select: { reason: true },
  });
  return event?.reason ?? null;
}

/** Moves the order to paid, commits stock and records the status event. The caller checks the stock. */
async function confirmOrder(
  tx: Prisma.TransactionClient,
  scope: TenantScope,
  change: {
    orderId: string;
    version: number;
    from: 'PENDING_PAYMENT' | 'CANCELLED';
    paidAt: Date;
    reference: string;
    reason: 'payment_verified' | 'late_payment_reinstated';
    note: string;
  },
): Promise<void> {
  const to = 'PAYMENT_CONFIRMED';
  const transition = canTransition(change.from, to, 'SYSTEM');
  if (!transition.ok) throw new Error(transition.reason);

  await commitStock(tx, scope, change.orderId);

  const moved = await tx.order.updateMany({
    where: { id: change.orderId, businessId: scope.businessId, version: change.version, status: change.from },
    data: { status: to, paidAt: change.paidAt, cancelledAt: null, version: { increment: 1 } },
  });
  if (moved.count !== 1) throw new Error('order changed during payment confirmation; retry');

  await tx.orderStatusEvent.create({
    data: {
      orderId: change.orderId,
      fromStatus: change.from,
      toStatus: to,
      actorType: 'SYSTEM',
      reason: change.reason,
      metadata: { paymentReference: change.reference, note: change.note },
    },
  });
}

/**
 * Re-reserves every tracked line of a cancelled order, if the stock is still free. Locks the variants
 * in id order first, so the check and the reservation cannot race another checkout. Returns false,
 * having changed nothing, when any line is short.
 */
async function reserveAll(tx: Prisma.TransactionClient, scope: TenantScope, orderId: string): Promise<boolean> {
  const items = await tx.orderItem.findMany({
    where: { orderId, variantId: { not: null } },
    select: { variantId: true, quantity: true },
    orderBy: { variantId: 'asc' },
  });
  for (const item of items) {
    if (!item.variantId) continue;
    const [variant] = await tx.$queryRaw<{ trackInventory: boolean; onHand: number; reserved: number }[]>`
      SELECT \"trackInventory\", \"onHand\", reserved FROM \"ProductVariant\"
      WHERE id = ${item.variantId}::uuid AND \"businessId\" = ${scope.businessId}::uuid FOR UPDATE`;
    if (!variant?.trackInventory) continue;
    if (variant.onHand - variant.reserved < item.quantity) return false;
  }
  for (const item of items) {
    if (!item.variantId) continue;
    const variant = await tx.productVariant.findFirst({
      where: { id: item.variantId, businessId: scope.businessId },
      select: { trackInventory: true },
    });
    if (!variant?.trackInventory) continue;
    const updated = await tx.$executeRaw`
      UPDATE \"ProductVariant\" SET reserved = reserved + ${item.quantity}, \"updatedAt\" = now()
      WHERE id = ${item.variantId}::uuid AND \"businessId\" = ${scope.businessId}::uuid
        AND \"onHand\" - reserved >= ${item.quantity}`;
    if (updated !== 1) throw new Error('reservation refused after a locked check; books are inconsistent');
  }
  return true;
}

/**
 * Commits reserved stock for every tracked line: onHand and reserved both go down by the quantity,
 * and a SOLD movement is recorded (02 §4 "Commit"). A refusal means the books are already wrong, so the
 * transaction is aborted.
 */
async function commitStock(tx: Prisma.TransactionClient, scope: TenantScope, orderId: string): Promise<void> {
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
    const updated = await tx.$executeRaw`
      UPDATE \"ProductVariant\"
      SET \"onHand\" = \"onHand\" - ${item.quantity}, \"reserved\" = \"reserved\" - ${item.quantity}, \"updatedAt\" = now()
      WHERE id = ${item.variantId}::uuid AND \"businessId\" = ${scope.businessId}::uuid
        AND \"reserved\" >= ${item.quantity} AND \"onHand\" >= ${item.quantity}`;
    if (updated !== 1) throw new Error(`stock commit refused for ${item.sku}: reservation is missing`);
    await tx.inventoryMovement.create({
      data: {
        businessId: scope.businessId,
        variantId: item.variantId,
        delta: -item.quantity,
        reason: 'SOLD',
        orderId,
        actorType: 'SYSTEM',
        note: 'payment verified',
      },
    });
  }
}
