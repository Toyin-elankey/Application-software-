import type { Prisma, PrismaClient } from '@prisma/client';
import { canTransition } from '@/server/orders/stateMachine';
import type { TenantScope } from '@/server/tenant';
import type { VerifiedTransaction } from './provider';

// Applies a server-side verification to a payment and, if it succeeded, moves the order to
// PAYMENT_CONFIRMED (06 §4.4, PRD FR-PAY-*). This is the only place an order becomes paid.
//
// The input is a VerifiedTransaction from the provider's verify call, never a webhook body or a
// client claim. Locks: the Payment row, then the Order row, both FOR UPDATE, so concurrent
// deliveries of the same confirmation serialise. A repeat call finds the payment already processed
// and does nothing.

export type ConfirmOutcome =
  | 'confirmed' // order moved to PAYMENT_CONFIRMED, stock committed
  | 'already_processed' // payment was no longer INITIALIZED or PENDING
  | 'pending' // provider still reports PENDING; try again later
  | 'failed' // provider reports FAILED or ABANDONED
  | 'amount_mismatch' // amount or currency differs from what we charged; payment marked FAILED
  | 'duplicate_transaction' // the provider transaction belongs to another payment; payment marked FAILED
  | 'late_success' // money received but the order is no longer awaiting payment (refund workflow, Stage 4)
  | 'not_found';

const AWAITING = ['INITIALIZED', 'PENDING'] as const;

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
      >`SELECT id, status, "orderId", "amountMinor", currency FROM "Payment"
        WHERE reference = ${reference} AND "businessId" = ${scope.businessId}::uuid FOR UPDATE`;
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

      // SUCCESS: the amount and currency must match what we charged. Anything else is not paid.
      if (verified.amountMinor !== payment.amountMinor || verified.currency !== payment.currency) {
        await tx.payment.update({
          where: { id: payment.id },
          data: { status: 'FAILED', failureReason: 'amount_mismatch', verifiedAt: now },
        });
        return 'amount_mismatch';
      }

      const [order] = await tx.$queryRaw<{ id: string; status: string; version: number }[]>`
        SELECT id, status::text AS status, version FROM "Order"
        WHERE id = ${payment.orderId}::uuid AND "businessId" = ${scope.businessId}::uuid FOR UPDATE`;
      if (!order) throw new Error('payment refers to a missing order');

      // providerTransactionId is unique. If another payment already holds this provider transaction,
      // this one is not paid: it is a reconciliation problem for staff. Checked before the write,
      // because a failed unique insert would abort the whole PostgreSQL transaction.
      const clash = await tx.payment.findUnique({
        where: { providerTransactionId: verified.providerTransactionId },
        select: { id: true },
      });
      if (clash && clash.id !== payment.id) {
        await tx.payment.update({
          where: { id: payment.id },
          data: { status: 'FAILED', failureReason: 'duplicate_provider_transaction', verifiedAt: now },
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

      if (order.status !== 'PENDING_PAYMENT') {
        // The reservation expired or the order was cancelled first. The money is recorded on the
        // payment; the order is not moved, and the refund workflow decides what happens (06 §5).
        await tx.payment.update({ where: { id: payment.id }, data: { failureReason: 'order_not_pending' } });
        return 'late_success';
      }
      const transition = canTransition('PENDING_PAYMENT', 'PAYMENT_CONFIRMED', 'SYSTEM');
      if (!transition.ok) throw new Error(transition.reason);

      await commitStock(tx, scope, payment.orderId);

      const moved = await tx.order.updateMany({
        where: { id: payment.orderId, businessId: scope.businessId, version: order.version, status: 'PENDING_PAYMENT' },
        data: { status: 'PAYMENT_CONFIRMED', paidAt: verified.paidAt ?? now, version: { increment: 1 } },
      });
      if (moved.count !== 1) throw new Error('order changed during payment confirmation; retry');

      await tx.orderStatusEvent.create({
        data: {
          orderId: payment.orderId,
          fromStatus: 'PENDING_PAYMENT',
          toStatus: 'PAYMENT_CONFIRMED',
          actorType: 'SYSTEM',
          reason: 'payment verified with provider',
          metadata: { paymentReference: reference, provider: 'MOCK' },
        },
      });
      return 'confirmed';
    },
    { timeout: 15_000, maxWait: 10_000 },
  );
}

/**
 * Commits reserved stock for every tracked line of the order: onHand and reserved both go down by
 * the quantity, and a SOLD movement is recorded (02 §4 "Commit"). The conditional update refuses to
 * go negative. A refusal means the books are already wrong, so the transaction is aborted.
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
      UPDATE "ProductVariant"
      SET "onHand" = "onHand" - ${item.quantity}, "reserved" = "reserved" - ${item.quantity}, "updatedAt" = now()
      WHERE id = ${item.variantId}::uuid AND "businessId" = ${scope.businessId}::uuid
        AND "reserved" >= ${item.quantity} AND "onHand" >= ${item.quantity}`;
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
