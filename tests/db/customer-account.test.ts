import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setCartItem, viewCart } from '@/server/cart/cart';
import { placeOrder } from '@/server/checkout/checkout';
import { CheckoutBodySchema } from '@/server/checkout/schema';
import { cancelOrderAsCustomer, listCustomerOrders, recordConsent, requestCancelCode } from '@/server/customers/account';
import { signInWithOtp } from '@/server/customers/auth';
import type { OtpMessage, OtpSender } from '@/server/customers/delivery';
import { requestOtp, verifyOtp } from '@/server/customers/otp';
import { applyVerifiedPayment } from '@/server/payments/confirm';
import { MockPaymentProvider } from '@/server/payments/mock';
import { AppError } from '@/server/http/problem';
import { createPrisma, unique } from './helpers';
import { checkoutBody, createProduct, createStore } from './commerce-fixtures';

// The signed-in customer's account actions against a real PostgreSQL database: order list, cancelling with a
// recent code (02 §6.2), and consents (05 §2.6). Each test uses its own store and phone, so the OTP
// cooldown (60 s per phone) never crosses tests.

let db: PrismaClient;

beforeAll(() => {
  db = createPrisma();
});

afterAll(async () => {
  await db.$disconnect();
});

class CaptureSender implements OtpSender {
  readonly sent: OtpMessage[] = [];
  async send(message: OtpMessage): Promise<void> {
    this.sent.push(message);
  }
  last(): OtpMessage {
    const message = this.sent.at(-1);
    if (!message) throw new Error('no code was sent');
    return message;
  }
}

const META = { ip: null, userAgent: null };

function phone(): string {
  return `+23480${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
}

async function expectAppError(action: Promise<unknown>, status: number, code: string): Promise<void> {
  let caught: unknown;
  try {
    await action;
  } catch (error) {
    caught = error;
  }
  if (!(caught instanceof AppError)) throw new Error(`expected AppError ${code}, got ${String(caught)}`);
  expect({ status: caught.status, code: caught.code }).toEqual({ status, code });
}

async function placeTestOrder(store: Awaited<ReturnType<typeof createStore>>, provider: MockPaymentProvider, customerPhone: string) {
  const product = await createProduct(db, store.businessId, { priceMinor: 1500000n, onHand: 50 });
  const setItem = await setCartItem(db, store.scope, { token: null, variantId: product.variantId, quantity: 1 });
  const view = await viewCart(db, store.store, { token: setItem.newToken, state: 'Lagos' });
  const snapshot = {
    totalMinor: view.totalMinor.toString(),
    lines: view.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity, unitPriceMinor: l.unitPriceMinor.toString() })),
  };
  const body = CheckoutBodySchema.parse(checkoutBody({ phone: customerPhone, expected: snapshot }));
  const result = await placeOrder(db, store.store, { cartToken: setItem.newToken, idempotencyKey: unique('key'), body, provider });
  const order = await db.order.findUniqueOrThrow({ where: { id: result.body.order.id as string }, select: { id: true, orderNumber: true, customerId: true } });
  const payment = await db.payment.findFirstOrThrow({ where: { orderId: order.id }, orderBy: { createdAt: 'desc' } });
  return { id: order.id, orderNumber: order.orderNumber, customerId: order.customerId, reference: payment.reference, variantId: product.variantId };
}

/** Pays an order through the same server-side verification the payment webhook uses. */
async function payOrder(provider: MockPaymentProvider, scope: { businessId: string }, reference: string): Promise<void> {
  provider.simulate(reference, 'SUCCESS');
  const verified = await provider.verify(reference);
  expect(await applyVerifiedPayment(db, scope, reference, verified)).toBe('confirmed');
}

/** Moves an order past payment. The database requires paidAt once an order is paid (order_paid_invariant). */
async function setOrderStatus(orderId: string, status: 'CONFIRMED'): Promise<void> {
  await db.order.update({ where: { id: orderId }, data: { status, paidAt: new Date() } });
}

describe('order list', () => {
  it('lists only the customer\'s own orders, newest first, and says which can still be cancelled', async () => {
    const store = await createStore(db);
    const provider = new MockPaymentProvider();
    const mine = phone();
    const first = await placeTestOrder(store, provider, mine);
    const second = await placeTestOrder(store, provider, mine);
    const stranger = await placeTestOrder(store, provider, phone());
    await setOrderStatus(second.id, 'CONFIRMED');

    const list = await listCustomerOrders(db, store.scope, first.customerId);
    expect(list.map((o) => o.orderNumber)).toEqual([second.orderNumber, first.orderNumber]);
    expect(list.map((o) => o.canCancel)).toEqual([false, true]);
    // ₦15,000 of goods plus the ₦1,500 Lagos delivery fee.
    expect(list[1].totalMinor).toBe('1650000');
    expect(list[1].totalDisplay).toContain('16,500');
    expect(list[1].itemCount).toBe(1);
    expect(list.some((o) => o.orderNumber === stranger.orderNumber)).toBe(false);
  });
});

describe('requesting a cancel code', () => {
  it('sends the code to the phone on the order, for a cancellable order', async () => {
    const store = await createStore(db);
    const provider = new MockPaymentProvider();
    const number = phone();
    const order = await placeTestOrder(store, provider, number);
    const sender = new CaptureSender();

    await requestCancelCode(db, sender, store.scope, { customerId: order.customerId, orderNumber: order.orderNumber });
    expect(sender.sent).toHaveLength(1);
    expect(sender.last()).toMatchObject({ phoneE164: number, purpose: 'ORDER_CANCEL' });
    expect(sender.last().code).toMatch(/^\d{6}$/);
  });

  it('refuses for an order the customer can no longer cancel, and sends nothing', async () => {
    const store = await createStore(db);
    const provider = new MockPaymentProvider();
    const order = await placeTestOrder(store, provider, phone());
    await setOrderStatus(order.id, 'CONFIRMED');
    const sender = new CaptureSender();

    await expectAppError(requestCancelCode(db, sender, store.scope, { customerId: order.customerId, orderNumber: order.orderNumber }), 422, 'order_not_cancellable');
    expect(sender.sent).toHaveLength(0);
  });

  it('answers 404 for another customer\'s order, and sends nothing', async () => {
    const store = await createStore(db);
    const provider = new MockPaymentProvider();
    const mine = await placeTestOrder(store, provider, phone());
    const theirs = await placeTestOrder(store, provider, phone());
    const sender = new CaptureSender();

    await expectAppError(requestCancelCode(db, sender, store.scope, { customerId: mine.customerId, orderNumber: theirs.orderNumber }), 404, 'order_not_found');
    expect(sender.sent).toHaveLength(0);
  });
});

describe('cancelling an unpaid order', () => {
  it('with the right code: cancels, releases the stock, abandons the payment and records who did it', async () => {
    const store = await createStore(db);
    const provider = new MockPaymentProvider();
    const order = await placeTestOrder(store, provider, phone());
    const sender = new CaptureSender();
    await requestCancelCode(db, sender, store.scope, { customerId: order.customerId, orderNumber: order.orderNumber });
    const reservedBefore = (await db.productVariant.findUniqueOrThrow({ where: { id: order.variantId } })).reserved;

    const result = await cancelOrderAsCustomer(db, store.scope, { customerId: order.customerId, orderNumber: order.orderNumber, code: sender.last().code, ...META });
    expect(result).toEqual({ orderNumber: order.orderNumber, status: 'CANCELLED', refundPending: false });

    const after = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe('CANCELLED');
    expect(after.cancelReason).toBe('cancelled_by_customer');
    expect((await db.productVariant.findUniqueOrThrow({ where: { id: order.variantId } })).reserved).toBe(reservedBefore - 1);
    expect((await db.payment.findFirstOrThrow({ where: { orderId: order.id } })).status).toBe('ABANDONED');

    const movement = await db.inventoryMovement.findFirstOrThrow({ where: { orderId: order.id, reason: 'RESERVATION_RELEASED' } });
    expect(movement).toMatchObject({ actorType: 'CUSTOMER', actorStaffId: null, note: 'cancelled by customer' });
    const event = await db.orderStatusEvent.findFirstOrThrow({ where: { orderId: order.id, toStatus: 'CANCELLED' } });
    expect(event).toMatchObject({ actorType: 'CUSTOMER', actorId: order.customerId, reason: 'cancelled_by_customer' });
    const audit = await db.auditLog.findFirstOrThrow({ where: { entityId: order.id, action: 'ORDER_CANCELLED_BY_CUSTOMER' } });
    expect(audit.changes).toEqual({ from: 'PENDING_PAYMENT', to: 'CANCELLED' });
  });

  it('a wrong code is refused and counts as an attempt; the right code still works; a used code cannot be used again', async () => {
    const store = await createStore(db);
    const provider = new MockPaymentProvider();
    const number = phone();
    const order = await placeTestOrder(store, provider, number);
    const sender = new CaptureSender();
    await requestCancelCode(db, sender, store.scope, { customerId: order.customerId, orderNumber: order.orderNumber });
    const right = sender.last().code;
    const wrong = right === '000000' ? '111111' : '000000';
    await expectAppError(cancelOrderAsCustomer(db, store.scope, { customerId: order.customerId, orderNumber: order.orderNumber, code: wrong, ...META }), 422, 'otp_invalid');
    const challenge = await db.otpChallenge.findFirstOrThrow({ where: { phoneE164: number, purpose: 'ORDER_CANCEL' }, orderBy: { createdAt: 'desc' } });
    expect(challenge.attempts).toBe(1);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('PENDING_PAYMENT');

    await cancelOrderAsCustomer(db, store.scope, { customerId: order.customerId, orderNumber: order.orderNumber, code: right, ...META });
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('CANCELLED');
    // The code was consumed by that cancel, so the same code is refused anywhere it is checked again.
    await expectAppError(verifyOtp(db, { businessId: store.businessId, purpose: 'ORDER_CANCEL', phoneE164: number, code: right }), 422, 'otp_invalid');
  });

  it('parallel cancels with one code: exactly one succeeds, and the stock is released once', async () => {
    const store = await createStore(db);
    const provider = new MockPaymentProvider();
    const order = await placeTestOrder(store, provider, phone());
    const sender = new CaptureSender();
    await requestCancelCode(db, sender, store.scope, { customerId: order.customerId, orderNumber: order.orderNumber });
    const reservedBefore = (await db.productVariant.findUniqueOrThrow({ where: { id: order.variantId } })).reserved;
    const input = { customerId: order.customerId, orderNumber: order.orderNumber, code: sender.last().code, ...META };

    const results = await Promise.allSettled([cancelOrderAsCustomer(db, store.scope, input), cancelOrderAsCustomer(db, store.scope, input)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await db.productVariant.findUniqueOrThrow({ where: { id: order.variantId } })).reserved).toBe(reservedBefore - 1);
    expect(await db.orderStatusEvent.count({ where: { orderId: order.id, toStatus: 'CANCELLED' } })).toBe(1);
  });
});

describe('cancelling a paid order', () => {
  it('moves it to REFUND_PENDING, leaves the payment succeeded, and creates no refund (staff request it)', async () => {
    const store = await createStore(db);
    const provider = new MockPaymentProvider();
    const order = await placeTestOrder(store, provider, phone());
    await payOrder(provider, store.scope, order.reference);
    const sender = new CaptureSender();
    await requestCancelCode(db, sender, store.scope, { customerId: order.customerId, orderNumber: order.orderNumber });

    const result = await cancelOrderAsCustomer(db, store.scope, { customerId: order.customerId, orderNumber: order.orderNumber, code: sender.last().code, ...META });
    expect(result).toEqual({ orderNumber: order.orderNumber, status: 'REFUND_PENDING', refundPending: true });
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('REFUND_PENDING');
    expect((await db.payment.findFirstOrThrow({ where: { orderId: order.id } })).status).toBe('SUCCEEDED');
    expect(await db.refund.count({ where: { orderId: order.id } })).toBe(0);
    const event = await db.orderStatusEvent.findFirstOrThrow({ where: { orderId: order.id, toStatus: 'REFUND_PENDING' } });
    expect(event).toMatchObject({ fromStatus: 'PAYMENT_CONFIRMED', actorType: 'CUSTOMER', reason: 'cancelled_by_customer' });
  });

  it('an order that staff have confirmed can no longer be cancelled by the customer', async () => {
    const store = await createStore(db);
    const provider = new MockPaymentProvider();
    const order = await placeTestOrder(store, provider, phone());
    await payOrder(provider, store.scope, order.reference);
    await setOrderStatus(order.id, 'CONFIRMED');
    const sender = new CaptureSender();
    await expectAppError(requestCancelCode(db, sender, store.scope, { customerId: order.customerId, orderNumber: order.orderNumber }), 422, 'order_not_cancellable');
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('CONFIRMED');
  });
});

describe('consents', () => {
  it('appends each decision, and withdrawing order updates cancels only the pending ones', async () => {
    const store = await createStore(db);
    const provider = new MockPaymentProvider();
    const order = await placeTestOrder(store, provider, phone());
    const make = (status: 'PENDING' | 'SENT', type: 'ORDER_STATUS_UPDATE' | 'DELIVERY_UPDATE') =>
      db.whatsAppNotification.create({ data: { businessId: store.businessId, customerId: order.customerId, orderId: order.id, type, status, dedupeKey: unique('n') } });
    const pending = [await make('PENDING', 'ORDER_STATUS_UPDATE'), await make('PENDING', 'DELIVERY_UPDATE')];
    const sent = await make('SENT', 'ORDER_STATUS_UPDATE');

    const granted = await recordConsent(db, store.scope, { customerId: order.customerId, purpose: 'ORDER_UPDATES_WHATSAPP', granted: true, ...META });
    expect(granted).toMatchObject({ purpose: 'ORDER_UPDATES_WHATSAPP', granted: true, cancelledNotifications: 0 });

    const withdrawn = await recordConsent(db, store.scope, { customerId: order.customerId, purpose: 'ORDER_UPDATES_WHATSAPP', granted: false, ...META });
    expect(withdrawn.cancelledNotifications).toBe(2);
    const statuses = await db.whatsAppNotification.findMany({ where: { id: { in: [...pending, sent].map((n) => n.id) } }, select: { id: true, status: true } });
    const byId = new Map(statuses.map((n) => [n.id, n.status]));
    expect(byId.get(pending[0].id)).toBe('CANCELLED');
    expect(byId.get(pending[1].id)).toBe('CANCELLED');
    expect(byId.get(sent.id)).toBe('SENT');

    const rows = await db.consentRecord.findMany({ where: { customerId: order.customerId, purpose: 'ORDER_UPDATES_WHATSAPP' }, orderBy: { createdAt: 'asc' } });
    expect(rows.map((r) => r.granted)).toEqual([true, false]);
    expect(rows[1]).toMatchObject({ source: 'ACCOUNT_PAGE', policyVersion: '2026-10-stage5' });
    const audit = await db.auditLog.findFirstOrThrow({ where: { entityId: order.customerId, action: 'CONSENT_WITHDRAWN' } });
    expect(audit.changes).toEqual({ purpose: 'ORDER_UPDATES_WHATSAPP', cancelledNotifications: 2 });
  });

  it('withdrawing marketing records the decision and cancels nothing', async () => {
    const store = await createStore(db);
    const provider = new MockPaymentProvider();
    const order = await placeTestOrder(store, provider, phone());
    const queued = await db.whatsAppNotification.create({
      data: { businessId: store.businessId, customerId: order.customerId, type: 'ORDER_STATUS_UPDATE', status: 'PENDING', dedupeKey: unique('n') },
    });

    const result = await recordConsent(db, store.scope, { customerId: order.customerId, purpose: 'MARKETING_WHATSAPP', granted: false, ...META });
    expect(result.cancelledNotifications).toBe(0);
    expect((await db.whatsAppNotification.findUniqueOrThrow({ where: { id: queued.id } })).status).toBe('PENDING');
  });

  it('a customer who has signed in but placed no order can still record consents', async () => {
    const store = await createStore(db);
    const number = phone();
    const sender = new CaptureSender();
    await requestOtp(db, sender, { businessId: store.businessId, purpose: 'CUSTOMER_LOGIN', phoneE164: number });
    await signInWithOtp(db, { businessId: store.businessId, phoneE164: number, code: sender.last().code, ...META });
    const customer = await db.customer.findUniqueOrThrow({ where: { businessId_phoneE164: { businessId: store.businessId, phoneE164: number } } });

    const result = await recordConsent(db, store.scope, { customerId: customer.id, purpose: 'TERMS_AND_PRIVACY', granted: true, ...META });
    expect(result).toMatchObject({ granted: true, cancelledNotifications: 0 });
  });
});
