// Reconciliation of stale payments (06 §4.5) and the customer's return page (06 §4.2), against a real
// PostgreSQL database. The provider is scripted: responses are fixed per reference, and an unscripted
// call throws a retryable error.
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GET as getPaymentReturn } from '@/app/orders/[orderNumber]/payment-return/route';
import { setCartItem, viewCart } from '@/server/cart/cart';
import { placeOrder } from '@/server/checkout/checkout';
import { CheckoutBodySchema } from '@/server/checkout/schema';
import type { InitializeInput, PaymentProvider, VerifiedTransaction } from '@/server/payments/provider';
import { PaystackError } from '@/server/payments/paystack';
import { reconcileStalePayments } from '@/server/payments/reconcile';
import { resolvePaymentReturn } from '@/server/payments/returnPage';
import { createPrisma, unique } from './helpers';
import { checkoutBody, createProduct, createStore } from './commerce-fixtures';

let db: PrismaClient;

beforeAll(() => {
  db = createPrisma();
});

afterAll(async () => {
  await db.$disconnect();
});

type Step = VerifiedTransaction | Error;

class ScriptedPaystack implements PaymentProvider {
  readonly name = 'PAYSTACK' as const;
  private readonly scripts = new Map<string, Step[]>();
  readonly calls = new Map<string, number>();

  script(reference: string, ...steps: Step[]): void {
    this.scripts.set(reference, [...steps]);
  }

  async initialize(input: InitializeInput) {
    return { authorizationUrl: `https://checkout.paystack.test/${input.reference}`, providerReference: input.reference };
  }

  async verify(reference: string): Promise<VerifiedTransaction> {
    this.calls.set(reference, (this.calls.get(reference) ?? 0) + 1);
    const step = this.scripts.get(reference)?.shift();
    if (!step) throw new PaystackError('no scripted response for this reference', 503, true);
    if (step instanceof Error) throw step;
    return step;
  }
}

const paystack = new ScriptedPaystack();

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

/** An unpaid order with one Paystack payment. `ageMinutes` back-dates the payment's creation. */
async function unpaidOrder(options: { ageMinutes?: number } = {}) {
  const store = await createStore(db);
  const product = await createProduct(db, store.businessId, { onHand: 5 });
  const cart = await cartWith(store, product.variantId, 1);
  const result = await placeOrder(db, store.store, {
    cartToken: cart.token,
    idempotencyKey: unique('k'),
    body: CheckoutBodySchema.parse(checkoutBody({ expected: cart.snapshot })),
    provider: paystack,
  });
  const orderId = result.body.order.id as string;
  const payment = await db.payment.findFirstOrThrow({ where: { orderId } });
  if (options.ageMinutes) {
    await db.payment.update({ where: { id: payment.id }, data: { createdAt: new Date(Date.now() - options.ageMinutes * 60_000) } });
  }
  return {
    businessId: store.businessId,
    scope: store.scope,
    orderId,
    orderNumber: result.body.order.orderNumber as string,
    paymentId: payment.id,
    reference: payment.reference,
    amountMinor: payment.amountMinor,
  };
}

function paidTxn(order: { reference: string; amountMinor: bigint }, overrides: Partial<VerifiedTransaction> = {}): VerifiedTransaction {
  return {
    reference: order.reference,
    providerTransactionId: unique('txn'),
    status: 'SUCCESS',
    amountMinor: order.amountMinor,
    currency: 'NGN',
    channel: 'card',
    paidAt: new Date(),
    ...overrides,
  };
}

async function orderStatus(orderId: string): Promise<string> {
  return (await db.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true } })).status;
}

async function paymentStatus(paymentId: string): Promise<string> {
  return (await db.payment.findUniqueOrThrow({ where: { id: paymentId }, select: { status: true } })).status;
}

describe('reconciliation of stale payments (06 §4.5)', () => {
  it('a payment pending for more than 10 minutes is verified, and a SUCCESS confirms the order', async () => {
    const order = await unpaidOrder({ ageMinutes: 15 });
    paystack.script(order.reference, paidTxn(order));

    const summary = await reconcileStalePayments(db, paystack, { businessId: order.businessId });

    expect(summary).toEqual({ checked: 1, confirmed: 1, unchanged: 0, deferred: 0 });
    expect(await orderStatus(order.orderId)).toBe('PAYMENT_CONFIRMED');
    expect(await paymentStatus(order.paymentId)).toBe('SUCCEEDED');
  });

  it('a payment created recently is not touched', async () => {
    const order = await unpaidOrder({ ageMinutes: 2 });

    const summary = await reconcileStalePayments(db, paystack, { businessId: order.businessId });

    expect(summary.checked).toBe(0);
    expect(paystack.calls.get(order.reference) ?? 0).toBe(0);
    expect(await orderStatus(order.orderId)).toBe('PENDING_PAYMENT');
  });

  it('a provider error defers the payment: nothing changes and it is checked again next run', async () => {
    const order = await unpaidOrder({ ageMinutes: 15 });
    paystack.script(order.reference, new PaystackError('provider unavailable', 503, true));

    const summary = await reconcileStalePayments(db, paystack, { businessId: order.businessId });

    expect(summary).toEqual({ checked: 1, confirmed: 0, unchanged: 0, deferred: 1 });
    expect(await orderStatus(order.orderId)).toBe('PENDING_PAYMENT');
    expect(await paymentStatus(order.paymentId)).toBe('PENDING');
  });
});

describe('customer return page (06 §4.2)', () => {
  it('returns not_found for a wrong order number, without calling the provider', async () => {
    const order = await unpaidOrder();
    const view = await resolvePaymentReturn(db, paystack, 'ORD-999999', order.reference);

    expect(view.kind).toBe('not_found');
    expect(paystack.calls.get(order.reference) ?? 0).toBe(0);
  });

  it('returns not_found for an unknown reference', async () => {
    const view = await resolvePaymentReturn(db, paystack, 'ORD-000000', unique('pay_missing'));
    expect(view.kind).toBe('not_found');
  });

  it('verifies on return: a SUCCESS confirms the order; a second visit changes nothing and does not call the provider again', async () => {
    const order = await unpaidOrder();
    paystack.script(order.reference, paidTxn(order));

    const first = await resolvePaymentReturn(db, paystack, order.orderNumber, order.reference);
    expect(first.kind).toBe('confirmed');
    expect(await orderStatus(order.orderId)).toBe('PAYMENT_CONFIRMED');

    const second = await resolvePaymentReturn(db, paystack, order.orderNumber, order.reference);
    expect(second.kind).toBe('confirmed');
    expect(paystack.calls.get(order.reference)).toBe(1);
  });

  it('a webhook that arrived first is shown as confirmed, with no provider call from the page', async () => {
    const order = await unpaidOrder();
    await db.payment.update({ where: { id: order.paymentId }, data: { status: 'SUCCEEDED' } });
    await db.order.update({ where: { id: order.orderId }, data: { status: 'PAYMENT_CONFIRMED', paidAt: new Date() } });

    const view = await resolvePaymentReturn(db, paystack, order.orderNumber, order.reference);

    expect(view.kind).toBe('confirmed');
    expect(paystack.calls.get(order.reference) ?? 0).toBe(0);
  });

  it('a provider failure while verifying shows unavailable and leaves the order unpaid', async () => {
    const order = await unpaidOrder();
    paystack.script(order.reference, new PaystackError('provider down', 503, true));

    const view = await resolvePaymentReturn(db, paystack, order.orderNumber, order.reference);

    expect(view.kind).toBe('unavailable');
    expect(await orderStatus(order.orderId)).toBe('PENDING_PAYMENT');
    expect(await paymentStatus(order.paymentId)).toBe('PENDING');
  });

  it('a FAILED verdict on return is shown as not completed and the order stays unpaid', async () => {
    const order = await unpaidOrder();
    paystack.script(order.reference, paidTxn(order, { status: 'FAILED' }));

    const view = await resolvePaymentReturn(db, paystack, order.orderNumber, order.reference);

    expect(view.kind).toBe('not_completed');
    expect(await orderStatus(order.orderId)).toBe('PENDING_PAYMENT');
  });

  it('money that arrives for a cancelled order is reported as received, not as confirmed', async () => {
    const order = await unpaidOrder();
    await db.payment.update({ where: { id: order.paymentId }, data: { status: 'SUCCEEDED' } });
    await db.order.update({ where: { id: order.orderId }, data: { status: 'CANCELLED', cancelReason: 'payment_timeout' } });

    const view = await resolvePaymentReturn(db, paystack, order.orderNumber, order.reference);

    expect(view.kind).toBe('received_after_cancel');
    expect(paystack.calls.get(order.reference) ?? 0).toBe(0);
  });
});

describe('payment return route', () => {
  it('serves 404 HTML for a missing reference parameter', async () => {
    const response = await getPaymentReturn(
      new Request('http://localhost/orders/ORD-1/payment-return'),
      { params: Promise.resolve({ orderNumber: 'ORD-1' }) },
    );
    expect(response.status).toBe(404);
    expect(await response.text()).toMatch(/Payment not found/);
  });

  it('shows the confirmed page for a paid order, with no-store and noindex headers', async () => {
    const order = await unpaidOrder();
    await db.payment.update({ where: { id: order.paymentId }, data: { status: 'SUCCEEDED' } });
    await db.order.update({ where: { id: order.orderId }, data: { status: 'PAYMENT_CONFIRMED', paidAt: new Date() } });

    const response = await getPaymentReturn(
      new Request(`http://localhost/orders/${order.orderNumber}/payment-return?reference=${order.reference}&trxref=${order.reference}`),
      { params: Promise.resolve({ orderNumber: order.orderNumber }) },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-robots-tag')).toBe('noindex');
    expect(await response.text()).toMatch(/Payment confirmed/);
  });

  it('never marks an order paid from the browser request alone', async () => {
    // The payment is a PAYSTACK payment. The active provider in tests is not Paystack, so the page
    // cannot verify it and must say so, and the order must stay unpaid.
    const order = await unpaidOrder();
    const response = await getPaymentReturn(
      new Request(`http://localhost/orders/${order.orderNumber}/payment-return?reference=${order.reference}`),
      { params: Promise.resolve({ orderNumber: order.orderNumber }) },
    );
    expect(await response.text()).toMatch(/could not reach the payment provider/);
    expect(await orderStatus(order.orderId)).toBe('PENDING_PAYMENT');
  });
});
