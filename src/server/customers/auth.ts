import type { Prisma, PrismaClient } from '@prisma/client';
import { AppError } from '@/server/http/problem';
import type { TenantScope } from '@/server/tenant';
import { invalidCode, otpHmacKey, verifyOtp } from './otp';
import { openCustomerSession, revokeCustomerSession, type CustomerAccess } from './sessions';

// Customer sign-in and order lookup, built on verified OTP codes. Nothing here marks an order paid or
// changes an order. It only decides who may read what.

export type CustomerRequestMeta = { ip: string | null; userAgent: string | null };

export async function customerAudit(
  tx: Prisma.TransactionClient | PrismaClient,
  businessId: string,
  customerId: string,
  action: string,
  entityType: string,
  entityId: string,
  meta: CustomerRequestMeta,
  now: Date,
  changes?: Prisma.InputJsonValue,
): Promise<void> {
  await tx.auditLog.create({
    data: {
      businessId,
      actorType: 'CUSTOMER',
      actorId: customerId,
      action,
      entityType,
      entityId,
      changes,
      ip: meta.ip,
      userAgent: meta.userAgent,
      createdAt: now,
    },
  });
}

/** Verifies a sign-in code, creates the customer on first use, and opens a 30-day sign-in session. */
export async function signInWithOtp(
  db: PrismaClient,
  input: { businessId: string; phoneE164: string; code: string } & CustomerRequestMeta,
  options: { now?: Date; key?: string } = {},
): Promise<{ token: string; expiresAt: Date }> {
  const now = options.now ?? new Date();
  await verifyOtp(db, { businessId: input.businessId, purpose: 'CUSTOMER_LOGIN', phoneE164: input.phoneE164, code: input.code }, options);

  return db.$transaction(async (tx) => {
    const existing = await tx.customer.findUnique({
      where: { businessId_phoneE164: { businessId: input.businessId, phoneE164: input.phoneE164 } },
      select: { id: true, anonymizedAt: true },
    });
    if (existing?.anonymizedAt) {
      throw new AppError(409, 'customer_erased', 'This phone number cannot be used to sign in. Please contact the shop.');
    }
    const customer = await tx.customer.upsert({
      where: { businessId_phoneE164: { businessId: input.businessId, phoneE164: input.phoneE164 } },
      create: { businessId: input.businessId, phoneE164: input.phoneE164, phoneVerifiedAt: now },
      update: { phoneVerifiedAt: now },
      select: { id: true },
    });
    const session = await openCustomerSession(tx, { customerId: customer.id, scopeOrderId: null, now });
    await customerAudit(tx, input.businessId, customer.id, 'CUSTOMER_SIGNED_IN', 'Customer', customer.id, input, now);
    return session;
  });
}

/**
 * Verifies the code sent to the phone on an order and opens a lookup session for that order only.
 * An unknown order number gets the same answer as a wrong code.
 */
export async function grantOrderLookup(
  db: PrismaClient,
  input: { businessId: string; orderNumber: string; code: string } & CustomerRequestMeta,
  options: { now?: Date; key?: string } = {},
): Promise<{ token: string; expiresAt: Date; orderId: string; orderNumber: string }> {
  const now = options.now ?? new Date();
  otpHmacKey(); // fail the same way for every request when the key is missing
  const order = await db.order.findFirst({
    where: { businessId: input.businessId, orderNumber: input.orderNumber },
    select: { id: true, orderNumber: true, customerId: true, customer: { select: { phoneE164: true, anonymizedAt: true } } },
  });
  if (!order || order.customer.anonymizedAt) throw invalidCode();

  await verifyOtp(
    db,
    { businessId: input.businessId, purpose: 'ORDER_LOOKUP', phoneE164: order.customer.phoneE164, code: input.code },
    options,
  );

  return db.$transaction(async (tx) => {
    const session = await openCustomerSession(tx, { customerId: order.customerId, scopeOrderId: order.id, now });
    await customerAudit(tx, input.businessId, order.customerId, 'ORDER_LOOKUP_GRANTED', 'Order', order.id, input, now);
    return { ...session, orderId: order.id, orderNumber: order.orderNumber };
  });
}

/** Ends the sessions named by the cookies in this request. Sign-in sessions are audited. */
export async function signOutCustomer(
  db: PrismaClient,
  input: { businessId: string; accesses: CustomerAccess[] } & CustomerRequestMeta,
  now = new Date(),
): Promise<void> {
  for (const access of input.accesses) {
    await revokeCustomerSession(db, access.sessionId, now);
    if (access.kind === 'sign-in') {
      await db.$transaction((tx) =>
        customerAudit(tx, input.businessId, access.customerId, 'CUSTOMER_SIGNED_OUT', 'Customer', access.customerId, input, now),
      );
    }
  }
}

/**
 * Decides whether any of the caller's sessions may read this order. A sign-in session may read the
 * customer's own orders. A lookup session may read only its one order. Both answer 404 for anything else,
 * so a caller cannot tell another customer's order from one that does not exist.
 */
export async function findOrderForCustomer(
  db: PrismaClient,
  scope: TenantScope,
  accesses: CustomerAccess[],
  orderNumber: string,
): Promise<{ id: string; orderNumber: string }> {
  const order = await db.order.findFirst({
    where: { businessId: scope.businessId, orderNumber },
    select: { id: true, orderNumber: true, customerId: true },
  });
  const allowed = order !== null && accesses.some((a) => a.customerId === order.customerId && (a.scopeOrderId === null || a.scopeOrderId === order.id));
  if (!order || !allowed) throw new AppError(404, 'order_not_found', 'Order not found.');
  return { id: order.id, orderNumber: order.orderNumber };
}
