import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { placeOrder } from '@/server/checkout/checkout';
import { CheckoutBodySchema } from '@/server/checkout/schema';
import { setCartItem, viewCart } from '@/server/cart/cart';
import { AppError } from '@/server/http/problem';
import { MockPaymentProvider } from '@/server/payments/mock';
import { applyVerifiedPayment } from '@/server/payments/confirm';
import { createPrisma, unique } from './helpers';
import { checkoutBody, createProduct, createStore } from './commerce-fixtures';

// Checkout, idempotency, stock and payment confirmation, against a real PostgreSQL database.
// Money: amounts are kobo. 15,000.00 = 1500000n.

let db: PrismaClient;
// One provider for the whole file, so a payment initialised by checkout can be verified later.
const provider = new MockPaymentProvider();

beforeAll(() => {
  db = createPrisma();
});

afterAll(async () => {
  await db.$disconnect();
});

/** Builds a cart for a store, returns the token and the expected snapshot the customer would see. */
async function cartWith(
  store: Awaited<ReturnType<typeof createStore>>,
  lines: { variantId: string; quantity: number }[],
  state = 'Lagos',
) {
  let token: string | null = null;
  for (const line of lines) {
    const result = await setCartItem(db, store.scope, { token, variantId: line.variantId, quantity: line.quantity });
    token = token ?? result.newToken;
  }
  const view = await viewCart(db, store.store, { token, state });
  const snapshot = {
    totalMinor: view.totalMinor.toString(),
    lines: view.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity, unitPriceMinor: l.unitPriceMinor.toString() })),
  };
  return { token: token as string, snapshot };
}

function place(
  store: Awaited<ReturnType<typeof createStore>>,
  token: string | null,
  key: string,
  body: ReturnType<typeof checkoutBody>,
) {
  const parsed = CheckoutBodySchema.parse(body);
  return placeOrder(db, store.store, { cartToken: token, idempotencyKey: key, body: parsed, provider });
}

describe('checkout journey', () => {
  it('creates a PENDING_PAYMENT order, reserves stock, and is paid only after server-side verification', async () => {
    const store = await createStore(db);
    const product = await createProduct(db, store.businessId, { priceMinor: 1500000n, onHand: 5 });
    const cart = await cartWith(store, [{ variantId: product.variantId, quantity: 2 }]);
    expect(cart.snapshot.totalMinor).toBe('3150000'); // 30,000 goods + 1,500 Lagos fee

    const key = unique('key');
    const result = await place(store, cart.token, key, checkoutBody({ expected: cart.snapshot }));
    expect(result.status).toBe(201);
    expect(result.body.order.status).toBe('PENDING_PAYMENT');
    expect(result.body.order.orderNumber).toMatch(/^ORD-\d{6,}$/);
    expect(result.body.order.totalMinor).toBe(3150000n);
    expect(result.body.order.paidAt).toBeNull();
    expect(result.body.payment?.status).toBe('PENDING');
    expect(result.body.payment?.authorizationUrl).toMatch(/\/mock-pay\/pay_/);

    const variant = await db.productVariant.findUniqueOrThrow({ where: { id: product.variantId } });
    expect({ onHand: variant.onHand, reserved: variant.reserved }).toEqual({ onHand: 5, reserved: 2 });

    // Not paid until the provider says so.
    const pending = await db.order.findUniqueOrThrow({ where: { id: result.body.order.id } });
    expect(pending.status).toBe('PENDING_PAYMENT');

    const reference = (await db.payment.findFirstOrThrow({ where: { orderId: pending.id } })).reference;
    provider.simulate(reference, 'SUCCESS');
    const verified = await provider.verify(reference);
    expect(await applyVerifiedPayment(db, store.scope, reference, verified)).toBe('confirmed');

    const paid = await db.order.findUniqueOrThrow({ where: { id: pending.id } });
    expect(paid.status).toBe('PAYMENT_CONFIRMED');
    expect(paid.paidAt).not.toBeNull();
    const committed = await db.productVariant.findUniqueOrThrow({ where: { id: product.variantId } });
    expect({ onHand: committed.onHand, reserved: committed.reserved }).toEqual({ onHand: 3, reserved: 0 });

    const movements = await db.inventoryMovement.findMany({ where: { orderId: pending.id }, select: { reason: true, delta: true } });
    expect(movements.map((m) => `${m.reason}:${m.delta}`).sort()).toEqual(['RESERVED:2', 'SOLD:-2']);
    const events = await db.orderStatusEvent.findMany({ where: { orderId: pending.id }, orderBy: { createdAt: 'asc' } });
    expect(events.map((e) => e.toStatus)).toEqual(['PENDING_PAYMENT', 'PAYMENT_CONFIRMED']);
  });

  it('a repeated verification after success does nothing', async () => {
    const store = await createStore(db);
    const product = await createProduct(db, store.businessId, { onHand: 5 });
    const cart = await cartWith(store, [{ variantId: product.variantId, quantity: 1 }]);
    const result = await place(store, cart.token, unique('k'), checkoutBody({ expected: cart.snapshot }));
    const reference = (await db.payment.findFirstOrThrow({ where: { orderId: result.body.order.id } })).reference;
    const verified = { reference, providerTransactionId: unique('txn'), status: 'SUCCESS' as const, amountMinor: result.body.order.totalMinor, currency: 'NGN' };

    expect(await applyVerifiedPayment(db, store.scope, reference, verified)).toBe('confirmed');
    expect(await applyVerifiedPayment(db, store.scope, reference, verified)).toBe('already_processed');
    const movements = await db.inventoryMovement.count({ where: { orderId: result.body.order.id, reason: 'SOLD' } });
    expect(movements).toBe(1);
  });

  it('does not let one provider transaction pay two orders', async () => {
    const store = await createStore(db);
    const product = await createProduct(db, store.businessId, { onHand: 9 });
    const c1 = await cartWith(store, [{ variantId: product.variantId, quantity: 1 }]);
    const r1 = await place(store, c1.token, unique('k'), checkoutBody({ expected: c1.snapshot, phone: '+2348066600001' }));
    const c2 = await cartWith(store, [{ variantId: product.variantId, quantity: 1 }]);
    const r2 = await place(store, c2.token, unique('k'), checkoutBody({ expected: c2.snapshot, phone: '+2348066600002' }));
    const ref1 = (await db.payment.findFirstOrThrow({ where: { orderId: r1.body.order.id } })).reference;
    const ref2 = (await db.payment.findFirstOrThrow({ where: { orderId: r2.body.order.id } })).reference;
    const txn = unique('txn');

    expect(
      await applyVerifiedPayment(db, store.scope, ref1, { reference: ref1, providerTransactionId: txn, status: 'SUCCESS', amountMinor: r1.body.order.totalMinor, currency: 'NGN' }),
    ).toBe('confirmed');
    expect(
      await applyVerifiedPayment(db, store.scope, ref2, { reference: ref2, providerTransactionId: txn, status: 'SUCCESS', amountMinor: r2.body.order.totalMinor, currency: 'NGN' }),
    ).toBe('duplicate_transaction');
    expect((await db.order.findUniqueOrThrow({ where: { id: r2.body.order.id } })).status).toBe('PENDING_PAYMENT');
  });

  it('a pending or failed verification does not pay the order', async () => {
    const store = await createStore(db);
    const product = await createProduct(db, store.businessId, { onHand: 5 });
    const cart = await cartWith(store, [{ variantId: product.variantId, quantity: 1 }]);
    const result = await place(store, cart.token, unique('k'), checkoutBody({ expected: cart.snapshot }));
    const orderId = result.body.order.id;
    const reference = (await db.payment.findFirstOrThrow({ where: { orderId } })).reference;
    const base = { reference, providerTransactionId: unique('txn'), amountMinor: result.body.order.totalMinor, currency: 'NGN' };

    expect(await applyVerifiedPayment(db, store.scope, reference, { ...base, status: 'PENDING' })).toBe('pending');
    expect(await applyVerifiedPayment(db, store.scope, reference, { ...base, status: 'FAILED' })).toBe('failed');
    const order = await db.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('PENDING_PAYMENT');
    expect(order.paidAt).toBeNull();
  });

  it('refuses a payment whose amount differs from the order, and marks it FAILED', async () => {
    const store = await createStore(db);
    const product = await createProduct(db, store.businessId, { onHand: 5 });
    const cart = await cartWith(store, [{ variantId: product.variantId, quantity: 1 }]);
    const result = await place(store, cart.token, unique('k'), checkoutBody({ expected: cart.snapshot }));
    const reference = (await db.payment.findFirstOrThrow({ where: { orderId: result.body.order.id } })).reference;

    const outcome = await applyVerifiedPayment(db, store.scope, reference, {
      reference,
      providerTransactionId: unique('txn'),
      status: 'SUCCESS',
      amountMinor: result.body.order.totalMinor - 1n,
      currency: 'NGN',
    });
    expect(outcome).toBe('amount_mismatch');
    const payment = await db.payment.findFirstOrThrow({ where: { reference } });
    expect(payment.status).toBe('FAILED');
    expect(payment.failureReason).toBe('amount_mismatch');
    expect((await db.order.findUniqueOrThrow({ where: { id: result.body.order.id } })).status).toBe('PENDING_PAYMENT');
  });

  it('records money received after the order was cancelled, without moving the order', async () => {
    const store = await createStore(db);
    const product = await createProduct(db, store.businessId, { onHand: 5 });
    const cart = await cartWith(store, [{ variantId: product.variantId, quantity: 1 }]);
    const result = await place(store, cart.token, unique('k'), checkoutBody({ expected: cart.snapshot }));
    const orderId = result.body.order.id;
    await db.order.update({ where: { id: orderId }, data: { status: 'CANCELLED', cancelledAt: new Date(), version: { increment: 1 } } });
    const reference = (await db.payment.findFirstOrThrow({ where: { orderId } })).reference;

    const outcome = await applyVerifiedPayment(db, store.scope, reference, {
      reference,
      providerTransactionId: unique('txn'),
      status: 'SUCCESS',
      amountMinor: result.body.order.totalMinor,
      currency: 'NGN',
    });
    expect(outcome).toBe('late_success');
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('CANCELLED');
    expect((await db.payment.findFirstOrThrow({ where: { reference } })).status).toBe('SUCCEEDED');
  });
});

describe('checkout idempotency', () => {
  it('replays the same key and body with the same order, and creates nothing new', async () => {
    const store = await createStore(db);
    const product = await createProduct(db, store.businessId, { onHand: 5 });
    const cart = await cartWith(store, [{ variantId: product.variantId, quantity: 1 }]);
    const key = unique('replay');
    const body = checkoutBody({ expected: cart.snapshot });

    const first = await place(store, cart.token, key, body);
    const second = await place(store, cart.token, key, body);
    expect(second.status).toBe(201);
    expect(second.body.order.id).toBe(first.body.order.id);
    expect(await db.order.count({ where: { businessId: store.businessId } })).toBe(1);
    expect((await db.productVariant.findUniqueOrThrow({ where: { id: product.variantId } })).reserved).toBe(1);
  });

  it('rejects the same key with a different body with 422', async () => {
    const store = await createStore(db);
    const product = await createProduct(db, store.businessId, { onHand: 5 });
    const cart = await cartWith(store, [{ variantId: product.variantId, quantity: 1 }]);
    const key = unique('conflict');
    await place(store, cart.token, key, checkoutBody({ expected: cart.snapshot }));

    await expect(
      place(store, cart.token, key, checkoutBody({ expected: cart.snapshot, customerNote: 'leave at the gate' })),
    ).rejects.toMatchObject({ status: 422, code: 'idempotency_key_reused' });
    expect(await db.order.count({ where: { businessId: store.businessId } })).toBe(1);
  });

  it('two concurrent requests with one key create one order (the loser gets 409, or the same order)', async () => {
    const store = await createStore(db);
    const product = await createProduct(db, store.businessId, { onHand: 5 });
    const cart = await cartWith(store, [{ variantId: product.variantId, quantity: 1 }]);
    const key = unique('race');
    const body = checkoutBody({ expected: cart.snapshot });

    const results = await Promise.allSettled([place(store, cart.token, key, body), place(store, cart.token, key, body)]);
    const won = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof place>>> => r.status === 'fulfilled');
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(won.length).toBeGreaterThanOrEqual(1);
    for (const r of lost) expect((r.reason as AppError).code).toBe('in_progress');
    expect(new Set(won.map((r) => r.value.body.order.id)).size).toBe(1);
    expect(await db.order.count({ where: { businessId: store.businessId } })).toBe(1);
  }, 60_000);

  it('releases the key when the checkout fails, so the same request can be retried', async () => {
    const store = await createStore(db);
    const product = await createProduct(db, store.businessId, { priceMinor: 1500000n, onHand: 5 });
    const cart = await cartWith(store, [{ variantId: product.variantId, quantity: 1 }]);
    const body = checkoutBody({ expected: cart.snapshot });
    const key = unique('retry');

    await db.productVariant.update({ where: { id: product.variantId }, data: { priceMinor: 1600000n } });
    await expect(place(store, cart.token, key, body)).rejects.toMatchObject({ status: 409, code: 'cart_changed' });

    // Same key, same body, price still changed: the key was released, so it is refused again, not "in progress".
    await expect(place(store, cart.token, key, body)).rejects.toMatchObject({ status: 409, code: 'cart_changed' });
    expect(await db.order.count({ where: { businessId: store.businessId } })).toBe(0);
  });
});

describe('checkout re-validation', () => {
  it('returns 409 with a diff when the price changed after the cart was reviewed, and reserves nothing', async () => {
    const store = await createStore(db);
    const product = await createProduct(db, store.businessId, { priceMinor: 1500000n, onHand: 5 });
    const cart = await cartWith(store, [{ variantId: product.variantId, quantity: 2 }]);
    await db.productVariant.update({ where: { id: product.variantId }, data: { priceMinor: 1600000n } });

    let caught: unknown;
    try {
      await place(store, cart.token, unique('k'), checkoutBody({ expected: cart.snapshot }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppError);
    const extra = (caught as AppError).extra as { changes: { field: string; expected?: string; actual?: string }[] };
    expect(extra.changes).toContainEqual({ variantId: product.variantId, field: 'unitPriceMinor', expected: '1500000', actual: '1600000' });
    expect(extra.changes.some((c) => c.field === 'totalMinor')).toBe(true);

    const variant = await db.productVariant.findUniqueOrThrow({ where: { id: product.variantId } });
    expect(variant.reserved).toBe(0);
  });

  it('returns 409 when an item was removed from the cart in another tab', async () => {
    const store = await createStore(db);
    const a = await createProduct(db, store.businessId, { onHand: 5 });
    const b = await createProduct(db, store.businessId, { onHand: 5 });
    const cart = await cartWith(store, [
      { variantId: a.variantId, quantity: 1 },
      { variantId: b.variantId, quantity: 1 },
    ]);
    await db.cartItem.deleteMany({ where: { variant: { id: b.variantId } } });

    const attempt = place(store, cart.token, unique('k'), checkoutBody({ expected: cart.snapshot }));
    await expect(attempt).rejects.toMatchObject({ status: 409, code: 'cart_changed' });
  });

  it('refuses a checkout when stock has gone, and reserves nothing from the cart', async () => {
    const store = await createStore(db);
    const a = await createProduct(db, store.businessId, { onHand: 5 });
    const b = await createProduct(db, store.businessId, { onHand: 1 });
    const cart = await cartWith(store, [
      { variantId: a.variantId, quantity: 2 },
      { variantId: b.variantId, quantity: 1 },
    ]);
    // Someone else takes the last unit between the cart and checkout.
    await db.productVariant.update({ where: { id: b.variantId }, data: { reserved: 1 } });

    await expect(place(store, cart.token, unique('k'), checkoutBody({ expected: cart.snapshot }))).rejects.toMatchObject({
      status: 409,
      code: 'out_of_stock',
    });
    expect((await db.productVariant.findUniqueOrThrow({ where: { id: a.variantId } })).reserved).toBe(0);
  });

  it('refuses a state with no delivery zone', async () => {
    const store = await createStore(db, { zoneStates: ['Lagos'] });
    const product = await createProduct(db, store.businessId, { onHand: 5 });
    const cart = await cartWith(store, [{ variantId: product.variantId, quantity: 1 }], 'Lagos');
    await expect(place(store, cart.token, unique('k'), checkoutBody({ state: 'Kano', expected: cart.snapshot }))).rejects.toMatchObject({
      status: 422,
      code: 'not_delivered',
    });
  });

  it('refuses an empty or missing cart', async () => {
    const store = await createStore(db);
    await expect(place(store, null, unique('k'), checkoutBody({ expected: { totalMinor: '0', lines: [{ variantId: '00000000-0000-4000-8000-000000000000', quantity: 1, unitPriceMinor: '1' }] } }))).rejects.toMatchObject({
      status: 422,
      code: 'empty_cart',
    });
  });

  it('does not let a cart from one business check out in another', async () => {
    const a = await createStore(db);
    const b = await createStore(db);
    const product = await createProduct(db, a.businessId, { onHand: 5 });
    const cart = await cartWith(a, [{ variantId: product.variantId, quantity: 1 }]);
    await expect(place(b, cart.token, unique('k'), checkoutBody({ expected: cart.snapshot }))).rejects.toMatchObject({
      code: 'empty_cart',
    });
  });

  it('gives free shipping in the order when the subtotal reaches the threshold', async () => {
    const store = await createStore(db, { threshold: 3000000n });
    const product = await createProduct(db, store.businessId, { priceMinor: 1500000n, onHand: 5 });
    const cart = await cartWith(store, [{ variantId: product.variantId, quantity: 2 }]);
    const result = await place(store, cart.token, unique('k'), checkoutBody({ expected: cart.snapshot }));
    expect(result.body.order.shippingMinor).toBe(0n);
    expect(result.body.order.totalMinor).toBe(3000000n);
  });
});

describe('checkout side effects', () => {
  it('records WhatsApp consent only when the box is ticked', async () => {
    const store = await createStore(db);
    const product = await createProduct(db, store.businessId, { onHand: 9 });
    const cart = await cartWith(store, [{ variantId: product.variantId, quantity: 1 }]);
    await place(store, cart.token, unique('k'), checkoutBody({ expected: cart.snapshot, whatsappUpdates: false, phone: '+2348011111111' }));
    const cart2 = await cartWith(store, [{ variantId: product.variantId, quantity: 1 }]);
    await place(store, cart2.token, unique('k'), checkoutBody({ expected: cart2.snapshot, whatsappUpdates: true, phone: '+2348022222222' }));

    const consents = await db.consentRecord.findMany({ where: { businessId: store.businessId }, select: { purpose: true, granted: true, policyVersion: true } });
    expect(consents).toEqual([{ purpose: 'ORDER_UPDATES_WHATSAPP', granted: true, policyVersion: '2026-10-stage3' }]);
  });

  it('reuses the customer for the same phone number and does not overwrite their details', async () => {
    const store = await createStore(db);
    const product = await createProduct(db, store.businessId, { onHand: 9 });
    const first = await cartWith(store, [{ variantId: product.variantId, quantity: 1 }]);
    await place(store, first.token, unique('k'), checkoutBody({ expected: first.snapshot, phone: '+2348033333333' }));
    const second = await cartWith(store, [{ variantId: product.variantId, quantity: 1 }]);
    const body = { ...checkoutBody({ expected: second.snapshot, phone: '+2348033333333' }), recipientName: 'Someone Else' };
    await place(store, second.token, unique('k'), body);

    const customers = await db.customer.findMany({ where: { businessId: store.businessId } });
    expect(customers).toHaveLength(1);
    expect(customers[0].fullName).toBe('Ada Test');
    expect(await db.order.count({ where: { businessId: store.businessId, customerId: customers[0].id } })).toBe(2);
  });

  it('issues sequential order numbers', async () => {
    const store = await createStore(db);
    const product = await createProduct(db, store.businessId, { onHand: 9 });
    const c1 = await cartWith(store, [{ variantId: product.variantId, quantity: 1 }]);
    const r1 = await place(store, c1.token, unique('k'), checkoutBody({ expected: c1.snapshot, phone: '+2348044444441' }));
    const c2 = await cartWith(store, [{ variantId: product.variantId, quantity: 1 }]);
    const r2 = await place(store, c2.token, unique('k'), checkoutBody({ expected: c2.snapshot, phone: '+2348044444442' }));
    const n1 = Number(r1.body.order.orderNumber.split('-')[1].slice(2));
    const n2 = Number(r2.body.order.orderNumber.split('-')[1].slice(2));
    expect(n2).toBeGreaterThan(n1);
  });
});

describe('checkout concurrency', () => {
  it('50 parallel checkouts for 10 units: exactly 10 succeed and stock never goes negative', async () => {
    const store = await createStore(db);
    const product = await createProduct(db, store.businessId, { priceMinor: 100000n, onHand: 10 });

    // 50 separate carts, each with one unit. Carts are created one by one to keep set-up simple.
    const carts: { token: string; snapshot: { totalMinor: string; lines: { variantId: string; quantity: number; unitPriceMinor: string }[] } }[] = [];
    for (let i = 0; i < 50; i++) {
      carts.push(await cartWith(store, [{ variantId: product.variantId, quantity: 1 }]));
    }

    const results = await Promise.allSettled(
      carts.map((cart, i) =>
        place(store, cart.token, unique(`par${i}`), checkoutBody({ expected: cart.snapshot, phone: `+23480${String(10000000 + i)}` })),
      ),
    );
    const succeeded = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(succeeded).toHaveLength(10);
    expect(failed).toHaveLength(40);
    for (const r of failed) expect((r.reason as AppError).code).toBe('out_of_stock');

    const variant = await db.productVariant.findUniqueOrThrow({ where: { id: product.variantId } });
    expect(variant.reserved).toBe(10);
    expect(variant.onHand).toBe(10);
    expect(await db.order.count({ where: { businessId: store.businessId } })).toBe(10);
  }, 120_000);
});

describe('schema validation of the checkout body', () => {
  it('rejects a non-Nigerian phone number, an unknown state and an over-limit quantity', () => {
    const base = checkoutBody({ expected: { totalMinor: '1', lines: [{ variantId: '00000000-0000-4000-8000-000000000001', quantity: 1, unitPriceMinor: '1' }] } });
    expect(() => CheckoutBodySchema.parse({ ...base, phoneE164: '+14155550100' })).toThrow();
    expect(() => CheckoutBodySchema.parse({ ...base, address: { ...base.address, state: 'Atlantis' } })).toThrow();
    expect(() =>
      CheckoutBodySchema.parse({ ...base, expected: { totalMinor: '1', lines: [{ variantId: '00000000-0000-4000-8000-000000000001', quantity: 11, unitPriceMinor: '1' }] } }),
    ).toThrow();
  });

  it('accepts a valid body, trims text, and defaults WhatsApp consent to off', () => {
    const base = checkoutBody({ expected: { totalMinor: '1', lines: [{ variantId: '00000000-0000-4000-8000-000000000001', quantity: 1, unitPriceMinor: '1' }] } });
    const parsed = CheckoutBodySchema.parse({ ...base, recipientName: '  Ada Test  ', address: { ...base.address, state: '  lagos state ' } });
    expect(parsed.recipientName).toBe('Ada Test');
    expect(parsed.address.state).toBe('lagos state');
    expect(parsed.whatsappUpdates).toBe(false);
  });
});
