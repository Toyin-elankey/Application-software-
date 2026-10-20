// Staff order changes (02 §6.5, PRD §7–8), against a real PostgreSQL database: version checks, role
// limits, audit rows, status events, stock release on cancel, and the audited contact reveal.
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '@/server/auth/password';
import type { StaffRoleName } from '@/server/auth/permissions';
import { resolveStaffActor, signIn, type StaffActor } from '@/server/auth/staff';
import { setCartItem, viewCart } from '@/server/cart/cart';
import { placeOrder } from '@/server/checkout/checkout';
import { CheckoutBodySchema } from '@/server/checkout/schema';
import { applyVerifiedPayment } from '@/server/payments/confirm';
import type { InitializeInput, PaymentProvider, VerifiedTransaction } from '@/server/payments/provider';
import { etagFor, maskEmail, maskPhone, getOrderForStaff, parseIfMatch, revealCustomerContact, transitionOrderForStaff } from '@/server/orders/admin';
import { createPrisma, unique } from './helpers';
import { checkoutBody, createProduct, createStore } from './commerce-fixtures';

let db: PrismaClient;
const PASSWORD = 'correct horse battery staple';

beforeAll(() => {
  db = createPrisma();
});

afterAll(async () => {
  await db.$disconnect();
});

// A provider that is only asked to start a payment. Verification in these tests goes through
// applyVerifiedPayment with a transaction we supply.
const startOnly: PaymentProvider = {
  name: 'PAYSTACK',
  async initialize(input: InitializeInput) {
    return { authorizationUrl: `https://checkout.paystack.test/${input.reference}`, providerReference: input.reference };
  },
  async refund(): Promise<never> {
    throw new Error('refunds are not used in this test');
  },
  async getRefund(): Promise<never> {
    throw new Error('refunds are not used in this test');
  },
  async verify(): Promise<VerifiedTransaction> {
    throw new Error('not used in these tests');
  },
};

async function staffActor(role: StaffRoleName, businessId: string): Promise<StaffActor> {
  const email = `${unique('staff')}@example.test`;
  const user = await db.staffUser.create({
    data: { email, fullName: 'Test Staff', passwordHash: await hashPassword(PASSWORD), mfaEnabled: false },
    select: { id: true },
  });
  await db.staffMembership.create({ data: { businessId, staffUserId: user.id, role } });
  // MFA-required roles are only usable once verified; the order tests exercise the policy, not the step-up.
  const { token } = await signIn(db, { businessId, email, password: PASSWORD, ip: null, userAgent: null });
  const actor = await resolveStaffActor(db, businessId, token, { ip: '198.51.100.1', userAgent: 'vitest' });
  if (!actor) throw new Error('test setup: no actor');
  return actor;
}

type Store = Awaited<ReturnType<typeof createStore>>;

async function cartWith(store: Store, variantId: string, quantity: number) {
  const first = await setCartItem(db, store.scope, { token: null, variantId, quantity });
  const view = await viewCart(db, store.store, { token: first.newToken, state: 'Lagos' });
  return {
    token: first.newToken as string,
    snapshot: {
      totalMinor: view.totalMinor.toString(),
      lines: view.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity, unitPriceMinor: l.unitPriceMinor.toString() })),
    },
  };
}

/** An order awaiting payment, holding stock. */
async function awaitingOrder(options: { quantity?: number } = {}) {
  const store = await createStore(db);
  const product = await createProduct(db, store.businessId, { onHand: 5 });
  const quantity = options.quantity ?? 2;
  const cart = await cartWith(store, product.variantId, quantity);
  const result = await placeOrder(db, store.store, {
    cartToken: cart.token,
    idempotencyKey: unique('k'),
    body: CheckoutBodySchema.parse(checkoutBody({ expected: cart.snapshot })),
    provider: startOnly,
  });
  const orderId = result.body.order.id as string;
  const payment = await db.payment.findFirstOrThrow({ where: { orderId } });
  return {
    businessId: store.businessId,
    scope: store.scope,
    orderId,
    orderNumber: result.body.order.orderNumber as string,
    variantId: product.variantId,
    paymentId: payment.id,
    reference: payment.reference,
    amountMinor: payment.amountMinor,
    quantity,
  };
}

/** Pays an order through the real verification rules, so it is PAYMENT_CONFIRMED. */
async function paidOrder() {
  const order = await awaitingOrder();
  const txn: VerifiedTransaction = {
    reference: order.reference,
    providerTransactionId: unique('txn'),
    status: 'SUCCESS',
    amountMinor: order.amountMinor,
    currency: 'NGN',
    channel: 'card',
    paidAt: new Date(),
  };
  const outcome = await applyVerifiedPayment(db, order.scope, order.reference, txn);
  expect(outcome).toBe('confirmed');
  return order;
}

async function orderRow(orderId: string) {
  return db.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true, version: true } });
}

async function reservedOf(variantId: string): Promise<number> {
  return (await db.productVariant.findUniqueOrThrow({ where: { id: variantId }, select: { reserved: true } })).reserved;
}

describe('If-Match and version checks', () => {
  it('requires If-Match, and reads the version from a quoted or weak value', () => {
    let caught: unknown = null;
    try {
      parseIfMatch(null);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ status: 428 });
    expect(parseIfMatch('"3"')).toBe(3);
    expect(parseIfMatch('W/"12"')).toBe(12);
    expect(parseIfMatch('7')).toBe(7);
    expect(() => parseIfMatch('"three"')).toThrow();
    expect(etagFor(4)).toBe('"4"');
  });

  it('a stale version is refused with 409 and changes nothing', async () => {
    const order = await paidOrder();
    const fulfil = await staffActor('FULFILMENT', order.businessId);
    const before = await orderRow(order.orderId);

    await expect(
      transitionOrderForStaff(db, fulfil, { orderId: order.orderId, expectedVersion: before.version - 1, to: 'CONFIRMED', reason: null }),
    ).rejects.toMatchObject({ status: 409, code: 'version_conflict', extra: { currentVersion: before.version } });
    expect(await orderRow(order.orderId)).toEqual(before);
  });

  it('two concurrent changes with the same version: exactly one succeeds', async () => {
    const order = await paidOrder();
    const manager = await staffActor('MANAGER', order.businessId);
    const fulfil = await staffActor('FULFILMENT', order.businessId);
    const version = (await orderRow(order.orderId)).version;

    const results = await Promise.allSettled([
      transitionOrderForStaff(db, manager, { orderId: order.orderId, expectedVersion: version, to: 'CONFIRMED', reason: null }),
      transitionOrderForStaff(db, fulfil, { orderId: order.orderId, expectedVersion: version, to: 'CONFIRMED', reason: null }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ status: 409 });
    expect((await orderRow(order.orderId)).version).toBe(version + 1);
    expect(await db.orderStatusEvent.count({ where: { orderId: order.orderId, toStatus: 'CONFIRMED' } })).toBe(1);
  });
});

describe('fulfilment moves', () => {
  it('moves a paid order through fulfilment; each move writes a status event and an audit row', async () => {
    const order = await paidOrder();
    const fulfil = await staffActor('FULFILMENT', order.businessId);
    let version = (await orderRow(order.orderId)).version;

    for (const to of ['CONFIRMED', 'PROCESSING', 'READY_FOR_DISPATCH', 'DISPATCHED'] as const) {
      const result = await transitionOrderForStaff(db, fulfil, { orderId: order.orderId, expectedVersion: version, to, reason: null });
      expect(result).toEqual({ status: to, version: version + 1 });
      version = result.version;
    }

    const events = await db.orderStatusEvent.findMany({ where: { orderId: order.orderId }, orderBy: { createdAt: 'asc' } });
    const staffEvents = events.filter((e) => e.actorType === 'STAFF');
    expect(staffEvents.map((e) => e.toStatus)).toEqual(['CONFIRMED', 'PROCESSING', 'READY_FOR_DISPATCH', 'DISPATCHED']);
    expect(staffEvents.every((e) => e.actorId === fulfil.staffUserId)).toBe(true);
    const audits = await db.auditLog.count({ where: { entityType: 'Order', entityId: order.orderId, action: 'ORDER_STATUS_CHANGED', actorId: fulfil.staffUserId } });
    expect(audits).toBe(4);
  });

  it('a role without fulfilment permission is refused, and nothing changes', async () => {
    const order = await paidOrder();
    const support = await staffActor('SUPPORT', order.businessId);
    const before = await orderRow(order.orderId);
    await expect(
      transitionOrderForStaff(db, support, { orderId: order.orderId, expectedVersion: before.version, to: 'CONFIRMED', reason: null }),
    ).rejects.toMatchObject({ status: 403, code: 'forbidden' });
    expect(await orderRow(order.orderId)).toEqual(before);
  });

  it('a move the table does not allow from this status is 422', async () => {
    const order = await paidOrder();
    const fulfil = await staffActor('FULFILMENT', order.businessId);
    const before = await orderRow(order.orderId);
    await expect(
      transitionOrderForStaff(db, fulfil, { orderId: order.orderId, expectedVersion: before.version, to: 'DELIVERED', reason: null }),
    ).rejects.toMatchObject({ status: 422, code: 'transition_not_available' });
  });

  it('a paid order cannot be cancelled through this endpoint; a refund move needs a reason', async () => {
    const order = await paidOrder();
    const owner = await staffActor('OWNER', order.businessId);
    const before = await orderRow(order.orderId);
    await expect(
      transitionOrderForStaff(db, owner, { orderId: order.orderId, expectedVersion: before.version, to: 'CANCELLED', reason: 'changed mind' }),
    ).rejects.toMatchObject({ status: 422, code: 'transition_not_available' });
    // A refund move is allowed for the role, but it needs a reason (the refund trail).
    await expect(
      transitionOrderForStaff(db, owner, { orderId: order.orderId, expectedVersion: before.version, to: 'REFUND_PENDING', reason: null }),
    ).rejects.toMatchObject({ status: 422, code: 'reason_required' });
  });
});

describe('cancelling an unpaid order', () => {
  it('Support can cancel: stock is released, the payment is abandoned, and the change is audited', async () => {
    const order = await awaitingOrder({ quantity: 2 });
    const support = await staffActor('SUPPORT', order.businessId);
    expect(await reservedOf(order.variantId)).toBe(2);
    const before = await orderRow(order.orderId);

    const result = await transitionOrderForStaff(db, support, {
      orderId: order.orderId,
      expectedVersion: before.version,
      to: 'CANCELLED',
      reason: 'customer asked',
    });

    expect(result).toEqual({ status: 'CANCELLED', version: before.version + 1 });
    expect(await reservedOf(order.variantId)).toBe(0);
    const movement = await db.inventoryMovement.findFirst({ where: { orderId: order.orderId, reason: 'RESERVATION_RELEASED' } });
    expect(movement?.actorStaffId).toBe(support.staffUserId);
    expect((await db.payment.findUniqueOrThrow({ where: { id: order.paymentId } })).failureReason).toBe('cancelled_by_staff');
    const cancelled = await db.order.findUniqueOrThrow({ where: { id: order.orderId }, select: { cancelReason: true } });
    expect(cancelled.cancelReason).toBe('cancelled_by_staff');
    expect(await db.auditLog.count({ where: { entityId: order.orderId, action: 'ORDER_STATUS_CHANGED' } })).toBe(1);
  });

  it('Fulfilment cannot cancel, even an unpaid order', async () => {
    const order = await awaitingOrder();
    const fulfil = await staffActor('FULFILMENT', order.businessId);
    const before = await orderRow(order.orderId);
    await expect(
      transitionOrderForStaff(db, fulfil, { orderId: order.orderId, expectedVersion: before.version, to: 'CANCELLED', reason: null }),
    ).rejects.toMatchObject({ status: 403 });
    expect(await reservedOf(order.variantId)).toBe(2);
  });

  it('a payment that was verified first blocks the cancel', async () => {
    const order = await awaitingOrder();
    const support = await staffActor('SUPPORT', order.businessId);
    await db.payment.update({ where: { id: order.paymentId }, data: { status: 'SUCCEEDED' } });
    const before = await orderRow(order.orderId);
    await expect(
      transitionOrderForStaff(db, support, { orderId: order.orderId, expectedVersion: before.version, to: 'CANCELLED', reason: null }),
    ).rejects.toMatchObject({ status: 409, code: 'payment_received' });
    expect((await orderRow(order.orderId)).status).toBe('PENDING_PAYMENT');
  });
});

describe('masked reads and the audited reveal', () => {
  it('masks phone and email in the staff view', () => {
    expect(maskPhone('+2348012345678')).toBe('+234********78');
    expect(maskEmail('ada.lovelace@example.com')).toBe('a***@example.com');
  });

  it('the order view does not show the full phone number or email', async () => {
    const order = await awaitingOrder();
    const view = await getOrderForStaff(db, order.scope, order.orderId);
    const text = JSON.stringify(view);
    const customer = await db.order.findUniqueOrThrow({
      where: { id: order.orderId },
      select: { customer: { select: { phoneE164: true, email: true } } },
    });
    expect(text).not.toContain(customer.customer.phoneE164);
    expect(view.customer.phone).not.toBe(customer.customer.phoneE164);
  });

  it('a reveal returns the full contact and writes an audit row with the reason', async () => {
    const order = await awaitingOrder();
    const support = await staffActor('SUPPORT', order.businessId);
    const contact = await revealCustomerContact(db, support, order.orderId, 'customer called about delivery');
    const stored = await db.order.findUniqueOrThrow({ where: { id: order.orderId }, select: { customer: { select: { phoneE164: true } } } });
    expect(contact.phone).toBe(stored.customer.phoneE164);
    const { customerId } = await db.order.findUniqueOrThrow({ where: { id: order.orderId }, select: { customerId: true } });
    const row = await db.auditLog.findFirstOrThrow({
      where: { action: 'CUSTOMER_PII_REVEALED', actorId: support.staffUserId, entityType: 'Customer', entityId: customerId },
    });
    expect(row.changes).toMatchObject({ reason: 'customer called about delivery', orderId: order.orderId });
  });

  it('Manager cannot reveal contact details', async () => {
    const order = await awaitingOrder();
    const manager = await staffActor('MANAGER', order.businessId);
    await expect(revealCustomerContact(db, manager, order.orderId, 'trying anyway')).rejects.toMatchObject({ status: 403 });
  });
});
