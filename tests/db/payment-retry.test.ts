import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setCartItem, viewCart } from '@/server/cart/cart';
import { placeOrder } from '@/server/checkout/checkout';
import { CheckoutBodySchema } from '@/server/checkout/schema';
import { findOrderForCustomer } from '@/server/customers/auth';
import type { CustomerAccess } from '@/server/customers/sessions';
import { applyVerifiedPayment } from '@/server/payments/confirm';
import { MockPaymentProvider } from '@/server/payments/mock';
import type { PaymentProvider } from '@/server/payments/provider';
import { retryPayment } from '@/server/payments/retry';
import { AppError } from '@/server/http/problem';
import { createPrisma, unique } from './helpers';
import { checkoutBody, createProduct, createStore } from './commerce-fixtures';

// Retrying a failed payment against a real PostgreSQL database (06 §3, §4.1, §4.5). Amounts are kobo.

let db: PrismaClient;
const PHONE = '+2348012345678';

beforeAll(() => {
  db = createPrisma();
});

afterAll(async () => {
  await db.$disconnect();
});

/** A provider whose first initialise call fails, as a timeout at the provider would. */
class FlakyProvider extends MockPaymentProvider {
  private failNext = true;
  override async initialize(input: Parameters<MockPaymentProvider['initialize']>[0]) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('provider timed out');
    }
    return super.initialize(input);
  }
}

async function placeTestOrder(store: Awaited<ReturnType<typeof createStore>>, provider: PaymentProvider, phone = PHONE) {
  const product = await createProduct(db, store.businessId, { priceMinor: 1500000n, onHand: 50 });
  const setItem = await setCartItem(db, store.scope, { token: null, variantId: product.variantId, quantity: 1 });
  const view = await viewCart(db, store.store, { token: setItem.newToken, state: 'Lagos' });
  const snapshot = {
    totalMinor: view.totalMinor.toString(),
    lines: view.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity, unitPriceMinor: l.unitPriceMinor.toString() })),
  };
  const body = CheckoutBodySchema.parse(checkoutBody({ phone, expected: snapshot }));
  const result = await placeOrder(db, store.store, { cartToken: setItem.newToken, idempotencyKey: unique('key'), body, provider });
  const payment = await db.payment.findFirstOrThrow({ where: { orderId: result.body.order.id }, orderBy: { createdAt: 'desc' } });
  return { id: result.body.order.id as string, orderNumber: result.body.order.orderNumber as string, reference: payment.reference, variantId: product.variantId };
}

/** Marks the order's current payment FAILED the way a real verification would. */
async function failPayment(provider: MockPaymentProvider, scope: { businessId: string }, reference: string) {
  provider.simulate(reference, 'FAILED');
  const verified = await provider.verify(reference);
  const outcome = await applyVerifiedPayment(db, scope, reference, verified);
  expect(outcome).toBe('failed');
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

describe('retrying a failed payment', () => {
  it('creates one new payment with a new reference, for the order total, while the order stays unpaid', async () => {
    const store = await createStore(db);
    const provider = new MockPaymentProvider();
    const order = await placeTestOrder(store, provider);
    await failPayment(provider, store.scope, order.reference);
    const before = await db.productVariant.findUniqueOrThrow({ where: { id: order.variantId } });

    const result = await retryPayment(db, store.scope, { orderId: order.id, orderNumber: order.orderNumber, idempotencyKey: unique('retry'), provider });
    expect(result.status).toBe(201);
    expect(result.body.payment.status).toBe('PENDING');
    expect(result.body.payment.authorizationUrl).toMatch(/\/dev\/mock-pay\/pay_/);
    expect(result.body.payment.amountMinor).toBe((await db.order.findUniqueOrThrow({ where: { id: order.id } })).totalMinor);

    const payments = await db.payment.findMany({ where: { orderId: order.id }, orderBy: { createdAt: 'asc' } });
    expect(payments.map((p) => p.status)).toEqual(['FAILED', 'PENDING']);
    expect(payments[1].reference).not.toBe(order.reference);

    const after = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe('PENDING_PAYMENT');
    const variant = await db.productVariant.findUniqueOrThrow({ where: { id: order.variantId } });
    expect(variant.reserved).toBe(before.reserved); // the reservation is not taken again
  });

  it('replays the same key with the same answer and creates nothing', async () => {
    const store = await createStore(db);
    const provider = new MockPaymentProvider();
    const order = await placeTestOrder(store, provider);
    await failPayment(provider, store.scope, order.reference);
    const key = unique('retry');

    const first = await retryPayment(db, store.scope, { orderId: order.id, orderNumber: order.orderNumber, idempotencyKey: key, provider });
    const second = await retryPayment(db, store.scope, { orderId: order.id, orderNumber: order.orderNumber, idempotencyKey: key, provider });
    expect(second.status).toBe(first.status);
    expect(second.body.payment.id).toBe(first.body.payment.id);
    expect(await db.payment.count({ where: { orderId: order.id } })).toBe(2);
  });

  it('resumes the open payment for a different key, rather than opening a second one', async () => {
    const store = await createStore(db);
    const provider = new MockPaymentProvider();
    const order = await placeTestOrder(store, provider);
    await failPayment(provider, store.scope, order.reference);
    const first = await retryPayment(db, store.scope, { orderId: order.id, orderNumber: order.orderNumber, idempotencyKey: unique('a'), provider });

    const second = await retryPayment(db, store.scope, { orderId: order.id, orderNumber: order.orderNumber, idempotencyKey: unique('b'), provider });
    expect(second.status).toBe(200);
    expect(second.body.payment.id).toBe(first.body.payment.id);
    expect(await db.payment.count({ where: { orderId: order.id } })).toBe(2);
  });

  it('refuses an Idempotency-Key that was used for a different order', async () => {
    const store = await createStore(db);
    const provider = new MockPaymentProvider();
    const one = await placeTestOrder(store, provider);
    const two = await placeTestOrder(store, provider, '+2348099990000');
    await failPayment(provider, store.scope, one.reference);
    await failPayment(provider, store.scope, two.reference);
    const key = unique('shared');
    await retryPayment(db, store.scope, { orderId: one.id, orderNumber: one.orderNumber, idempotencyKey: key, provider });
    await expectAppError(retryPayment(db, store.scope, { orderId: two.id, orderNumber: two.orderNumber, idempotencyKey: key, provider }), 422, 'idempotency_key_reused');
  });

  it('answers parallel retries with one new payment and no duplicates', async () => {
    const store = await createStore(db);
    const provider = new MockPaymentProvider();
    const order = await placeTestOrder(store, provider);
    await failPayment(provider, store.scope, order.reference);

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        retryPayment(db, store.scope, { orderId: order.id, orderNumber: order.orderNumber, idempotencyKey: unique('race'), provider }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(new Set(results.map((r) => r.body.payment.id)).size).toBe(1);
    expect(await db.payment.count({ where: { orderId: order.id } })).toBe(2);
  });

  it('refuses an expired reservation and a cancelled order, and creates nothing', async () => {
    const store = await createStore(db);
    const provider = new MockPaymentProvider();

    const expired = await placeTestOrder(store, provider);
    await failPayment(provider, store.scope, expired.reference);
    await db.order.update({ where: { id: expired.id }, data: { reservationExpiresAt: new Date(Date.now() - 60_000) } });
    await expectAppError(retryPayment(db, store.scope, { orderId: expired.id, orderNumber: expired.orderNumber, idempotencyKey: unique('x'), provider }), 422, 'reservation_expired');
    expect(await db.payment.count({ where: { orderId: expired.id } })).toBe(1);

    const cancelled = await placeTestOrder(store, provider);
    await failPayment(provider, store.scope, cancelled.reference);
    await db.order.update({ where: { id: cancelled.id }, data: { status: 'CANCELLED', cancelReason: 'customer_request' } });
    await expectAppError(retryPayment(db, store.scope, { orderId: cancelled.id, orderNumber: cancelled.orderNumber, idempotencyKey: unique('y'), provider }), 422, 'order_not_payable');
  });

  it('after a provider outage nothing is charged, the key is free again, and the next request resumes the same payment', async () => {
    const store = await createStore(db);
    const provider = new MockPaymentProvider();
    const order = await placeTestOrder(store, provider);
    await failPayment(provider, store.scope, order.reference);
    const flaky = new FlakyProvider();
    const key = unique('outage');

    await expectAppError(retryPayment(db, store.scope, { orderId: order.id, orderNumber: order.orderNumber, idempotencyKey: key, provider: flaky }), 502, 'payment_provider_unavailable');
    expect(await db.payment.count({ where: { orderId: order.id } })).toBe(2);
    const held = await db.idempotencyKey.count({ where: { businessId: store.businessId, scope: 'payment.retry' } });
    expect(held).toBe(0); // the claim was released

    const again = await retryPayment(db, store.scope, { orderId: order.id, orderNumber: order.orderNumber, idempotencyKey: key, provider: flaky });
    expect(again.status).toBe(200);
    expect(again.body.payment.authorizationUrl).toMatch(/\/dev\/mock-pay\//);
    expect(await db.payment.count({ where: { orderId: order.id } })).toBe(2);
  });

  it('the retried payment confirms the order through the same server-side verification', async () => {
    const store = await createStore(db);
    const provider = new MockPaymentProvider();
    const order = await placeTestOrder(store, provider);
    await failPayment(provider, store.scope, order.reference);
    const result = await retryPayment(db, store.scope, { orderId: order.id, orderNumber: order.orderNumber, idempotencyKey: unique('ok'), provider });

    const reference = (await db.payment.findUniqueOrThrow({ where: { id: result.body.payment.id } })).reference;
    provider.simulate(reference, 'SUCCESS');
    const outcome = await applyVerifiedPayment(db, store.scope, reference, await provider.verify(reference));
    expect(outcome).toBe('confirmed');
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('PAYMENT_CONFIRMED');

    await expectAppError(retryPayment(db, store.scope, { orderId: order.id, orderNumber: order.orderNumber, idempotencyKey: unique('late'), provider }), 422, 'order_not_payable');
  });

  it('only the order\'s own customer, or a lookup session for that order, may pay it', async () => {
    const store = await createStore(db);
    const provider = new MockPaymentProvider();
    const mine = await placeTestOrder(store, provider, PHONE);
    const other = await placeTestOrder(store, provider, '+2348099990000');
    const owner = await db.customer.findUniqueOrThrow({ where: { businessId_phoneE164: { businessId: store.businessId, phoneE164: PHONE } } });
    const session = (customerId: string, scopeOrderId: string | null): CustomerAccess => ({ customerId, scopeOrderId, sessionId: 's', kind: scopeOrderId ? 'order-lookup' : 'sign-in' });

    await expect(findOrderForCustomer(db, store.scope, [session(owner.id, null)], mine.orderNumber)).resolves.toMatchObject({ id: mine.id });
    await expectAppError(findOrderForCustomer(db, store.scope, [session(owner.id, null)], other.orderNumber), 404, 'order_not_found');
    await expectAppError(findOrderForCustomer(db, store.scope, [session(owner.id, other.id)], mine.orderNumber), 404, 'order_not_found');
    await expectAppError(findOrderForCustomer(db, store.scope, [], mine.orderNumber), 404, 'order_not_found');
  });
});
