import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setCartItem, viewCart } from '@/server/cart/cart';
import { placeOrder } from '@/server/checkout/checkout';
import { CheckoutBodySchema } from '@/server/checkout/schema';
import { grantOrderLookup, findOrderForCustomer, signInWithOtp, signOutCustomer } from '@/server/customers/auth';
import type { OtpMessage, OtpSender } from '@/server/customers/delivery';
import { OTP_COOLDOWN_MS, OTP_MAX_ATTEMPTS, OTP_TTL_MS, requestOtp, verifyOtp } from '@/server/customers/otp';
import { codeTargetPhone } from '@/server/customers/target';
import {
  accessesFromCookies,
  CUSTOMER_COOKIE,
  CUSTOMER_SESSION_MS,
  hashCustomerToken,
  ORDER_COOKIE,
  ORDER_SESSION_MS,
  resolveCustomerSession,
  revokeCustomerSession,
} from '@/server/customers/sessions';
import { stringifyJson } from '@/lib/json';
import { AppError } from '@/server/http/problem';
import { MockPaymentProvider } from '@/server/payments/mock';
import { buildOrderView } from '@/server/orders/view';
import { createPrisma, unique } from './helpers';
import { checkoutBody, createProduct, createStore } from './commerce-fixtures';

// Customer OTP sign-in, order lookup and order access, against a real PostgreSQL database.
// Every call passes `now` explicitly, so the time-based rules are tested without waiting.

let db: PrismaClient;
const provider = new MockPaymentProvider();
const PHONE = '+2348012345678';
const OTHER_PHONE = '+2348099990000';
const T0 = new Date('2026-10-21T10:00:00Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const MINUTE = 60 * 1000;

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

class FailingSender implements OtpSender {
  async send(): Promise<void> {
    throw new Error('provider unavailable');
  }
}

beforeAll(() => {
  db = createPrisma();
});

afterAll(async () => {
  await db.$disconnect();
});

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

/** Builds a cart and checks out to create a real order for a phone. */
async function placeTestOrder(store: Awaited<ReturnType<typeof createStore>>, phone: string) {
  const product = await createProduct(db, store.businessId, { priceMinor: 1500000n, onHand: 50 });
  const setItem = await setCartItem(db, store.scope, { token: null, variantId: product.variantId, quantity: 1 });
  const view = await viewCart(db, store.store, { token: setItem.newToken, state: 'Lagos' });
  const snapshot = {
    totalMinor: view.totalMinor.toString(),
    lines: view.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity, unitPriceMinor: l.unitPriceMinor.toString() })),
  };
  const body = CheckoutBodySchema.parse(checkoutBody({ phone, expected: snapshot }));
  const result = await placeOrder(db, store.store, { cartToken: setItem.newToken, idempotencyKey: unique('key'), body, provider });
  return { id: result.body.order.id as string, orderNumber: result.body.order.orderNumber as string };
}

describe('OTP requests (FR-CUS-01)', () => {
  it('sends one six-digit code to the typed number and stores only a keyed hash', async () => {
    const store = await createStore(db);
    const sender = new CaptureSender();
    const answer = await requestOtp(db, sender, { businessId: store.businessId, purpose: 'CUSTOMER_LOGIN', phoneE164: PHONE }, { now: T0, key: 'k'.repeat(32) });
    expect(answer).toEqual({ accepted: true, expiresInSeconds: OTP_TTL_MS / 1000 });
    expect(sender.sent).toHaveLength(1);
    expect(sender.last().phoneE164).toBe(PHONE);
    expect(sender.last().code).toMatch(/^\d{6}$/);

    const row = await db.otpChallenge.findFirstOrThrow({ where: { businessId: store.businessId, phoneE164: PHONE } });
    expect(row.codeHash).toHaveLength(64);
    expect(row.codeHash).not.toBe(sender.last().code);
    expect(row.codeHash).not.toBe(createHash('sha256').update(sender.last().code).digest('hex'));
    expect(row.maxAttempts).toBe(OTP_MAX_ATTEMPTS);
  });

  it('answers the same for an unknown order number, and sends nothing', async () => {
    const store = await createStore(db);
    const sender = new CaptureSender();
    const phone = await codeTargetPhone(db, store.scope, { purpose: 'ORDER_LOOKUP', orderNumber: 'ORD-999999' });
    expect(phone).toBeNull();
    const answer = await requestOtp(db, sender, { businessId: store.businessId, purpose: 'ORDER_LOOKUP', phoneE164: phone }, { now: T0 });
    expect(answer).toEqual({ accepted: true, expiresInSeconds: OTP_TTL_MS / 1000 });
    expect(sender.sent).toHaveLength(0);
    expect(await db.otpChallenge.count({ where: { businessId: store.businessId } })).toBe(0);
  });

  it('for order lookup, sends to the phone on the order, not to any number in the request', async () => {
    const store = await createStore(db);
    const order = await placeTestOrder(store, PHONE);
    const phone = await codeTargetPhone(db, store.scope, { purpose: 'ORDER_LOOKUP', orderNumber: order.orderNumber });
    expect(phone).toBe(PHONE);
  });

  it('enforces the 60-second cooldown between sends to the same phone and purpose', async () => {
    const store = await createStore(db);
    const sender = new CaptureSender();
    const send = (ms: number) => requestOtp(db, sender, { businessId: store.businessId, purpose: 'CUSTOMER_LOGIN', phoneE164: PHONE }, { now: at(ms) });
    await send(0);
    await send(30 * 1000);
    expect(sender.sent).toHaveLength(1);
    await send(OTP_COOLDOWN_MS + 1000);
    expect(sender.sent).toHaveLength(2);
  });

  it('allows at most five sends per phone and purpose in an hour', async () => {
    const store = await createStore(db);
    const sender = new CaptureSender();
    const send = (ms: number) => requestOtp(db, sender, { businessId: store.businessId, purpose: 'CUSTOMER_LOGIN', phoneE164: PHONE }, { now: at(ms) });
    for (let i = 0; i < 5; i++) await send(i * 2 * MINUTE);
    expect(sender.sent).toHaveLength(5);
    await send(10 * MINUTE); // sixth request inside the hour: refused quietly
    expect(sender.sent).toHaveLength(5);
    // Once the earliest sends are an hour old, a new one is allowed again.
    await send(61 * MINUTE);
    expect(sender.sent).toHaveLength(6);
  });

  it('does not send to an erased customer', async () => {
    const store = await createStore(db);
    await db.customer.create({
      data: { businessId: store.businessId, phoneE164: PHONE, anonymizedAt: T0 },
    });
    const phone = await codeTargetPhone(db, store.scope, { purpose: 'CUSTOMER_LOGIN', phoneE164: PHONE });
    expect(phone).toBeNull();
  });

  it('reports a delivery failure and leaves no usable code behind', async () => {
    const store = await createStore(db);
    await expectAppError(
      requestOtp(db, new FailingSender(), { businessId: store.businessId, purpose: 'CUSTOMER_LOGIN', phoneE164: PHONE }, { now: T0 }),
      503,
      'otp_delivery_failed',
    );
    expect(await db.otpChallenge.count({ where: { businessId: store.businessId } })).toBe(0);
  });
});

describe('OTP verification (FR-CUS-01)', () => {
  it('signs in with the right code, creates the customer, and stores a hashed session token', async () => {
    const store = await createStore(db);
    const sender = new CaptureSender();
    await requestOtp(db, sender, { businessId: store.businessId, purpose: 'CUSTOMER_LOGIN', phoneE164: PHONE }, { now: T0 });
    const session = await signInWithOtp(db, { businessId: store.businessId, phoneE164: PHONE, code: sender.last().code, ip: null, userAgent: null }, { now: at(MINUTE) });

    const customer = await db.customer.findUniqueOrThrow({ where: { businessId_phoneE164: { businessId: store.businessId, phoneE164: PHONE } } });
    expect(customer.phoneVerifiedAt).not.toBeNull();

    const stored = await db.customerSession.findUniqueOrThrow({ where: { tokenHash: hashCustomerToken(session.token) } });
    expect(stored.customerId).toBe(customer.id);
    expect(stored.scopeOrderId).toBeNull();
    expect(stored.tokenHash).not.toBe(session.token);
    expect(session.expiresAt.getTime() - at(MINUTE).getTime()).toBe(CUSTOMER_SESSION_MS);

    const access = await resolveCustomerSession(db, store.businessId, session.token, at(2 * MINUTE));
    expect(access).toMatchObject({ customerId: customer.id, scopeOrderId: null, kind: 'sign-in' });

    const audit = await db.auditLog.findFirstOrThrow({ where: { businessId: store.businessId, action: 'CUSTOMER_SIGNED_IN' } });
    expect(audit.actorType).toBe('CUSTOMER');
    expect(audit.changes).toBeNull();
  });

  it('a code works once', async () => {
    const store = await createStore(db);
    const sender = new CaptureSender();
    await requestOtp(db, sender, { businessId: store.businessId, purpose: 'CUSTOMER_LOGIN', phoneE164: PHONE }, { now: T0 });
    const code = sender.last().code;
    await signInWithOtp(db, { businessId: store.businessId, phoneE164: PHONE, code, ip: null, userAgent: null }, { now: at(MINUTE) });
    await expectAppError(signInWithOtp(db, { businessId: store.businessId, phoneE164: PHONE, code, ip: null, userAgent: null }, { now: at(2 * MINUTE) }), 422, 'otp_invalid');
  });

  it('locks the code after five wrong attempts, even when the right code comes next', async () => {
    const store = await createStore(db);
    const sender = new CaptureSender();
    await requestOtp(db, sender, { businessId: store.businessId, purpose: 'CUSTOMER_LOGIN', phoneE164: PHONE }, { now: T0 });
    const right = sender.last().code;
    const wrong = right === '000000' ? '000001' : '000000';
    for (let i = 0; i < OTP_MAX_ATTEMPTS; i++) {
      await expectAppError(verifyOtp(db, { businessId: store.businessId, purpose: 'CUSTOMER_LOGIN', phoneE164: PHONE, code: wrong }, { now: at(MINUTE) }), 422, 'otp_invalid');
    }
    await expectAppError(verifyOtp(db, { businessId: store.businessId, purpose: 'CUSTOMER_LOGIN', phoneE164: PHONE, code: right }, { now: at(MINUTE) }), 422, 'otp_invalid');
  });

  it('counts a correct fifth attempt, but not a sixth', async () => {
    const store = await createStore(db);
    const sender = new CaptureSender();
    await requestOtp(db, sender, { businessId: store.businessId, purpose: 'CUSTOMER_LOGIN', phoneE164: PHONE }, { now: T0 });
    const right = sender.last().code;
    const wrong = right === '000000' ? '000001' : '000000';
    for (let i = 0; i < OTP_MAX_ATTEMPTS - 1; i++) {
      await expectAppError(verifyOtp(db, { businessId: store.businessId, purpose: 'CUSTOMER_LOGIN', phoneE164: PHONE, code: wrong }, { now: at(MINUTE) }), 422, 'otp_invalid');
    }
    await verifyOtp(db, { businessId: store.businessId, purpose: 'CUSTOMER_LOGIN', phoneE164: PHONE, code: right }, { now: at(MINUTE) });
  });

  it('rejects a code after ten minutes', async () => {
    const store = await createStore(db);
    const sender = new CaptureSender();
    await requestOtp(db, sender, { businessId: store.businessId, purpose: 'CUSTOMER_LOGIN', phoneE164: PHONE }, { now: T0 });
    await expectAppError(
      verifyOtp(db, { businessId: store.businessId, purpose: 'CUSTOMER_LOGIN', phoneE164: PHONE, code: sender.last().code }, { now: at(OTP_TTL_MS + 1000) }),
      422,
      'otp_invalid',
    );
  });

  it('does not accept a code for another phone, purpose or business', async () => {
    const store = await createStore(db);
    const other = await createStore(db);
    const sender = new CaptureSender();
    await requestOtp(db, sender, { businessId: store.businessId, purpose: 'CUSTOMER_LOGIN', phoneE164: PHONE }, { now: T0 });
    const code = sender.last().code;
    await expectAppError(verifyOtp(db, { businessId: store.businessId, purpose: 'CUSTOMER_LOGIN', phoneE164: OTHER_PHONE, code }, { now: at(MINUTE) }), 422, 'otp_invalid');
    await expectAppError(verifyOtp(db, { businessId: store.businessId, purpose: 'ORDER_LOOKUP', phoneE164: PHONE, code }, { now: at(MINUTE) }), 422, 'otp_invalid');
    await expectAppError(verifyOtp(db, { businessId: other.businessId, purpose: 'CUSTOMER_LOGIN', phoneE164: PHONE, code }, { now: at(MINUTE) }), 422, 'otp_invalid');
  });

  it('refuses sign-in for an erased customer, after the code is checked', async () => {
    const store = await createStore(db);
    await db.customer.create({ data: { businessId: store.businessId, phoneE164: PHONE, anonymizedAt: T0 } });
    const sender = new CaptureSender();
    await requestOtp(db, sender, { businessId: store.businessId, purpose: 'CUSTOMER_LOGIN', phoneE164: PHONE }, { now: T0 });
    await expectAppError(
      signInWithOtp(db, { businessId: store.businessId, phoneE164: PHONE, code: sender.last().code, ip: null, userAgent: null }, { now: at(MINUTE) }),
      409,
      'customer_erased',
    );
  });
});

describe('order lookup (FR-CUS-03)', () => {
  it('opens a session for one order only, and not a sign-in session', async () => {
    const store = await createStore(db);
    const first = await placeTestOrder(store, PHONE);
    const second = await placeTestOrder(store, PHONE);
    const sender = new CaptureSender();
    await requestOtp(db, sender, { businessId: store.businessId, purpose: 'ORDER_LOOKUP', phoneE164: PHONE }, { now: T0 });
    const grant = await grantOrderLookup(db, { businessId: store.businessId, orderNumber: first.orderNumber, code: sender.last().code, ip: null, userAgent: null }, { now: at(MINUTE) });
    expect(grant.orderId).toBe(first.id);
    expect(grant.expiresAt.getTime() - at(MINUTE).getTime()).toBe(ORDER_SESSION_MS);

    const access = await resolveCustomerSession(db, store.businessId, grant.token, at(2 * MINUTE));
    expect(access).toMatchObject({ scopeOrderId: first.id, kind: 'order-lookup' });

    const scope = store.scope;
    await expect(findOrderForCustomer(db, scope, [access!], first.orderNumber)).resolves.toMatchObject({ id: first.id });
    await expectAppError(findOrderForCustomer(db, scope, [access!], second.orderNumber), 404, 'order_not_found');
  });

  it('expires after 30 minutes', async () => {
    const store = await createStore(db);
    const order = await placeTestOrder(store, PHONE);
    const sender = new CaptureSender();
    await requestOtp(db, sender, { businessId: store.businessId, purpose: 'ORDER_LOOKUP', phoneE164: PHONE }, { now: T0 });
    const grant = await grantOrderLookup(db, { businessId: store.businessId, orderNumber: order.orderNumber, code: sender.last().code, ip: null, userAgent: null }, { now: at(MINUTE) });
    expect(await resolveCustomerSession(db, store.businessId, grant.token, at(31 * MINUTE))).toBeNull();
  });

  it('answers an unknown order number like a wrong code', async () => {
    const store = await createStore(db);
    await expectAppError(
      grantOrderLookup(db, { businessId: store.businessId, orderNumber: 'ORD-999999', code: '123456', ip: null, userAgent: null }, { now: T0 }),
      422,
      'otp_invalid',
    );
  });
});

describe('order access (GET /orders/{orderNumber})', () => {
  it('a sign-in session reads its own orders, and another customer\'s order looks exactly like a missing one', async () => {
    const store = await createStore(db);
    const mine = await placeTestOrder(store, PHONE);
    const theirs = await placeTestOrder(store, OTHER_PHONE);
    const sender = new CaptureSender();
    await requestOtp(db, sender, { businessId: store.businessId, purpose: 'CUSTOMER_LOGIN', phoneE164: PHONE }, { now: T0 });
    const session = await signInWithOtp(db, { businessId: store.businessId, phoneE164: PHONE, code: sender.last().code, ip: null, userAgent: null }, { now: at(MINUTE) });
    const accesses = await accessesFromCookies(db, store.businessId, `${CUSTOMER_COOKIE}=${session.token}`, at(2 * MINUTE));

    await expect(findOrderForCustomer(db, store.scope, accesses, mine.orderNumber)).resolves.toMatchObject({ id: mine.id });
    await expectAppError(findOrderForCustomer(db, store.scope, accesses, theirs.orderNumber), 404, 'order_not_found');
    await expectAppError(findOrderForCustomer(db, store.scope, accesses, 'ORD-999999'), 404, 'order_not_found');
  });

  it('with no usable cookie there is nothing to check, and garbage cookies are ignored', async () => {
    const store = await createStore(db);
    expect(await accessesFromCookies(db, store.businessId, null)).toEqual([]);
    expect(await accessesFromCookies(db, store.businessId, `${CUSTOMER_COOKIE}=not-a-real-token-value-000000`)).toEqual([]);
  });

  it('reads both cookies at once, so a lookup does not sign the customer out', async () => {
    const store = await createStore(db);
    const order = await placeTestOrder(store, PHONE);
    const sender = new CaptureSender();
    await requestOtp(db, sender, { businessId: store.businessId, purpose: 'CUSTOMER_LOGIN', phoneE164: PHONE }, { now: T0 });
    const session = await signInWithOtp(db, { businessId: store.businessId, phoneE164: PHONE, code: sender.last().code, ip: null, userAgent: null }, { now: at(MINUTE) });
    await requestOtp(db, sender, { businessId: store.businessId, purpose: 'ORDER_LOOKUP', phoneE164: PHONE }, { now: at(2 * MINUTE) });
    const lookup = await grantOrderLookup(db, { businessId: store.businessId, orderNumber: order.orderNumber, code: sender.last().code, ip: null, userAgent: null }, { now: at(3 * MINUTE) });

    const both = await accessesFromCookies(db, store.businessId, `${CUSTOMER_COOKIE}=${session.token}; ${ORDER_COOKIE}=${lookup.token}`, at(4 * MINUTE));
    expect(both.map((a) => a.kind).sort()).toEqual(['order-lookup', 'sign-in']);
  });

  it('refuses revoked and expired sessions', async () => {
    const store = await createStore(db);
    const sender = new CaptureSender();
    await requestOtp(db, sender, { businessId: store.businessId, purpose: 'CUSTOMER_LOGIN', phoneE164: PHONE }, { now: T0 });
    const session = await signInWithOtp(db, { businessId: store.businessId, phoneE164: PHONE, code: sender.last().code, ip: null, userAgent: null }, { now: at(MINUTE) });
    const row = await db.customerSession.findUniqueOrThrow({ where: { tokenHash: hashCustomerToken(session.token) } });

    expect(await resolveCustomerSession(db, store.businessId, session.token, at(2 * MINUTE))).not.toBeNull();
    expect(await resolveCustomerSession(db, store.businessId, session.token, at(CUSTOMER_SESSION_MS + 2 * MINUTE))).toBeNull();
    expect(await resolveCustomerSession(db, store.businessId, session.token, at(3 * MINUTE))).not.toBeNull();

    await revokeCustomerSession(db, row.id, at(4 * MINUTE));
    expect(await resolveCustomerSession(db, store.businessId, session.token, at(5 * MINUTE))).toBeNull();

    // Another business cannot use the token.
    const other = await createStore(db);
    expect(await resolveCustomerSession(db, other.businessId, session.token, at(5 * MINUTE))).toBeNull();
  });

  it('refuses a live session once its customer is erased', async () => {
    const store = await createStore(db);
    const sender = new CaptureSender();
    await requestOtp(db, sender, { businessId: store.businessId, purpose: 'CUSTOMER_LOGIN', phoneE164: PHONE }, { now: T0 });
    const session = await signInWithOtp(db, { businessId: store.businessId, phoneE164: PHONE, code: sender.last().code, ip: null, userAgent: null }, { now: at(MINUTE) });
    expect(await resolveCustomerSession(db, store.businessId, session.token, at(2 * MINUTE))).not.toBeNull();

    const row = await db.customerSession.findUniqueOrThrow({ where: { tokenHash: hashCustomerToken(session.token) } });
    await db.customer.update({ where: { id: row.customerId }, data: { anonymizedAt: at(3 * MINUTE) } });
    expect(await resolveCustomerSession(db, store.businessId, session.token, at(4 * MINUTE))).toBeNull();
  });

  it('signing out ends the session and writes an audit row without the token', async () => {
    const store = await createStore(db);
    const sender = new CaptureSender();
    await requestOtp(db, sender, { businessId: store.businessId, purpose: 'CUSTOMER_LOGIN', phoneE164: PHONE }, { now: T0 });
    const session = await signInWithOtp(db, { businessId: store.businessId, phoneE164: PHONE, code: sender.last().code, ip: null, userAgent: null }, { now: at(MINUTE) });
    const accesses = await accessesFromCookies(db, store.businessId, `${CUSTOMER_COOKIE}=${session.token}`, at(2 * MINUTE));

    await signOutCustomer(db, { businessId: store.businessId, accesses, ip: null, userAgent: null }, at(3 * MINUTE));
    expect(await resolveCustomerSession(db, store.businessId, session.token, at(4 * MINUTE))).toBeNull();

    const audit = await db.auditLog.findFirstOrThrow({ where: { businessId: store.businessId, action: 'CUSTOMER_SIGNED_OUT' } });
    expect(stringifyJson(audit)).not.toContain(session.token);
  });
});

describe('customer order view (GET /orders/{orderNumber})', () => {
  it('shows the order without internal notes or provider details', async () => {
    const store = await createStore(db);
    const order = await placeTestOrder(store, PHONE);
    await db.order.update({ where: { id: order.id }, data: { internalNote: 'do not show: VIP fraud check' } });
    const view = await buildOrderView(db, store.scope, order.id);
    const json = stringifyJson(view);
    expect(json).not.toContain('VIP fraud check');
    expect(json).not.toContain('checkoutRequestHash');
    expect(json).not.toContain('authorizationUrl');
    expect(view.display.total).toMatch(/^₦/);
  });
});
