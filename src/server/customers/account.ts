import type { ConsentPurpose, PrismaClient } from '@prisma/client';
import { formatNaira } from '@/lib/money';
import { AppError } from '@/server/http/problem';
import type { CustomerAccess } from './sessions';
import { cancelUnpaidOrderTx } from '@/server/orders/cancel';
import { canTransition } from '@/server/orders/stateMachine';
import type { TenantScope } from '@/server/tenant';
import { customerAudit, type CustomerRequestMeta } from './auth';
import { CONSENT_POLICY_VERSION, CONSENT_SOURCE_ACCOUNT, customerMayCancel, notificationTypesFor } from './consent';
import type { OtpSender } from './delivery';
import { requestOtp, verifyOtp, type OtpRequestResult } from './otp';

// The signed-in customer's own account actions: order history, cancelling their order, and consents.
// Every function takes the customer id from the verified session, never from the request body, and
// answers 404 for an order that is not theirs.

export type OwnedOrder = { id: string; orderNumber: string; status: string; version: number; phoneE164: string };

/**
 * The account routes need the customer's sign-in session. A lookup session (one order, 30 minutes) is not
 * enough to list history, cancel or change consents. Answers 401 without one.
 */
export function requireSignIn(accesses: CustomerAccess[]): CustomerAccess {
  const signIn = accesses.find((access) => access.kind === 'sign-in');
  if (!signIn) throw new AppError(401, 'unauthenticated', 'Sign in to see your account.');
  return signIn;
}

async function loadOwnedOrder(db: PrismaClient, scope: TenantScope, customerId: string, orderNumber: string): Promise<OwnedOrder> {
  const order = await db.order.findFirst({
    where: { businessId: scope.businessId, orderNumber, customerId },
    select: { id: true, orderNumber: true, status: true, version: true, customer: { select: { phoneE164: true } } },
  });
  if (!order) throw new AppError(404, 'order_not_found', 'Order not found.');
  return { id: order.id, orderNumber: order.orderNumber, status: order.status, version: order.version, phoneE164: order.customer.phoneE164 };
}

/** The customer's orders, newest first. Each row says whether the customer may still cancel it. */
export async function listCustomerOrders(db: PrismaClient, scope: TenantScope, customerId: string, limit = 20) {
  const rows = await db.order.findMany({
    where: { businessId: scope.businessId, customerId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit,
    select: { orderNumber: true, status: true, totalMinor: true, createdAt: true, _count: { select: { items: true } } },
  });
  return rows.map((row) => ({
    orderNumber: row.orderNumber,
    status: row.status,
    totalMinor: row.totalMinor.toString(),
    totalDisplay: formatNaira(row.totalMinor),
    placedAt: row.createdAt.toISOString(),
    itemCount: row._count.items,
    canCancel: customerMayCancel(row.status),
  }));
}

/**
 * Sends the code that authorises a cancellation (the "recent OTP" in 02 §6.2). It goes to the phone on the
 * order, under the same limits as sign-in. Refused for orders that can no longer be cancelled from the account.
 */
export async function requestCancelCode(
  db: PrismaClient,
  sender: OtpSender,
  scope: TenantScope,
  input: { customerId: string; orderNumber: string },
  options: { now?: Date; key?: string } = {},
): Promise<OtpRequestResult> {
  const order = await loadOwnedOrder(db, scope, input.customerId, input.orderNumber);
  if (!customerMayCancel(order.status)) {
    throw new AppError(422, 'order_not_cancellable', 'This order can no longer be cancelled here. Please contact the shop.');
  }
  return requestOtp(db, sender, { businessId: scope.businessId, purpose: 'ORDER_CANCEL', phoneE164: order.phoneE164 }, options);
}

export type CustomerCancelResult = { orderNumber: string; status: 'CANCELLED' | 'REFUND_PENDING'; refundPending: boolean };

/**
 * Cancels the customer's order after a correct, unused cancel code (02 §6.2). An unpaid order is cancelled
 * and its stock released (FR-CHK-04). A paid order moves to REFUND_PENDING (FR-ORD-06); the refund itself is
 * requested by staff. A wrong or reused code is refused as an invalid code, and the attempt is counted.
 */
export async function cancelOrderAsCustomer(
  db: PrismaClient,
  scope: TenantScope,
  input: { customerId: string; orderNumber: string; code: string } & CustomerRequestMeta,
  options: { now?: Date; key?: string } = {},
): Promise<CustomerCancelResult> {
  const now = options.now ?? new Date();
  const meta: CustomerRequestMeta = { ip: input.ip, userAgent: input.userAgent };
  const order = await loadOwnedOrder(db, scope, input.customerId, input.orderNumber);
  if (!customerMayCancel(order.status)) {
    throw new AppError(422, 'order_not_cancellable', 'This order can no longer be cancelled here. Please contact the shop.');
  }

  await verifyOtp(db, { businessId: scope.businessId, purpose: 'ORDER_CANCEL', phoneE164: order.phoneE164, code: input.code }, options);

  return db.$transaction(
    async (tx) => {
      // Lock the payments, then the order: the same order the payment and expiry paths use, so they cannot deadlock.
      await tx.$queryRaw`SELECT id FROM \"Payment\" WHERE \"orderId\" = ${order.id}::uuid AND \"businessId\" = ${scope.businessId}::uuid ORDER BY id FOR UPDATE`;
      const [locked] = await tx.$queryRaw<{ status: string; version: number }[]>`
        SELECT status::text AS status, version FROM \"Order\"
        WHERE id = ${order.id}::uuid AND \"businessId\" = ${scope.businessId}::uuid FOR UPDATE`;
      if (!locked || !customerMayCancel(locked.status)) {
        throw new AppError(409, 'transition_refused', 'This order can no longer be cancelled. Please refresh.');
      }

      if (locked.status === 'PENDING_PAYMENT') {
        const outcome = await cancelUnpaidOrderTx(tx, scope, order.id, {
          now,
          reason: 'cancelled_by_customer',
          failureReason: 'cancelled_by_customer',
          actorType: 'CUSTOMER',
          actorId: input.customerId,
        });
        if (outcome === 'already_paid') {
          throw new AppError(409, 'payment_received', 'A payment was received for this order, so it cannot be cancelled here. Please contact the shop.');
        }
        if (outcome !== 'cancelled') throw new AppError(409, 'transition_refused', 'This order can no longer be cancelled. Please refresh.');
        await customerAudit(tx, scope.businessId, input.customerId, 'ORDER_CANCELLED_BY_CUSTOMER', 'Order', order.id, meta, now, {
          from: 'PENDING_PAYMENT',
          to: 'CANCELLED',
        });
        return { orderNumber: order.orderNumber, status: 'CANCELLED', refundPending: false };
      }

      // PAYMENT_CONFIRMED: a paid cancellation is a refund, not a cancellation (PRD §7).
      const rule = canTransition('PAYMENT_CONFIRMED', 'REFUND_PENDING', 'CUSTOMER', { paid: true });
      if (!rule.ok) throw new AppError(422, 'transition_refused', rule.reason);
      const moved = await tx.order.updateMany({
        where: { id: order.id, businessId: scope.businessId, version: locked.version, status: 'PAYMENT_CONFIRMED' },
        data: { status: 'REFUND_PENDING', version: { increment: 1 } },
      });
      if (moved.count !== 1) throw new AppError(409, 'version_conflict', 'This order changed. Reload it and try again.');
      await tx.orderStatusEvent.create({
        data: {
          orderId: order.id,
          fromStatus: 'PAYMENT_CONFIRMED',
          toStatus: 'REFUND_PENDING',
          actorType: 'CUSTOMER',
          actorId: input.customerId,
          reason: 'cancelled_by_customer',
        },
      });
      await customerAudit(tx, scope.businessId, input.customerId, 'ORDER_CANCELLED_BY_CUSTOMER', 'Order', order.id, meta, now, {
        from: 'PAYMENT_CONFIRMED',
        to: 'REFUND_PENDING',
      });
      return { orderNumber: order.orderNumber, status: 'REFUND_PENDING', refundPending: true };
    },
    { timeout: 15_000, maxWait: 10_000 },
  );
}

/**
 * Records a consent decision as a new row (append-only; the latest row per purpose is current, 03). Withdrawing
 * cancels that purpose's queued notifications (05 §2.6). Sent ones are left alone.
 */
export async function recordConsent(
  db: PrismaClient,
  scope: TenantScope,
  input: { customerId: string; purpose: ConsentPurpose; granted: boolean } & CustomerRequestMeta,
  options: { now?: Date } = {},
): Promise<{ purpose: ConsentPurpose; granted: boolean; recordedAt: string; cancelledNotifications: number }> {
  const now = options.now ?? new Date();
  const meta: CustomerRequestMeta = { ip: input.ip, userAgent: input.userAgent };
  return db.$transaction(async (tx) => {
    await tx.consentRecord.create({
      data: {
        businessId: scope.businessId,
        customerId: input.customerId,
        purpose: input.purpose,
        granted: input.granted,
        source: CONSENT_SOURCE_ACCOUNT,
        policyVersion: CONSENT_POLICY_VERSION,
        createdAt: now,
      },
    });

    let cancelledNotifications = 0;
    const types = notificationTypesFor(input.purpose);
    if (!input.granted && types.length > 0) {
      const cancelled = await tx.whatsAppNotification.updateMany({
        where: { businessId: scope.businessId, customerId: input.customerId, type: { in: [...types] }, status: 'PENDING' },
        data: { status: 'CANCELLED' },
      });
      cancelledNotifications = cancelled.count;
    }

    await customerAudit(
      tx,
      scope.businessId,
      input.customerId,
      input.granted ? 'CONSENT_GRANTED' : 'CONSENT_WITHDRAWN',
      'Customer',
      input.customerId,
      meta,
      now,
      { purpose: input.purpose, cancelledNotifications },
    );
    return { purpose: input.purpose, granted: input.granted, recordedAt: now.toISOString(), cancelledNotifications };
  });
}
