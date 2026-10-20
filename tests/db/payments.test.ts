// Paystack webhook intake, verification jobs, and late-payment rules (06 §4, §5, §10), against a real
// PostgreSQL database. The provider is a scripted fake: its responses are fixed per reference, and an
// unscripted call throws a retryable error without using up another test's responses.
import { createHmac } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POST as postJobs } from '@/app/api/internal/jobs/run/route';
import { POST as postWebhook } from '@/app/api/webhooks/paystack/route';
import { setCartItem, viewCart } from '@/server/cart/cart';
import { placeOrder } from '@/server/checkout/checkout';
import { CheckoutBodySchema } from '@/server/checkout/schema';
import { applyVerifiedPayment } from '@/server/payments/confirm';
import type { InitializeInput, PaymentProvider, VerifiedTransaction } from '@/server/payments/provider';
import { PaystackError } from '@/server/payments/paystack';
import { paymentVerifyHandler } from '@/server/payments/verifyJob';
import { paystackWebhookSecret, receivePaystackWebhook } from '@/server/payments/webhook';
import { backoffMs, runDueJobs } from '@/server/jobs/runner';
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

class FakePaystack implements PaymentProvider {
  readonly name = 'PAYSTACK' as const;
  private readonly scripts = new Map<string, Step[]>();
  readonly calls = new Map<string, number>();

  script(reference: string, ...steps: Step[]): void {
    this.scripts.set(reference, [...steps]);
  }

  async initialize(input: InitializeInput) {
    return { authorizationUrl: `https://checkout.paystack.test/${input.reference}`, providerReference: input.reference };
  }

  async refund(): Promise<never> {
    throw new Error('refunds are not used in this test');
  }

  async getRefund(): Promise<never> {
    throw new Error('refunds are not used in this test');
  }

  async verify(reference: string): Promise<VerifiedTransaction> {
    this.calls.set(reference, (this.calls.get(reference) ?? 0) + 1);
    const step = this.scripts.get(reference)?.shift();
    if (!step) throw new PaystackError('no scripted response for this reference', 503, true);
    if (step instanceof Error) throw step;
    return step;
  }
}

const paystack = new FakePaystack();

type Store = Awaited<ReturnType<typeof createStore>>;

async function cartWith(store: Store, lines: { variantId: string; quantity: number }[]) {
  let token: string | null = null;
  for (const line of lines) {
    const result = await setCartItem(db, store.scope, { token, variantId: line.variantId, quantity: line.quantity });
    token = token ?? result.newToken;
  }
  const view = await viewCart(db, store.store, { token, state: 'Lagos' });
  return {
    token: token as string,
    snapshot: {
      totalMinor: view.totalMinor.toString(),
      lines: view.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity, unitPriceMinor: l.unitPriceMinor.toString() })),
    },
  };
}

/** A checkout with one Paystack payment awaiting verification. */
async function newOrder(options: { onHand?: number; quantity?: number } = {}) {
  const store = await createStore(db);
  const product = await createProduct(db, store.businessId, { onHand: options.onHand ?? 5 });
  const quantity = options.quantity ?? 1;
  const cart = await cartWith(store, [{ variantId: product.variantId, quantity }]);
  const result = await placeOrder(db, store.store, {
    cartToken: cart.token,
    idempotencyKey: unique('k'),
    body: CheckoutBodySchema.parse(checkoutBody({ expected: cart.snapshot })),
    provider: paystack,
  });
  const payment = await db.payment.findFirstOrThrow({ where: { orderId: result.body.order.id } });
  return {
    scope: store.scope,
    businessId: store.businessId,
    variantId: product.variantId,
    orderId: result.body.order.id,
    orderNumber: result.body.order.orderNumber,
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

function chargeEvent(order: { reference: string; amountMinor: bigint }, status = 'success') {
  return {
    event: status === 'success' ? 'charge.success' : 'charge.failed',
    data: { id: Math.floor(Math.random() * 1e9) + 1, reference: order.reference, status, amount: Number(order.amountMinor), currency: 'NGN', channel: 'card' },
  };
}

function signed(payload: unknown, secret = paystackWebhookSecret() as string): { raw: Buffer; signature: string } {
  const raw = Buffer.from(JSON.stringify(payload));
  return { raw, signature: createHmac('sha512', secret).update(raw).digest('hex') };
}

function receive(raw: Buffer, signature: string | null) {
  return receivePaystackWebhook(db, raw, signature, paystackWebhookSecret());
}

async function drain(limit = 50) {
  return runDueJobs(db, { 'payment.verify': paymentVerifyHandler(db, paystack) }, { limit });
}

/** Sends a signed charge.success webhook, which queues the verify job the way production does. */
async function enqueueVerify(order: { reference: string; amountMinor: bigint }) {
  const { raw, signature } = signed(chargeEvent(order));
  expect((await receive(raw, signature)).result).toBe('accepted');
}

async function jobsFor(reference: string) {
  return db.job.findMany({ where: { type: 'payment.verify', payload: { path: ['reference'], equals: reference } } });
}

async function stock(variantId: string) {
  return db.productVariant.findUniqueOrThrow({ where: { id: variantId }, select: { onHand: true, reserved: true } });
}

async function review(paymentId: string) {
  const rows = await db.auditLog.findMany({ where: { action: 'PAYMENT_NEEDS_REVIEW', entityId: paymentId }, orderBy: { createdAt: 'asc' } });
  return rows.map((row) => (row.changes as { reason: string }).reason);
}

describe('Paystack webhook intake (06 §4.3, §10)', () => {
  it('stores a valid first delivery once and queues one verification job', async () => {
    const order = await newOrder();
    const { raw, signature } = signed(chargeEvent(order));
    const first = await receive(raw, signature);
    expect(first).toEqual({ status: 200, result: 'accepted' });
    expect(await jobsFor(order.reference)).toHaveLength(1);
    await drain();
  });

  it('a second delivery of the same event is a duplicate: one webhook row, one job', async () => {
    const order = await newOrder();
    const payload = chargeEvent(order);
    const { raw, signature } = signed(payload);
    expect((await receive(raw, signature)).result).toBe('accepted');
    expect(await receive(raw, signature)).toEqual({ status: 200, result: 'duplicate' });
    const hits = await db.webhookEvent.count({ where: { externalId: `charge.success:${payload.data.id}:success` } });
    expect(hits).toBe(1);
    expect(await jobsFor(order.reference)).toHaveLength(1);
    await drain();
  });

  it('an invalid signature is refused and writes nothing', async () => {
    const order = await newOrder();
    const payload = chargeEvent(order);
    const { raw } = signed(payload);
    const forged = signed(payload, 'sk_test_attacker');
    expect(await receive(raw, forged.signature)).toEqual({ status: 400, result: 'bad_signature' });
    expect(await receive(raw, null)).toEqual({ status: 400, result: 'bad_signature' });
    expect(await db.webhookEvent.count({ where: { externalId: `charge.success:${payload.data.id}:success` } })).toBe(0);
    expect(await jobsFor(order.reference)).toHaveLength(0);
  });

  it('a re-serialised body does not pass with the original signature (raw bytes are signed)', async () => {
    const order = await newOrder();
    const { raw, signature } = signed(chargeEvent(order));
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(raw.toString('utf8')), null, 2));
    expect(reserialised.equals(raw)).toBe(false);
    expect(await receive(reserialised, signature)).toEqual({ status: 400, result: 'bad_signature' });
    expect(await jobsFor(order.reference)).toHaveLength(0);
  });

  it('acknowledges an event for an unknown reference and stores it as ignored', async () => {
    const id = Math.floor(Math.random() * 1e9) + 1;
    const payload = { event: 'charge.success', data: { id, reference: unique('pay_unknown'), status: 'success', amount: 1, currency: 'NGN' } };
    const { raw, signature } = signed(payload);
    expect(await receive(raw, signature)).toEqual({ status: 200, result: 'ignored' });
    const row = await db.webhookEvent.findFirstOrThrow({ where: { externalId: `charge.success:${id}:success` } });
    expect(row.status).toBe('IGNORED');
  });

  it('a webhook followed by the verify job confirms once; a later return-page verify changes nothing', async () => {
    const order = await newOrder({ onHand: 5, quantity: 2 });
    paystack.script(order.reference, paidTxn(order));
    const { raw, signature } = signed(chargeEvent(order));
    expect((await receive(raw, signature)).result).toBe('accepted');

    const summary = await drain();
    expect(summary?.succeeded).toBeGreaterThanOrEqual(1);
    const after = await db.order.findUniqueOrThrow({ where: { id: order.orderId } });
    expect(after.status).toBe('PAYMENT_CONFIRMED');
    expect(await stock(order.variantId)).toEqual({ onHand: 3, reserved: 0 });
    expect((await db.webhookEvent.findFirstOrThrow({ where: { payload: { path: ['reference'], equals: order.reference } } })).status).toBe('PROCESSED');

    expect(await applyVerifiedPayment(db, order.scope, order.reference, paidTxn(order))).toBe('already_processed');
    expect(await stock(order.variantId)).toEqual({ onHand: 3, reserved: 0 });
  });

  it('a return-page verify before the webhook confirms; the later job makes no second change', async () => {
    const order = await newOrder();
    const txn = paidTxn(order);
    expect(await applyVerifiedPayment(db, order.scope, order.reference, txn)).toBe('confirmed');

    const { raw, signature } = signed(chargeEvent(order));
    expect((await receive(raw, signature)).result).toBe('accepted');
    await drain();
    expect(paystack.calls.get(order.reference) ?? 0).toBe(0); // the payment was already settled, so no verify call
    expect((await db.order.findUniqueOrThrow({ where: { id: order.orderId } })).status).toBe('PAYMENT_CONFIRMED');
  });

  it('a webhook job and a return-page verify racing each other produce exactly one confirmation', async () => {
    const order = await newOrder({ onHand: 5 });
    const txn = paidTxn(order);
    const outcomes = await Promise.all([
      applyVerifiedPayment(db, order.scope, order.reference, txn),
      applyVerifiedPayment(db, order.scope, order.reference, txn),
    ]);
    expect(outcomes.sort()).toEqual(['already_processed', 'confirmed']);
    expect(await stock(order.variantId)).toEqual({ onHand: 4, reserved: 0 });
  });
});

describe('verification rules (06 §4.4)', () => {
  it('an amount lower than the order total fails the payment, leaves the order unpaid, and flags staff', async () => {
    const order = await newOrder();
    const outcome = await applyVerifiedPayment(db, order.scope, order.reference, paidTxn(order, { amountMinor: order.amountMinor - 1n }));
    expect(outcome).toBe('amount_mismatch');
    expect((await db.payment.findUniqueOrThrow({ where: { id: order.paymentId } })).status).toBe('FAILED');
    expect((await db.order.findUniqueOrThrow({ where: { id: order.orderId } })).status).toBe('PENDING_PAYMENT');
    expect(await review(order.paymentId)).toEqual(['amount_mismatch']);
  });

  it('another currency fails the payment with currency_mismatch', async () => {
    const order = await newOrder();
    expect(await applyVerifiedPayment(db, order.scope, order.reference, paidTxn(order, { currency: 'USD' }))).toBe('currency_mismatch');
    expect(await review(order.paymentId)).toEqual(['currency_mismatch']);
  });

  it('a provider transaction for another reference fails the payment with reference_mismatch', async () => {
    const order = await newOrder();
    expect(await applyVerifiedPayment(db, order.scope, order.reference, paidTxn(order, { reference: 'pay_someone_else' }))).toBe('reference_mismatch');
    expect((await db.order.findUniqueOrThrow({ where: { id: order.orderId } })).status).toBe('PENDING_PAYMENT');
  });

  it('a provider-reported failure marks the payment failed and keeps the order awaiting payment', async () => {
    const order = await newOrder();
    expect(await applyVerifiedPayment(db, order.scope, order.reference, paidTxn(order, { status: 'FAILED' }))).toBe('failed');
    expect((await db.payment.findUniqueOrThrow({ where: { id: order.paymentId } })).status).toBe('FAILED');
  });

  it('a provider that still reports pending is retried by the job, and the order is unchanged', async () => {
    const order = await newOrder();
    paystack.script(order.reference, paidTxn(order, { status: 'PENDING' }));
    await enqueueVerify(order);
    await drain();
    const job = (await jobsFor(order.reference))[0];
    expect(job.status).toBe('PENDING');
    expect(job.lastError).toMatch(/still reports the payment as pending/);
    expect(job.runAt.getTime()).toBeGreaterThan(Date.now());
    expect((await db.order.findUniqueOrThrow({ where: { id: order.orderId } })).status).toBe('PENDING_PAYMENT');
  });

  it('a 5xx from the provider is retried with backoff, and the order is unchanged', async () => {
    const order = await newOrder();
    paystack.script(order.reference, new PaystackError('Paystack returned HTTP 503', 503, true));
    await enqueueVerify(order);
    await drain();
    const job = (await jobsFor(order.reference))[0];
    expect(job.status).toBe('PENDING');
    expect(job.attempts).toBe(1);
    expect(job.lastError).toBe('Paystack returned HTTP 503');
    expect((await db.order.findUniqueOrThrow({ where: { id: order.orderId } })).status).toBe('PENDING_PAYMENT');
  });

  it('a job that exhausts its attempts is marked FAILED for staff', async () => {
    const order = await newOrder();
    await db.job.create({
      data: { businessId: order.businessId, type: 'payment.verify', payload: { reference: order.reference }, maxAttempts: 1 },
    });
    paystack.script(order.reference, new PaystackError('Paystack returned HTTP 500', 500, true));
    await drain();
    const job = (await jobsFor(order.reference))[0];
    expect(job.status).toBe('FAILED');
    expect(job.lastError).toBe('Paystack returned HTTP 500');
  });

  it('refuses to verify a payment made with another provider, and changes nothing', async () => {
    const order = await newOrder();
    await db.payment.update({ where: { id: order.paymentId }, data: { provider: 'MOCK' } });
    await enqueueVerify(order);
    await drain();
    const job = (await jobsFor(order.reference))[0];
    expect(job.status).toBe('PENDING');
    expect(job.lastError).toMatch(/made with MOCK/);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.orderId } })).status).toBe('PENDING_PAYMENT');
  });

  it('an unknown job type fails at once', async () => {
    const job = await db.job.create({ data: { type: 'not.a.real.job', payload: {} } });
    await drain();
    expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('FAILED');
  });

  it('backs off 30s, 60s, 120s, and caps at one hour', () => {
    expect(backoffMs(1)).toBe(30_000);
    expect(backoffMs(2)).toBe(60_000);
    expect(backoffMs(3)).toBe(120_000);
    expect(backoffMs(20)).toBe(60 * 60_000);
  });
});

describe('late payment after cancellation (06 §5)', () => {
  /** Simulates the reservation expiring: the order is cancelled for payment_timeout and stock is released. */
  async function expireReservation(order: { orderId: string; variantId: string; quantity: number }, reason = 'payment_timeout') {
    await db.order.update({ where: { id: order.orderId }, data: { status: 'CANCELLED', cancelledAt: new Date(), version: { increment: 1 } } });
    await db.orderStatusEvent.create({
      data: { orderId: order.orderId, fromStatus: 'PENDING_PAYMENT', toStatus: 'CANCELLED', actorType: 'SYSTEM', reason },
    });
    await db.productVariant.update({ where: { id: order.variantId }, data: { reserved: { decrement: order.quantity } } });
  }

  it('reinstates the order when the reservation expired and the stock is still free', async () => {
    const order = await newOrder({ onHand: 5, quantity: 1 });
    await expireReservation(order);
    expect(await applyVerifiedPayment(db, order.scope, order.reference, paidTxn(order))).toBe('late_reinstated');
    expect((await db.order.findUniqueOrThrow({ where: { id: order.orderId } })).status).toBe('PAYMENT_CONFIRMED');
    expect(await stock(order.variantId)).toEqual({ onHand: 4, reserved: 0 });
    const event = await db.orderStatusEvent.findFirstOrThrow({ where: { orderId: order.orderId, reason: 'late_payment_reinstated' } });
    expect(event.fromStatus).toBe('CANCELLED');
    expect(await db.refund.count({ where: { orderId: order.orderId } })).toBe(0);
  });

  it('does not oversell: when the stock is gone, the order stays cancelled and a refund is pending for staff', async () => {
    const order = await newOrder({ onHand: 5, quantity: 1 });
    await expireReservation(order);
    await db.productVariant.update({ where: { id: order.variantId }, data: { onHand: 0 } });
    expect(await applyVerifiedPayment(db, order.scope, order.reference, paidTxn(order))).toBe('late_success');
    expect((await db.order.findUniqueOrThrow({ where: { id: order.orderId } })).status).toBe('CANCELLED');
    expect((await db.payment.findUniqueOrThrow({ where: { id: order.paymentId } })).status).toBe('SUCCEEDED');
    expect(await stock(order.variantId)).toEqual({ onHand: 0, reserved: 0 });
    const refund = await db.refund.findFirstOrThrow({ where: { orderId: order.orderId } });
    expect(refund.status).toBe('PENDING');
    expect(refund.amountMinor).toBe(order.amountMinor);
    expect(await review(order.paymentId)).toEqual(['late_success']);
  });

  it('a payment for an order the customer cancelled is refunded, not reinstated', async () => {
    const order = await newOrder({ onHand: 5, quantity: 1 });
    await expireReservation(order, 'customer cancelled');
    expect(await applyVerifiedPayment(db, order.scope, order.reference, paidTxn(order))).toBe('late_success');
    expect((await db.order.findUniqueOrThrow({ where: { id: order.orderId } })).status).toBe('CANCELLED');
    expect(await db.refund.count({ where: { orderId: order.orderId, status: 'PENDING' } })).toBe(1);
  });

  it('a second successful payment for a paid order is flagged, never confirmed twice, and not refunded automatically', async () => {
    const order = await newOrder({ onHand: 5, quantity: 1 });
    expect(await applyVerifiedPayment(db, order.scope, order.reference, paidTxn(order))).toBe('confirmed');
    const second = await db.payment.create({
      data: { businessId: order.businessId, orderId: order.orderId, provider: 'PAYSTACK', reference: unique('pay'), status: 'INITIALIZED', amountMinor: order.amountMinor, currency: 'NGN' },
    });
    expect(await applyVerifiedPayment(db, order.scope, second.reference, paidTxn({ reference: second.reference, amountMinor: order.amountMinor }))).toBe('second_payment');
    expect((await db.order.findUniqueOrThrow({ where: { id: order.orderId } })).status).toBe('PAYMENT_CONFIRMED');
    expect(await stock(order.variantId)).toEqual({ onHand: 4, reserved: 0 });
    expect(await db.refund.count({ where: { orderId: order.orderId } })).toBe(0);
    expect(await review(second.id)).toEqual(['second_payment_for_paid_order']);
  });
});

describe('payment routes', () => {
  it('the webhook route refuses an unsigned request without writing anything', async () => {
    const response = await postWebhook(
      new Request('http://localhost:3000/api/webhooks/paystack', {
        method: 'POST',
        headers: { 'x-paystack-signature': 'deadbeef' },
        body: JSON.stringify({ event: 'charge.success', data: { id: 1, reference: 'pay_x', status: 'success' } }),
      }),
    );
    expect(response.status).toBe(400);
  });

  it('the job runner route does not exist without JOB_RUNNER_SECRET', async () => {
    const response = await postJobs(new Request('http://localhost:3000/api/internal/jobs/run', { method: 'POST', headers: { authorization: 'Bearer x' } }));
    expect(response.status).toBe(404);
  });
});
