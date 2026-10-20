// Refund workflow (06 §4.6, FR-PAY-07, 02 §6.5), against a real PostgreSQL database with a scripted
// provider. Covers: request limits and idempotency, two-person approval, execution exactly once,
// definitive refusal and unknown outcome, webhook-before-execute, completion to REFUNDED, partial
// refunds, final-state protection, the webhook job, the stale-refund sweep, and the paid-order transitions.
import { createHmac } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '@/server/auth/password';
import type { StaffRoleName } from '@/server/auth/permissions';
import { resolveStaffActor, signIn, type StaffActor } from '@/server/auth/staff';
import { setCartItem, viewCart } from '@/server/cart/cart';
import { placeOrder } from '@/server/checkout/checkout';
import { CheckoutBodySchema } from '@/server/checkout/schema';
import { transitionOrderForStaff } from '@/server/orders/admin';
import { applyVerifiedPayment } from '@/server/payments/confirm';
import { receivePaystackWebhook } from '@/server/payments/webhook';
import { PaystackError } from '@/server/payments/paystack';
import type { InitializeInput, PaymentProvider, RefundOutcome, VerifiedTransaction } from '@/server/payments/provider';
import { runDueJobs } from '@/server/jobs/runner';
import { applyProviderStatus, executeRefund, listRefundsForOrder, refundReconcileHandler, requestRefund, approveRefund, sweepStaleRefunds } from '@/server/refunds/service';
import { createPrisma, unique } from './helpers';
import { checkoutBody, createProduct, createStore } from './commerce-fixtures';

let db: PrismaClient;
const PASSWORD = 'correct horse battery staple';
const THRESHOLD = 5_000_000n;

beforeAll(() => {
  db = createPrisma();
});

afterAll(async () => {
  await db.$disconnect();
});

// A provider scripted for refunds. Each refund call uses the next step ('ok', 'refused' or 'unknown').
// Provider state for a refund is kept here, so getRefund answers as a real provider would.
type Step = 'ok' | 'refused' | 'unknown';

class ScriptedRefunds implements PaymentProvider {
  readonly name = 'PAYSTACK' as const;
  readonly refundCalls: { providerTransactionId: string; amountMinor: bigint }[] = [];
  readonly statuses = new Map<string, RefundOutcome>();
  private readonly steps: Step[] = [];
  private readonly ids: string[] = [];

  script(...steps: Step[]): void {
    this.steps.push(...steps);
  }

  /** The provider id the next successful refund will get. */
  nextId(id: string): void {
    this.ids.push(id);
  }

  async initialize(): Promise<never> {
    throw new Error('not used in refund tests');
  }

  async verify(): Promise<VerifiedTransaction> {
    throw new Error('not used in refund tests');
  }

  async refund(input: { providerTransactionId: string; amountMinor: bigint; reference: string }) {
    this.refundCalls.push({ providerTransactionId: input.providerTransactionId, amountMinor: input.amountMinor });
    const step = this.steps.shift() ?? 'ok';
    if (step === 'refused') throw new PaystackError('Transaction not found', 400, false);
    if (step === 'unknown') throw new PaystackError('Paystack request failed (network or timeout)', null, true);
    const providerRefundId = this.ids.shift() ?? unique('rf');
    this.statuses.set(providerRefundId, 'PROCESSING');
    return { providerRefundId, status: 'PROCESSING' as const };
  }

  async getRefund(providerRefundId: string) {
    const status = this.statuses.get(providerRefundId);
    if (!status) throw new PaystackError('refund not found', 404, false);
    return { providerRefundId, status };
  }
}

// A provider that is only asked to start a payment, for the checkout fixture.
const startOnly = {
  name: 'PAYSTACK' as const,
  async initialize(input: InitializeInput) {
    return { authorizationUrl: `https://checkout.paystack.test/${input.reference}`, providerReference: input.reference };
  },
  async verify(): Promise<VerifiedTransaction> {
    throw new Error('not used in refund tests');
  },
  async refund(): Promise<never> {
    throw new Error('not used in refund tests');
  },
  async getRefund(): Promise<never> {
    throw new Error('not used in refund tests');
  },
} satisfies PaymentProvider;

async function staffActor(role: StaffRoleName, businessId: string): Promise<StaffActor> {
  const email = `${unique('staff')}@example.test`;
  const user = await db.staffUser.create({
    data: { email, fullName: 'Test Staff', passwordHash: await hashPassword(PASSWORD), mfaEnabled: false },
    select: { id: true },
  });
  await db.staffMembership.create({ data: { businessId, staffUserId: user.id, role } });
  const { token } = await signIn(db, { businessId, email, password: PASSWORD, ip: null, userAgent: null });
  const actor = await resolveStaffActor(db, businessId, token, { ip: '198.51.100.2', userAgent: 'vitest' });
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
async function awaitingOrder(quantity = 2) {
  const store = await createStore(db);
  const product = await createProduct(db, store.businessId, { onHand: 5 });
  const cart = await cartWith(store, product.variantId, quantity);
  const result = await placeOrder(db, store.store, {
    cartToken: cart.token,
    idempotencyKey: unique('k'),
    body: CheckoutBodySchema.parse(checkoutBody({ expected: cart.snapshot })),
    provider: startOnly,
  });
  const orderId = result.body.order.id as string;
  const payment = await db.payment.findFirstOrThrow({ where: { orderId } });
  return { businessId: store.businessId, scope: store.scope, orderId, reference: payment.reference, amountMinor: payment.amountMinor };
}

/** An order paid through the real verification rules: PAYMENT_CONFIRMED. */
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
  expect(await applyVerifiedPayment(db, order.scope, order.reference, txn)).toBe('confirmed');
  return order;
}

async function orderVersion(orderId: string): Promise<number> {
  return (await db.order.findUniqueOrThrow({ where: { id: orderId }, select: { version: true } })).version;
}

/** A paid order moved to REFUND_PENDING by an Admin, through the same transition endpoint staff use. */
async function refundPendingOrder() {
  const order = await paidOrder();
  const admin = await staffActor('ADMIN', order.businessId);
  await transitionOrderForStaff(db, admin, { orderId: order.orderId, expectedVersion: await orderVersion(order.orderId), to: 'REFUND_PENDING', reason: 'customer cancelled' });
  return order;
}

async function expectAppError(action: Promise<unknown>, status: number, code: string): Promise<void> {
  const error = await action.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toMatchObject({ status, code });
}

async function refundRow(id: string) {
  return db.refund.findUniqueOrThrow({ where: { id } });
}

async function orderStatus(orderId: string): Promise<string> {
  return (await db.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true } })).status;
}

describe('requesting a refund', () => {
  it('refuses a refund for an order that has no verified payment', async () => {
    const order = await awaitingOrder();
    const admin = await staffActor('ADMIN', order.businessId);
    await expectAppError(
      requestRefund(db, admin, { orderId: order.orderId, amountMinor: 100n, reason: 'changed mind', idempotencyKey: unique('k') }),
      422,
      'no_payment_to_refund',
    );
  });

  it('refuses a refund while the order is not waiting for one', async () => {
    const order = await paidOrder();
    const admin = await staffActor('ADMIN', order.businessId);
    await expectAppError(
      requestRefund(db, admin, { orderId: order.orderId, amountMinor: 100n, reason: 'changed mind', idempotencyKey: unique('k') }),
      422,
      'order_not_refund_pending',
    );
  });

  it('records a PENDING refund with the requester, and a replay with the same key returns it without a second row', async () => {
    const order = await refundPendingOrder();
    const admin = await staffActor('ADMIN', order.businessId);
    const key = unique('k');
    const first = await requestRefund(db, admin, { orderId: order.orderId, amountMinor: 1000n, reason: 'damaged item', idempotencyKey: key });
    const second = await requestRefund(db, admin, { orderId: order.orderId, amountMinor: 1000n, reason: 'damaged item', idempotencyKey: key });

    expect(first.status).toBe(201);
    expect(second).toEqual(first);
    const body = first.body as { id: string; status: string; requestedByStaffId: string; amountMinor: string };
    expect(body).toMatchObject({ status: 'PENDING', requestedByStaffId: admin.staffUserId, amountMinor: '1000' });
    expect(await db.refund.count({ where: { orderId: order.orderId } })).toBe(1);
    expect((await db.auditLog.findFirstOrThrow({ where: { action: 'REFUND_REQUESTED', entityId: body.id } })).actorType).toBe('STAFF');
  });

  it('refuses the same key with a different body (422)', async () => {
    const order = await refundPendingOrder();
    const admin = await staffActor('ADMIN', order.businessId);
    const key = unique('k');
    await requestRefund(db, admin, { orderId: order.orderId, amountMinor: 1000n, reason: 'damaged item', idempotencyKey: key });
    await expectAppError(
      requestRefund(db, admin, { orderId: order.orderId, amountMinor: 2000n, reason: 'damaged item', idempotencyKey: key }),
      422,
      'idempotency_key_reused',
    );
  });

  it('allows partial refunds, and refuses a total that goes over what was paid, reporting what is left', async () => {
    const order = await refundPendingOrder();
    const admin = await staffActor('ADMIN', order.businessId);
    const paid = order.amountMinor;
    await requestRefund(db, admin, { orderId: order.orderId, amountMinor: paid - 10n, reason: 'partial', idempotencyKey: unique('k') });
    const error = await requestRefund(db, admin, { orderId: order.orderId, amountMinor: 11n, reason: 'too much', idempotencyKey: unique('k') }).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 422, code: 'refund_exceeds_paid', extra: { remainingMinor: '10' } });
  });

  it('lets exactly one of five parallel full-amount requests through', async () => {
    const order = await refundPendingOrder();
    const admin = await staffActor('ADMIN', order.businessId);
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => requestRefund(db, admin, { orderId: order.orderId, amountMinor: order.amountMinor, reason: 'full refund', idempotencyKey: unique('k') })),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await db.refund.count({ where: { orderId: order.orderId } })).toBe(1);
  });

  it('refuses a role without refunds.request (Fulfilment)', async () => {
    const order = await refundPendingOrder();
    const fulfilment = await staffActor('FULFILMENT', order.businessId);
    await expectAppError(
      requestRefund(db, fulfilment, { orderId: order.orderId, amountMinor: 100n, reason: 'no', idempotencyKey: unique('k') }),
      403,
      'forbidden',
    );
  });
});

describe('approval', () => {
  it('refuses approval by Admin, who may request but not approve', async () => {
    const order = await refundPendingOrder();
    const admin = await staffActor('ADMIN', order.businessId);
    const requested = await requestRefund(db, admin, { orderId: order.orderId, amountMinor: 500n, reason: 'x y z', idempotencyKey: unique('k') });
    const id = (requested.body as { id: string }).id;
    await expectAppError(approveRefund(db, admin, id, { thresholdMinor: THRESHOLD }), 403, 'forbidden');
  });

  it('lets the requester approve a refund at or below the threshold', async () => {
    const order = await refundPendingOrder();
    const finance = await staffActor('FINANCE', order.businessId);
    // The threshold equals the refund amount, so this is exactly at the limit.
    const requested = await requestRefund(db, finance, { orderId: order.orderId, amountMinor: order.amountMinor, reason: 'small', idempotencyKey: unique('k') });
    const approved = await approveRefund(db, finance, (requested.body as { id: string }).id, { thresholdMinor: order.amountMinor });
    expect(approved).toMatchObject({ status: 'PENDING', approvedByStaffId: finance.staffUserId });
  });

  it('refuses the requester approving above the threshold, and lets another Owner or Finance approve', async () => {
    const order = await refundPendingOrder();
    const finance = await staffActor('FINANCE', order.businessId);
    const other = await staffActor('OWNER', order.businessId);
    // The threshold is one kobo below the amount, so this refund is just above the limit.
    const threshold = order.amountMinor - 1n;
    const requested = await requestRefund(db, finance, { orderId: order.orderId, amountMinor: order.amountMinor, reason: 'large', idempotencyKey: unique('k') });
    const id = (requested.body as { id: string }).id;

    await expectAppError(approveRefund(db, finance, id, { thresholdMinor: threshold }), 403, 'second_approver_required');
    const approved = await approveRefund(db, other, id, { thresholdMinor: threshold });
    expect(approved).toMatchObject({ approvedByStaffId: other.staffUserId, requestedByStaffId: finance.staffUserId });
  });

  it('refuses a second approval (409) and changes nothing', async () => {
    const order = await refundPendingOrder();
    const owner = await staffActor('OWNER', order.businessId);
    const requested = await requestRefund(db, owner, { orderId: order.orderId, amountMinor: 500n, reason: 'x y z', idempotencyKey: unique('k') });
    const id = (requested.body as { id: string }).id;
    await approveRefund(db, owner, id, { thresholdMinor: THRESHOLD });
    await expectAppError(approveRefund(db, owner, id, { thresholdMinor: THRESHOLD }), 409, 'already_approved');
  });

  it('lets a system-requested refund (a late payment) be approved by anyone with refunds.approve', async () => {
    const order = await paidOrder();
    const refund = await db.refund.create({
      data: {
        businessId: order.businessId,
        paymentId: (await db.payment.findFirstOrThrow({ where: { orderId: order.orderId } })).id,
        orderId: order.orderId,
        amountMinor: order.amountMinor,
        reason: 'late payment: stock no longer available',
        status: 'PENDING',
      },
    });
    const owner = await staffActor('OWNER', order.businessId);
    const approved = await approveRefund(db, owner, refund.id, { thresholdMinor: THRESHOLD });
    expect(approved.approvedByStaffId).toBe(owner.staffUserId);
  });
});

describe('execution', () => {
  it('does not send an unapproved refund', async () => {
    const order = await refundPendingOrder();
    const owner = await staffActor('OWNER', order.businessId);
    const provider = new ScriptedRefunds();
    const requested = await requestRefund(db, owner, { orderId: order.orderId, amountMinor: 500n, reason: 'x y z', idempotencyKey: unique('k') });
    await expectAppError(executeRefund(db, provider, owner, (requested.body as { id: string }).id), 422, 'refund_not_approved');
    expect(provider.refundCalls).toHaveLength(0);
  });

  it('sends an approved refund once; a second execute is refused without calling the provider', async () => {
    const order = await refundPendingOrder();
    const owner = await staffActor('OWNER', order.businessId);
    const provider = new ScriptedRefunds();
    const requested = await requestRefund(db, owner, { orderId: order.orderId, amountMinor: 500n, reason: 'x y z', idempotencyKey: unique('k') });
    const id = (requested.body as { id: string }).id;
    await approveRefund(db, owner, id, { thresholdMinor: THRESHOLD });

    const sent = await executeRefund(db, provider, owner, id);
    expect(sent).toMatchObject({ status: 'PROCESSING', amountMinor: '500' });
    expect(typeof sent.providerRefundId).toBe('string');
    expect(provider.refundCalls).toHaveLength(1);
    expect(provider.refundCalls[0].amountMinor).toBe(500n);

    await expectAppError(executeRefund(db, provider, owner, id), 409, 'refund_already_executed');
    expect(provider.refundCalls).toHaveLength(1);
  });

  it('calls the provider once when two executes run at the same time', async () => {
    const order = await refundPendingOrder();
    const owner = await staffActor('OWNER', order.businessId);
    const provider = new ScriptedRefunds();
    const requested = await requestRefund(db, owner, { orderId: order.orderId, amountMinor: 500n, reason: 'x y z', idempotencyKey: unique('k') });
    const id = (requested.body as { id: string }).id;
    await approveRefund(db, owner, id, { thresholdMinor: THRESHOLD });

    const results = await Promise.allSettled([executeRefund(db, provider, owner, id), executeRefund(db, provider, owner, id)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(provider.refundCalls).toHaveLength(1);
  });

  it('a definitive refusal marks the refund FAILED and frees its amount for a new request', async () => {
    const order = await refundPendingOrder();
    const owner = await staffActor('OWNER', order.businessId);
    const provider = new ScriptedRefunds();
    provider.script('refused');
    const requested = await requestRefund(db, owner, { orderId: order.orderId, amountMinor: order.amountMinor, reason: 'full', idempotencyKey: unique('k') });
    const id = (requested.body as { id: string }).id;
    await approveRefund(db, owner, id, { thresholdMinor: THRESHOLD });

    const failed = await executeRefund(db, provider, owner, id);
    expect(failed).toMatchObject({ status: 'FAILED', failureReason: 'provider_refused' });
    expect(await orderStatus(order.orderId)).toBe('REFUND_PENDING');

    const again = await requestRefund(db, owner, { orderId: order.orderId, amountMinor: order.amountMinor, reason: 'retry', idempotencyKey: unique('k') });
    expect(again.status).toBe(201);
  });

  it('an unknown outcome leaves the refund PROCESSING, answers 502, and is not sent again', async () => {
    const order = await refundPendingOrder();
    const owner = await staffActor('OWNER', order.businessId);
    const provider = new ScriptedRefunds();
    provider.script('unknown');
    const requested = await requestRefund(db, owner, { orderId: order.orderId, amountMinor: 500n, reason: 'x y z', idempotencyKey: unique('k') });
    const id = (requested.body as { id: string }).id;
    await approveRefund(db, owner, id, { thresholdMinor: THRESHOLD });

    await expectAppError(executeRefund(db, provider, owner, id), 502, 'refund_uncertain');
    const row = await refundRow(id);
    expect(row).toMatchObject({ status: 'PROCESSING', failureReason: 'provider_outcome_unknown', providerRefundId: null });
    await expectAppError(executeRefund(db, provider, owner, id), 409, 'refund_already_executed');
    expect(provider.refundCalls).toHaveLength(1);
    expect(await db.auditLog.count({ where: { action: 'REFUND_EXECUTION_UNCERTAIN', entityId: id } })).toBe(1);
  });

  it('writes an audit row for each step: requested, approved, execution started, status changed', async () => {
    const order = await refundPendingOrder();
    const owner = await staffActor('OWNER', order.businessId);
    const provider = new ScriptedRefunds();
    const requested = await requestRefund(db, owner, { orderId: order.orderId, amountMinor: 500n, reason: 'x y z', idempotencyKey: unique('k') });
    const id = (requested.body as { id: string }).id;
    await approveRefund(db, owner, id, { thresholdMinor: THRESHOLD });
    await executeRefund(db, provider, owner, id);
    const actions = (await db.auditLog.findMany({ where: { entityId: id }, select: { action: true } })).map((a) => a.action).sort();
    expect(actions).toEqual(['REFUND_APPROVED', 'REFUND_EXECUTION_STARTED', 'REFUND_REQUESTED', 'REFUND_STATUS_CHANGED'].sort());
  });
});

describe('provider status and completion', () => {
  it('a status that arrives before the refund is recorded waits, then settles it once the refund exists', async () => {
    const order = await refundPendingOrder();
    const owner = await staffActor('OWNER', order.businessId);
    const provider = new ScriptedRefunds();
    const id = unique('rf_early');
    provider.nextId(id);
    provider.statuses.set(id, 'SUCCEEDED');
    const requested = await requestRefund(db, owner, { orderId: order.orderId, amountMinor: order.amountMinor, reason: 'full', idempotencyKey: unique('k') });
    const refundId = (requested.body as { id: string }).id;
    await approveRefund(db, owner, refundId, { thresholdMinor: THRESHOLD });

    // The webhook job runs before the execute response is stored: nothing is recorded yet, so it retries.
    const handler = refundReconcileHandler(db, provider);
    const early = await handler({ id: 'job', businessId: null, payload: { providerRefundId: id }, attempts: 1 }).catch((e: unknown) => e);
    expect(early).toBeInstanceOf(Error);
    expect((early as Error).message).toMatch(/not recorded yet/);
    expect(await orderStatus(order.orderId)).toBe('REFUND_PENDING');

    await executeRefund(db, provider, owner, refundId);
    provider.statuses.set(id, 'SUCCEEDED');
    await handler({ id: 'job', businessId: null, payload: { providerRefundId: id }, attempts: 2 });
    expect(await refundRow(refundId)).toMatchObject({ status: 'SUCCEEDED', providerRefundId: id });
    expect(await orderStatus(order.orderId)).toBe('REFUNDED');
  });

  it('a full refund completes the order to REFUNDED and records the status event', async () => {
    const order = await refundPendingOrder();
    const owner = await staffActor('OWNER', order.businessId);
    const provider = new ScriptedRefunds();
    const requested = await requestRefund(db, owner, { orderId: order.orderId, amountMinor: order.amountMinor, reason: 'full', idempotencyKey: unique('k') });
    const refundId = (requested.body as { id: string }).id;
    await approveRefund(db, owner, refundId, { thresholdMinor: THRESHOLD });
    await executeRefund(db, provider, owner, refundId);
    const providerRefundId = (await refundRow(refundId)).providerRefundId as string;

    provider.statuses.set(providerRefundId, 'SUCCEEDED');
    expect(await applyProviderStatus(db, providerRefundId, 'SUCCEEDED')).toBe('updated');
    expect(await orderStatus(order.orderId)).toBe('REFUNDED');
    expect(await db.orderStatusEvent.count({ where: { orderId: order.orderId, toStatus: 'REFUNDED', reason: 'refund_completed' } })).toBe(1);
    expect((await refundRow(refundId)).processedAt).not.toBeNull();
  });

  it('a partial refund leaves the order REFUND_PENDING until the rest is refunded', async () => {
    const order = await refundPendingOrder();
    const owner = await staffActor('OWNER', order.businessId);
    const provider = new ScriptedRefunds();
    const half = order.amountMinor / 2n;

    const first = await requestRefund(db, owner, { orderId: order.orderId, amountMinor: half, reason: 'half', idempotencyKey: unique('k') });
    const firstId = (first.body as { id: string }).id;
    await approveRefund(db, owner, firstId, { thresholdMinor: THRESHOLD });
    await executeRefund(db, provider, owner, firstId);
    await applyProviderStatus(db, (await refundRow(firstId)).providerRefundId as string, 'SUCCEEDED');
    expect(await orderStatus(order.orderId)).toBe('REFUND_PENDING');

    const rest = await requestRefund(db, owner, { orderId: order.orderId, amountMinor: order.amountMinor - half, reason: 'rest', idempotencyKey: unique('k') });
    const restId = (rest.body as { id: string }).id;
    await approveRefund(db, owner, restId, { thresholdMinor: THRESHOLD });
    await executeRefund(db, provider, owner, restId);
    await applyProviderStatus(db, (await refundRow(restId)).providerRefundId as string, 'SUCCEEDED');
    expect(await orderStatus(order.orderId)).toBe('REFUNDED');
  });

  it('a final state is never changed again', async () => {
    const order = await refundPendingOrder();
    const owner = await staffActor('OWNER', order.businessId);
    const provider = new ScriptedRefunds();
    const requested = await requestRefund(db, owner, { orderId: order.orderId, amountMinor: 500n, reason: 'x y z', idempotencyKey: unique('k') });
    const refundId = (requested.body as { id: string }).id;
    await approveRefund(db, owner, refundId, { thresholdMinor: THRESHOLD });
    await executeRefund(db, provider, owner, refundId);
    const providerRefundId = (await refundRow(refundId)).providerRefundId as string;
    await applyProviderStatus(db, providerRefundId, 'SUCCEEDED');

    expect(await applyProviderStatus(db, providerRefundId, 'FAILED')).toBe('unchanged');
    expect((await refundRow(refundId)).status).toBe('SUCCEEDED');
  });

  it('a refund webhook is accepted, and the refund.reconcile job settles the refund', async () => {
    const order = await refundPendingOrder();
    const owner = await staffActor('OWNER', order.businessId);
    const provider = new ScriptedRefunds();
    const providerRefundId = unique('rf_hook');
    provider.nextId(providerRefundId);
    const requested = await requestRefund(db, owner, { orderId: order.orderId, amountMinor: order.amountMinor, reason: 'full', idempotencyKey: unique('k') });
    const refundId = (requested.body as { id: string }).id;
    await approveRefund(db, owner, refundId, { thresholdMinor: THRESHOLD });
    await executeRefund(db, provider, owner, refundId);

    provider.statuses.set(providerRefundId, 'SUCCEEDED');
    const secret = 'whsec_refund_test_only';
    const raw = Buffer.from(JSON.stringify({ event: 'refund.processed', data: { id: providerRefundId, status: 'processed' } }));
    const signature = createHmac('sha512', secret).update(raw).digest('hex');
    const result = await receivePaystackWebhook(db, raw, signature, secret);
    expect(result).toEqual({ status: 200, result: 'accepted' });

    const job = await db.job.findFirstOrThrow({ where: { type: 'refund.reconcile', payload: { path: ['providerRefundId'], equals: providerRefundId } } });
    expect(job.businessId).toBeNull();
    await runDueJobs(db, { 'refund.reconcile': refundReconcileHandler(db, provider) }, { limit: 500 });
    expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('SUCCEEDED');
    expect(await refundRow(refundId)).toMatchObject({ status: 'SUCCEEDED' });
    expect(await orderStatus(order.orderId)).toBe('REFUNDED');
  });

  it('a stale PROCESSING refund is checked with the provider by the sweep', async () => {
    const order = await refundPendingOrder();
    const owner = await staffActor('OWNER', order.businessId);
    const provider = new ScriptedRefunds();
    const requested = await requestRefund(db, owner, { orderId: order.orderId, amountMinor: order.amountMinor, reason: 'full', idempotencyKey: unique('k') });
    const refundId = (requested.body as { id: string }).id;
    await approveRefund(db, owner, refundId, { thresholdMinor: THRESHOLD });
    await executeRefund(db, provider, owner, refundId);
    const providerRefundId = (await refundRow(refundId)).providerRefundId as string;
    provider.statuses.set(providerRefundId, 'SUCCEEDED');
    await db.$executeRaw`UPDATE "Refund" SET "updatedAt" = now() - interval '1 hour' WHERE id = ${refundId}::uuid`;

    const summary = await sweepStaleRefunds(db, provider, { limit: 1000 });
    expect(summary.updated).toBeGreaterThanOrEqual(1);
    expect(await refundRow(refundId)).toMatchObject({ status: 'SUCCEEDED' });
    expect(await orderStatus(order.orderId)).toBe('REFUNDED');
  });

  it('lists the refunds of an order, oldest first, and answers 404 for an unknown order', async () => {
    const order = await refundPendingOrder();
    const owner = await staffActor('OWNER', order.businessId);
    await requestRefund(db, owner, { orderId: order.orderId, amountMinor: 100n, reason: 'first', idempotencyKey: unique('k') });
    await requestRefund(db, owner, { orderId: order.orderId, amountMinor: 200n, reason: 'second', idempotencyKey: unique('k') });
    const list = await listRefundsForOrder(db, order.scope, order.orderId);
    expect(list.map((r) => r.amountMinor)).toEqual(['100', '200']);
    await expectAppError(listRefundsForOrder(db, order.scope, '00000000-0000-4000-8000-000000000000'), 404, 'order_not_found');
  });
});

describe('moving a paid order to REFUND_PENDING', () => {
  it('lets an Admin cancel a paid order into REFUND_PENDING, but not a Manager', async () => {
    const order = await paidOrder();
    const manager = await staffActor('MANAGER', order.businessId);
    await expectAppError(
      transitionOrderForStaff(db, manager, { orderId: order.orderId, expectedVersion: await orderVersion(order.orderId), to: 'REFUND_PENDING', reason: 'x' }),
      403,
      'forbidden',
    );
    const admin = await staffActor('ADMIN', order.businessId);
    const result = await transitionOrderForStaff(db, admin, { orderId: order.orderId, expectedVersion: await orderVersion(order.orderId), to: 'REFUND_PENDING', reason: 'customer cancelled' });
    expect(result.status).toBe('REFUND_PENDING');
  });

  it('a return from DELIVERED needs refunds.approve: Finance may, Admin may not', async () => {
    const order = await paidOrder();
    await db.order.update({ where: { id: order.orderId }, data: { status: 'DELIVERED' } });
    const admin = await staffActor('ADMIN', order.businessId);
    await expectAppError(
      transitionOrderForStaff(db, admin, { orderId: order.orderId, expectedVersion: await orderVersion(order.orderId), to: 'REFUND_PENDING', reason: 'return' }),
      403,
      'forbidden',
    );
    const finance = await staffActor('FINANCE', order.businessId);
    const result = await transitionOrderForStaff(db, finance, { orderId: order.orderId, expectedVersion: await orderVersion(order.orderId), to: 'REFUND_PENDING', reason: 'return' });
    expect(result.status).toBe('REFUND_PENDING');
  });
});
