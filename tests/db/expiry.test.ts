// Reservation expiry (06 §3, §4.5, §5; docs/03 §4): an unpaid order that runs out of reservation is
// cancelled and its stock released, but only after a final provider verify. A provider error defers the
// cancellation. A late success after cancellation is reinstated when stock is still free. Runs against
// a real PostgreSQL database with a scripted provider.
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setCartItem, viewCart } from '@/server/cart/cart';
import { placeOrder } from '@/server/checkout/checkout';
import { CheckoutBodySchema } from '@/server/checkout/schema';
import { applyVerifiedPayment } from '@/server/payments/confirm';
import { expireDueReservations } from '@/server/payments/expire';
import type { InitializeInput, PaymentProvider, VerifiedTransaction } from '@/server/payments/provider';
import { PaystackError } from '@/server/payments/paystack';
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

/** One unpaid order holding stock. The reservation is set to already expired unless `expired` is false. */
async function unpaidOrder(options: { quantity?: number; expired?: boolean } = {}) {
  const store = await createStore(db);
  const product = await createProduct(db, store.businessId, { onHand: 5 });
  const quantity = options.quantity ?? 2;
  const cart = await cartWith(store, product.variantId, quantity);
  const result = await placeOrder(db, store.store, {
    cartToken: cart.token,
    idempotencyKey: unique('k'),
    body: CheckoutBodySchema.parse(checkoutBody({ expected: cart.snapshot })),
    provider: paystack,
  });
  const orderId = result.body.order.id as string;
  const payment = await db.payment.findFirstOrThrow({ where: { orderId } });
  if (options.expired !== false) {
    await db.order.update({ where: { id: orderId }, data: { reservationExpiresAt: new Date(Date.now() - 60_000) } });
  }
  return {
    scope: store.scope,
    businessId: store.businessId,
    variantId: product.variantId,
    orderId,
    orderNumber: result.body.order.orderNumber as string,
    paymentId: payment.id,
    reference: payment.reference,
    amountMinor: payment.amountMinor,
    quantity,
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

async function reservedOf(variantId: string): Promise<number> {
  return (await db.productVariant.findUniqueOrThrow({ where: { id: variantId }, select: { reserved: true } })).reserved;
}

async function onHandOf(variantId: string): Promise<number> {
  return (await db.productVariant.findUniqueOrThrow({ where: { id: variantId }, select: { onHand: true } })).onHand;
}

async function orderStatus(orderId: string) {
  return db.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true, cancelReason: true } });
}

function sweep(businessId: string) {
  return expireDueReservations(db, paystack, { businessId });
}

describe('reservation expiry', () => {
  it('an expired order whose final verify is still PENDING is cancelled and its stock released', async () => {
    const order = await unpaidOrder({ quantity: 2 });
    paystack.script(order.reference, paidTxn(order, { status: 'PENDING' }));
    expect(await reservedOf(order.variantId)).toBe(2);

    const summary = await sweep(order.businessId);

    expect(summary).toEqual({ checked: 1, cancelled: 1, confirmed: 0, deferred: 0 });
    const after = await orderStatus(order.orderId);
    expect(after).toEqual({ status: 'CANCELLED', cancelReason: 'payment_timeout' });
    expect(await reservedOf(order.variantId)).toBe(0);
    const payment = await db.payment.findUniqueOrThrow({ where: { id: order.paymentId } });
    expect(payment.status).toBe('ABANDONED');
    expect(payment.failureReason).toBe('reservation_expired');
    const movement = await db.inventoryMovement.findFirst({ where: { orderId: order.orderId, reason: 'RESERVATION_RELEASED' } });
    expect(movement?.delta).toBe(2);
    const event = await db.orderStatusEvent.findFirst({ where: { orderId: order.orderId, toStatus: 'CANCELLED' } });
    expect(event?.reason).toBe('payment_timeout');
  });

  it('an expired order whose final verify is SUCCESS is confirmed, not cancelled', async () => {
    const order = await unpaidOrder({ quantity: 1 });
    paystack.script(order.reference, paidTxn(order));

    const summary = await sweep(order.businessId);

    expect(summary).toEqual({ checked: 1, cancelled: 0, confirmed: 1, deferred: 0 });
    expect((await orderStatus(order.orderId)).status).toBe('PAYMENT_CONFIRMED');
    expect((await db.payment.findUniqueOrThrow({ where: { id: order.paymentId } })).status).toBe('SUCCEEDED');
    // Paid stock is committed: onHand and reserved both drop by the quantity.
    expect(await onHandOf(order.variantId)).toBe(4);
    expect(await reservedOf(order.variantId)).toBe(0);
  });

  it('when the provider cannot be asked, the order is deferred and its stock stays held', async () => {
    const order = await unpaidOrder({ quantity: 2 });
    paystack.script(order.reference, new PaystackError('provider unavailable', 503, true));

    const summary = await sweep(order.businessId);

    expect(summary).toEqual({ checked: 1, cancelled: 0, confirmed: 0, deferred: 1 });
    expect((await orderStatus(order.orderId)).status).toBe('PENDING_PAYMENT');
    expect(await reservedOf(order.variantId)).toBe(2);
    expect((await db.payment.findUniqueOrThrow({ where: { id: order.paymentId } })).status).toBe('PENDING');
  });

  it('an order whose reservation has not expired is left untouched', async () => {
    const order = await unpaidOrder({ expired: false });

    const summary = await sweep(order.businessId);

    expect(summary.checked).toBe(0);
    expect(paystack.calls.get(order.reference) ?? 0).toBe(0);
    expect((await orderStatus(order.orderId)).status).toBe('PENDING_PAYMENT');
    expect(await reservedOf(order.variantId)).toBe(2);
  });

  it('an expired order whose payment already FAILED is cancelled without a provider call', async () => {
    const order = await unpaidOrder({ quantity: 1 });
    await db.payment.update({ where: { id: order.paymentId }, data: { status: 'FAILED', failureReason: 'provider_failed' } });

    const summary = await sweep(order.businessId);

    expect(summary).toEqual({ checked: 1, cancelled: 1, confirmed: 0, deferred: 0 });
    expect(paystack.calls.get(order.reference) ?? 0).toBe(0);
    expect((await orderStatus(order.orderId)).status).toBe('CANCELLED');
    expect((await db.payment.findUniqueOrThrow({ where: { id: order.paymentId } })).status).toBe('FAILED');
    expect(await reservedOf(order.variantId)).toBe(0);
  });

  it('a payment that succeeds after the order was cancelled reinstates it while stock is still free', async () => {
    const order = await unpaidOrder({ quantity: 2 });
    paystack.script(order.reference, paidTxn(order, { status: 'PENDING' }));
    await sweep(order.businessId);
    expect((await orderStatus(order.orderId)).status).toBe('CANCELLED');
    expect(await reservedOf(order.variantId)).toBe(0);

    // The customer's money arrives late. The verified success is applied, not refused (06 §5).
    const outcome = await applyVerifiedPayment(db, order.scope, order.reference, paidTxn(order));

    expect(outcome).toBe('late_reinstated');
    expect((await orderStatus(order.orderId)).status).toBe('PAYMENT_CONFIRMED');
    expect((await db.payment.findUniqueOrThrow({ where: { id: order.paymentId } })).status).toBe('SUCCEEDED');
    // Reserved again, then committed as paid: onHand 5 - 2, reserved 0.
    expect(await onHandOf(order.variantId)).toBe(3);
    expect(await reservedOf(order.variantId)).toBe(0);
  });
});
