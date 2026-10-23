import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setCartItem, viewCart } from '@/server/cart/cart';
import { placeOrder } from '@/server/checkout/checkout';
import { CheckoutBodySchema } from '@/server/checkout/schema';
import { listAuditLogsForStaff, listCustomersForStaff, listPaymentsForStaff, overviewForStaff } from '@/server/admin/reads';
import { decodeCursor } from '@/server/admin/paging';
import { audit } from '@/server/auth/staff';
import { applyVerifiedPayment } from '@/server/payments/confirm';
import { MockPaymentProvider } from '@/server/payments/mock';
import { createPrisma, unique } from './helpers';
import { checkoutBody, createProduct, createStore } from './commerce-fixtures';

// Staff read views against a real PostgreSQL database (02 §6.5). Tenant isolation, masking, filters and paging.

let db: PrismaClient;

beforeAll(() => {
  db = createPrisma();
});

afterAll(async () => {
  await db.$disconnect();
});

function phone(index: number): string {
  return `+234801${String(2000000 + index).padStart(7, '0')}`;
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
  const order = await db.order.findUniqueOrThrow({ where: { id: result.body.order.id as string }, select: { id: true, orderNumber: true, customerId: true, totalMinor: true } });
  const payment = await db.payment.findFirstOrThrow({ where: { orderId: order.id }, orderBy: { createdAt: 'desc' } });
  return { ...order, reference: payment.reference, paymentId: payment.id };
}

async function paid(store: Awaited<ReturnType<typeof createStore>>, provider: MockPaymentProvider, order: { reference: string }) {
  provider.simulate(order.reference, 'SUCCESS');
  await applyVerifiedPayment(db, store.scope, order.reference, await provider.verify(order.reference));
}

describe('overview', () => {
  it('counts orders awaiting payment and to fulfil, and today\'s paid total, for this business only', async () => {
    const store = await createStore(db);
    const other = await createStore(db);
    const provider = new MockPaymentProvider();
    await placeTestOrder(store, provider, phone(1));
    await placeTestOrder(store, provider, phone(2));
    const c = await placeTestOrder(store, provider, phone(3));
    await placeTestOrder(other, provider, phone(4));
    await paid(store, provider, c);

    const view = await overviewForStaff(db, store.scope);
    expect(view.orders).toEqual({ awaitingPayment: 2, toFulfil: 1 });
    expect(view.paidToday).toMatchObject({ count: 1, amountMinor: c.totalMinor.toString() });
    expect(view.refunds).toEqual({ awaitingDecision: 0, processing: 0 });
  });

  it('counts refunds awaiting a decision and in progress, and leaves out payments verified on earlier days', async () => {
    const store = await createStore(db);
    const provider = new MockPaymentProvider();
    const order = await placeTestOrder(store, provider, phone(10));
    await paid(store, provider, order);
    await db.refund.create({
      data: { businessId: store.businessId, paymentId: order.paymentId, orderId: order.id, amountMinor: 1000n, reason: 'test', status: 'PENDING' },
    });
    await db.payment.update({ where: { id: order.paymentId }, data: { verifiedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) } });

    const view = await overviewForStaff(db, store.scope);
    expect(view.refunds.awaitingDecision).toBe(1);
    expect(view.paidToday.count).toBe(0);
  });
});

describe('customers', () => {
  it('lists only this business, masks phone and email, and shows the first name only', async () => {
    const store = await createStore(db);
    const other = await createStore(db);
    const provider = new MockPaymentProvider();
    const mine = await placeTestOrder(store, provider, '+2348012345678');
    await placeTestOrder(other, provider, '+2348099990000');
    await db.customer.update({ where: { id: mine.customerId }, data: { fullName: 'Ada Okafor', email: 'ada.okafor@example.com' } });

    const page = await listCustomersForStaff(db, store.scope, { limit: 25, cursor: null });
    expect(page.items).toHaveLength(1);
    const [row] = page.items;
    expect(row).toMatchObject({ phone: '+234********78', email: 'a***@example.com', firstName: 'Ada', erased: false, orderCount: 1 });
    expect(JSON.stringify(page)).not.toContain('2348012345678');
    expect(JSON.stringify(page)).not.toContain('Okafor');
    expect(JSON.stringify(page)).not.toContain('ada.okafor');
  });

  it('searches by name case-insensitively, and by four or more digits of the phone', async () => {
    const store = await createStore(db);
    const provider = new MockPaymentProvider();
    const order = await placeTestOrder(store, provider, '+2348055501234');
    await db.customer.update({ where: { id: order.customerId }, data: { fullName: 'Tunde Bello' } });

    expect((await listCustomersForStaff(db, store.scope, { q: 'bello', limit: 25, cursor: null })).items).toHaveLength(1);
    expect((await listCustomersForStaff(db, store.scope, { q: '8055501', limit: 25, cursor: null })).items).toHaveLength(1);
    expect((await listCustomersForStaff(db, store.scope, { q: 'nobody', limit: 25, cursor: null })).items).toHaveLength(0);
    // Fewer than four digits is not a phone search; it matches nothing here.
    expect((await listCustomersForStaff(db, store.scope, { q: '80', limit: 25, cursor: null })).items).toHaveLength(0);
  });

  it('marks erased customers, and shows no name or email for them', async () => {
    const store = await createStore(db);
    const provider = new MockPaymentProvider();
    const order = await placeTestOrder(store, provider, phone(20));
    await db.customer.update({ where: { id: order.customerId }, data: { fullName: null, email: null, anonymizedAt: new Date() } });

    const [row] = (await listCustomersForStaff(db, store.scope, { limit: 25, cursor: null })).items;
    expect(row).toMatchObject({ erased: true, firstName: null, email: null });
  });

  it('pages without repeating or skipping customers', async () => {
    const store = await createStore(db);
    const provider = new MockPaymentProvider();
    for (let i = 0; i < 5; i++) await placeTestOrder(store, provider, phone(30 + i));

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await listCustomersForStaff(db, store.scope, { limit: 2, cursor: decodeCursor(cursor ?? undefined) });
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });
});

describe('payments', () => {
  it('lists this business\'s payments without the checkout link, and filters by status', async () => {
    const store = await createStore(db);
    const other = await createStore(db);
    const provider = new MockPaymentProvider();
    const paidOrder = await placeTestOrder(store, provider, phone(40));
    await paid(store, provider, paidOrder);
    await placeTestOrder(store, provider, phone(41));
    await placeTestOrder(other, provider, phone(42));

    const all = await listPaymentsForStaff(db, store.scope, { limit: 25, cursor: null });
    expect(all.items).toHaveLength(2);
    expect(all.items.every((p) => !('authorizationUrl' in p))).toBe(true);
    expect(JSON.stringify(all)).not.toContain('/dev/mock-pay');
    expect(all.items.find((p) => p.status === 'SUCCEEDED')).toMatchObject({ amountMinor: paidOrder.totalMinor.toString(), currency: 'NGN' });

    const succeeded = await listPaymentsForStaff(db, store.scope, { status: 'SUCCEEDED', limit: 25, cursor: null });
    expect(succeeded.items.map((p) => p.status)).toEqual(['SUCCEEDED']);
  });
});

describe('audit log', () => {
  it('filters by action, and shows nothing from another business', async () => {
    const store = await createStore(db);
    const other = await createStore(db);
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      await audit(db, store.businessId, null, 'ORDER_STATUS_CHANGED', 'Order', null, { from: 'A', to: 'B' }, '198.51.100.9', null, new Date(now + i));
    }
    await audit(db, store.businessId, null, 'REFUND_APPROVED', 'Refund', null, null, null, null, new Date(now + 10));
    await audit(db, other.businessId, null, 'ORDER_STATUS_CHANGED', 'Order', null, null, null, null, new Date(now + 11));

    const onlyStatus = await listAuditLogsForStaff(db, store.scope, { action: 'ORDER_STATUS_CHANGED', limit: 25, cursor: null });
    expect(onlyStatus.items).toHaveLength(3);
    expect(onlyStatus.items[0]).toMatchObject({ action: 'ORDER_STATUS_CHANGED', ip: '198.51.100.9', changes: { from: 'A', to: 'B' } });

    const all = await listAuditLogsForStaff(db, store.scope, { limit: 25, cursor: null });
    expect(all.items).toHaveLength(4);
    expect(all.items.every((r) => r.action !== undefined)).toBe(true);
  });

  it('pages through every row once, newest first', async () => {
    const store = await createStore(db);
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      await audit(db, store.businessId, null, unique('ACT'), 'Order', null, null, null, null, new Date(now + i * 1000));
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await listAuditLogsForStaff(db, store.scope, { limit: 2, cursor: decodeCursor(cursor ?? undefined) });
      seen.push(...page.items.map((r) => r.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    const times = (await listAuditLogsForStaff(db, store.scope, { limit: 100, cursor: null })).items.map((r) => r.at);
    expect([...times].sort().reverse()).toEqual(times);
  });
});
