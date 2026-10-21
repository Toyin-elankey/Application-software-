import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { formatNaira } from '@/lib/money';
import { claimKey, hashIdempotencyKey, releaseKey, requestFingerprint } from '@/server/idempotency/keys';
import { AppError } from '@/server/http/problem';
import type { TenantScope } from '@/server/tenant';
import { initialisePayment } from './initialise';
import type { PaymentProvider } from './provider';

// Retrying a failed payment (06 §3, §4.1, §4.5). The customer may pay again while the reservation holds.
//
// Rules:
// - At most one payment is open (INITIALIZED or PENDING) per order. A second open payment is never created.
// - A payment that is already SUCCEEDED ends the retry: the order is paid (409 already_paid).
// - The new payment has a new reference. §4.1 forbids reusing a reference, so the retry is a new transaction
//   and not a second authorisation on the old reference (06 §3's diagram says "same reference"; §4.1 wins).
// - The amount is the order total in the database, never a value from the request.
// - The order row is locked while the decision is made, so two parallel retries cannot both create a payment.
// - The provider call runs after the commit, as at checkout. If it fails, the payment stays INITIALIZED and the
//   next request resumes it. Nothing is charged, so the customer is not told the payment failed for good.

export const PAYMENT_RETRY_SCOPE = 'payment.retry';
const TX_OPTIONS = { timeout: 15_000, maxWait: 10_000 };

export type RetryPlan = { kind: 'paid' } | { kind: 'resume'; paymentId: string } | { kind: 'create' };

/** Decides what a retry does, from the order's payments, newest first. Pure, so it can be unit-tested. */
export function planRetry(payments: readonly { id: string; status: string }[]): RetryPlan {
  if (payments.some((p) => p.status === 'SUCCEEDED')) return { kind: 'paid' };
  const open = payments.find((p) => p.status === 'INITIALIZED' || p.status === 'PENDING');
  if (open) return { kind: 'resume', paymentId: open.id };
  return { kind: 'create' };
}

export type PaymentView = {
  id: string;
  status: string;
  /** Offered only while the provider transaction is open (PENDING). */
  authorizationUrl: string | null;
  amountMinor: bigint;
  amountDisplay: string;
};

export type PaymentRetryResult = { status: 200 | 201; body: { orderNumber: string; payment: PaymentView } };

export async function retryPayment(
  db: PrismaClient,
  scope: TenantScope,
  args: { orderId: string; orderNumber: string; idempotencyKey: string; provider: PaymentProvider; now?: Date },
): Promise<PaymentRetryResult> {
  const now = args.now ?? new Date();
  const keyHash = hashIdempotencyKey(args.idempotencyKey);
  const requestHash = requestFingerprint({ orderId: args.orderId, purpose: 'payment.retry' });
  const claim = await claimKey(db, scope, { scope: PAYMENT_RETRY_SCOPE, keyHash, requestHash, now });

  if (claim.kind === 'replay') {
    const stored = claim.responseBody as { paymentId: string };
    return {
      status: claim.responseStatus === 201 ? 201 : 200,
      body: { orderNumber: args.orderNumber, payment: await paymentView(db, scope, stored.paymentId) },
    };
  }

  let paymentId: string;
  let created: boolean;
  try {
    ({ paymentId, created } = await db.$transaction(
      (tx) => decideInTransaction(tx, scope, args.orderId, args.provider, now),
      TX_OPTIONS,
    ));
  } catch (error) {
    await releaseKey(db, claim.keyId);
    throw error;
  }

  try {
    await initialisePayment(db, scope, paymentId, args.provider);
  } catch (error) {
    // Nothing was charged. Release the key so the customer can ask again; the INITIALIZED payment is resumed.
    await releaseKey(db, claim.keyId);
    throw new AppError(502, 'payment_provider_unavailable', 'We could not reach the payment provider. Nothing was charged. Please try again in a moment.', {}, { cause: error });
  }

  const status = created ? 201 : 200;
  await db.idempotencyKey.update({
    where: { id: claim.keyId },
    data: { state: 'COMPLETED', responseStatus: status, responseBody: { paymentId } },
  });
  return { status, body: { orderNumber: args.orderNumber, payment: await paymentView(db, scope, paymentId) } };
}

async function decideInTransaction(
  tx: Prisma.TransactionClient,
  scope: TenantScope,
  orderId: string,
  provider: PaymentProvider,
  now: Date,
): Promise<{ paymentId: string; created: boolean }> {
  // Lock the order first. Every retry for this order queues behind this row.
  const [order] = await tx.$queryRaw<{ id: string; status: string; reservationExpiresAt: Date | null; totalMinor: bigint }[]>`
    SELECT id, status, \"reservationExpiresAt\", \"totalMinor\" FROM \"Order\"
    WHERE id = ${orderId}::uuid AND \"businessId\" = ${scope.businessId}::uuid FOR UPDATE`;
  if (!order) throw new AppError(404, 'order_not_found', 'Order not found.');
  if (order.status !== 'PENDING_PAYMENT') {
    throw new AppError(422, 'order_not_payable', 'This order can no longer be paid.');
  }
  if (!order.reservationExpiresAt || order.reservationExpiresAt <= now) {
    throw new AppError(422, 'reservation_expired', 'The stock reservation for this order has expired, so it cannot be paid. Please place a new order.');
  }

  const payments = await tx.payment.findMany({
    where: { orderId, businessId: scope.businessId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true },
  });
  const plan = planRetry(payments);
  if (plan.kind === 'paid') throw new AppError(409, 'already_paid', 'This order has already been paid.');
  if (plan.kind === 'resume') return { paymentId: plan.paymentId, created: false };

  const payment = await tx.payment.create({
    data: {
      id: randomUUID(),
      businessId: scope.businessId,
      orderId,
      provider: provider.name,
      reference: `pay_${randomUUID().replace(/-/g, '')}`,
      status: 'INITIALIZED',
      amountMinor: order.totalMinor,
      currency: 'NGN',
      initializedAt: now,
    },
    select: { id: true },
  });
  return { paymentId: payment.id, created: true };
}

async function paymentView(db: PrismaClient, scope: TenantScope, paymentId: string): Promise<PaymentView> {
  const payment = await db.payment.findFirst({
    where: { id: paymentId, businessId: scope.businessId },
    select: { id: true, status: true, authorizationUrl: true, amountMinor: true },
  });
  if (!payment) throw new AppError(404, 'payment_not_found', 'Payment not found.');
  return {
    id: payment.id,
    status: payment.status,
    authorizationUrl: payment.status === 'PENDING' ? payment.authorizationUrl : null,
    amountMinor: payment.amountMinor,
    amountDisplay: formatNaira(payment.amountMinor),
  };
}
