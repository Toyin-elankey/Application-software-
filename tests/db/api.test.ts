// HTTP-level journey through the real route handlers, against the seeded sample brand.
// Covers cookies, problem+json errors, string money in JSON, and replay over HTTP.
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GET as listProducts } from '@/app/api/v1/catalog/products/route';
import { GET as getCart } from '@/app/api/v1/cart/route';
import { POST as addItem } from '@/app/api/v1/cart/items/route';
import { POST as quote } from '@/app/api/v1/delivery/quote/route';
import { POST as checkout } from '@/app/api/v1/checkout/route';
import { GET as getMockPay, POST as postMockPay } from '@/app/dev/mock-pay/[reference]/route';
import { createPrisma } from './helpers';

let db: PrismaClient;

beforeAll(() => {
  db = createPrisma();
});

afterAll(async () => {
  await db.$disconnect();
});

function jsonRequest(url: string, method: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost:3000${url}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function cookieFrom(response: Response): string {
  const header = response.headers.get('set-cookie') ?? '';
  const match = /cart_token=([^;]+)/.exec(header);
  if (!match) throw new Error(`no cart cookie in ${header}`);
  return `cart_token=${match[1]}`;
}

describe('storefront HTTP journey', () => {
  it('lists published sample products with display prices and no stock levels', async () => {
    const response = await listProducts(new Request('http://localhost:3000/api/v1/catalog/products?limit=3'));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { products: { slug: string; variants: { priceMinor: string; priceDisplay: string }[] }[] };
    expect(body.products.length).toBeGreaterThan(0);
    expect(body.products.length).toBeLessThanOrEqual(3);
    const v = body.products[0].variants[0];
    expect(typeof v.priceMinor).toBe('string');
    expect(v.priceDisplay).toMatch(/^₦[\d,]+\.\d{2}$/);
    expect(JSON.stringify(body)).not.toMatch(/onHand|reserved/);
  });

  it('returns an empty cart without setting a cookie', async () => {
    const response = await getCart(new Request('http://localhost:3000/api/v1/cart'));
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toBeNull();
    const body = (await response.json()) as { cart: { lines: unknown[]; totalMinor: string } };
    expect(body.cart.lines).toEqual([]);
    expect(body.cart.totalMinor).toBe('0');
  });

  it('adds an item, sets a HttpOnly cart cookie, and returns server totals', async () => {
    const variant = await db.productVariant.findFirstOrThrow({
      where: { business: { slug: 'sample-brand' }, isActive: true, product: { status: 'PUBLISHED', deletedAt: null } },
      select: { id: true },
    });
    const response = await addItem(jsonRequest('/api/v1/cart/items', 'POST', { variantId: variant.id, quantity: 2 }));
    expect(response.status).toBe(200);
    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/^cart_token=[A-Za-z0-9_-]{43};/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    const body = (await response.json()) as { cart: { lines: { quantity: number }[] } };
    expect(body.cart.lines[0].quantity).toBe(2);
  });

  it('answers a delivery quote for a covered state and says so for an uncovered one', async () => {
    const variant = await db.productVariant.findFirstOrThrow({
      where: { business: { slug: 'sample-brand' }, isActive: true, product: { status: 'PUBLISHED' } },
      select: { id: true },
    });
    const add = await addItem(jsonRequest('/api/v1/cart/items', 'POST', { variantId: variant.id, quantity: 1 }));
    const cookie = cookieFrom(add);

    const covered = await quote(jsonRequest('/api/v1/delivery/quote', 'POST', { state: 'Lagos State' }, { cookie }));
    expect(covered.status).toBe(200);
    expect(((await covered.json()) as { quote: { covered: boolean } }).quote.covered).toBe(true);

    const uncovered = await quote(jsonRequest('/api/v1/delivery/quote', 'POST', { state: 'Kano' }, { cookie }));
    expect(((await uncovered.json()) as { quote: { covered: boolean } }).quote.covered).toBe(false);
  });

  it('checks out with an Idempotency-Key, and replays the same result for a retry', async () => {
    const variant = await db.productVariant.findFirstOrThrow({
      where: { business: { slug: 'sample-brand' }, isActive: true, product: { status: 'PUBLISHED' } },
      select: { id: true },
    });
    const add = await addItem(jsonRequest('/api/v1/cart/items', 'POST', { variantId: variant.id, quantity: 1 }));
    const cookie = cookieFrom(add);

    const view = (await (await getCart(jsonRequest('/api/v1/cart?state=Lagos', 'GET', undefined, { cookie }))).json()) as {
      cart: { lines: { variantId: string; quantity: number; unitPriceMinor: string }[]; totalMinor: string };
    };
    const body = {
      recipientName: 'Ada Test',
      phoneE164: '+2348055556666',
      email: 'ada.http@example.com',
      address: { line1: '1 Marina', city: 'Lagos Island', state: 'Lagos' },
      whatsappUpdates: true,
      expected: {
        totalMinor: view.cart.totalMinor,
        lines: view.cart.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity, unitPriceMinor: l.unitPriceMinor })),
      },
    };
    // Shipping is part of the total only when the state is known, so the expected total must include it.
    const withShipping = (await (await getCart(jsonRequest('/api/v1/cart?state=Lagos', 'GET', undefined, { cookie }))).json()) as {
      cart: { totalMinor: string };
    };
    body.expected.totalMinor = withShipping.cart.totalMinor;

    const key = `http-${Date.now()}`;
    const first = await checkout(jsonRequest('/api/v1/checkout', 'POST', body, { cookie, 'idempotency-key': key }));
    expect(first.status).toBe(201);
    expect(first.headers.get('content-type')).toMatch(/application\/json/);
    const created = (await first.json()) as {
      order: { id: string; status: string; orderNumber: string; totalMinor: string; items: unknown[] };
      payment: { status: string; authorizationUrl: string | null };
    };
    expect(created.order.status).toBe('PENDING_PAYMENT');
    expect(typeof created.order.totalMinor).toBe('string');
    expect(created.payment.status).toBe('PENDING');
    expect(created.payment.authorizationUrl).toMatch(/\/dev\/mock-pay\/pay_/);
    // Staff-only and internal fields are never in the customer response.
    expect(JSON.stringify(created)).not.toMatch(/internalNote|checkoutRequestHash|checkoutKey|customerId/);

    // The cart cookie still points at the converted cart, so the retry replays rather than failing.
    const retry = await checkout(jsonRequest('/api/v1/checkout', 'POST', body, { cookie, 'idempotency-key': key }));
    expect(retry.status).toBe(201);
    expect(((await retry.json()) as { order: { id: string } }).order.id).toBe(created.order.id);
  });

  it('answers a missing Idempotency-Key with 400 problem+json', async () => {
    const response = await checkout(jsonRequest('/api/v1/checkout', 'POST', {}, { cookie: 'cart_token=' + 'a'.repeat(43) }));
    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toMatch(/application\/problem\+json/);
    expect(await response.json()).toMatchObject({ status: 400, code: 'idempotency_key_required' });
  });

  it('answers an invalid body with 400 and the list of fields', async () => {
    const response = await checkout(
      jsonRequest('/api/v1/checkout', 'POST', { recipientName: 'A', phoneE164: '08012345678' }, { 'idempotency-key': 'bad-body-1' }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { code: string; issues: { path: string }[] };
    expect(body.code).toBe('validation_failed');
    expect(body.issues.map((i) => i.path)).toEqual(expect.arrayContaining(['phoneE164', 'address', 'expected']));
  });

  it('answers unparseable JSON with 400 invalid_json', async () => {
    const response = await addItem(new Request('http://localhost:3000/api/v1/cart/items', { method: 'POST', body: '{not json' }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'invalid_json' });
  });
});

describe('mock payment page over HTTP', () => {
  async function placeOrderOverHttp(): Promise<{ orderId: string; reference: string; orderNumber: string }> {
    // The variant with the most headroom, so these tests do not exhaust the sample stock.
    const variant = await db.productVariant.findFirstOrThrow({
      where: { business: { slug: 'sample-brand' }, isActive: true, product: { status: 'PUBLISHED' } },
      orderBy: { onHand: 'desc' },
      select: { id: true },
    });
    const add = await addItem(jsonRequest('/api/v1/cart/items', 'POST', { variantId: variant.id, quantity: 1 }));
    const cookie = cookieFrom(add);
    const view = (await (await getCart(jsonRequest('/api/v1/cart?state=Lagos', 'GET', undefined, { cookie }))).json()) as {
      cart: { lines: { variantId: string; quantity: number; unitPriceMinor: string }[]; totalMinor: string };
    };
    const body = {
      recipientName: 'Mock Payer',
      phoneE164: '+2348077770000',
      email: 'mock.payer@example.com',
      address: { line1: '2 Marina', city: 'Lagos Island', state: 'Lagos' },
      whatsappUpdates: false,
      expected: {
        totalMinor: view.cart.totalMinor,
        lines: view.cart.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity, unitPriceMinor: l.unitPriceMinor })),
      },
    };
    const response = await checkout(jsonRequest('/api/v1/checkout', 'POST', body, { cookie, 'idempotency-key': `mockpay-${Date.now()}-${Math.random()}` }));
    expect(response.status).toBe(201);
    // The customer-facing payment view has no reference; read it from the database for the test.
    const created = (await response.json()) as { order: { id: string; orderNumber: string } };
    const payment = await db.payment.findFirstOrThrow({ where: { orderId: created.order.id }, select: { reference: true } });
    return { orderId: created.order.id, reference: payment.reference, orderNumber: created.order.orderNumber };
  }

  function pageRequest(reference: string, outcome: string | null, origin?: string): [Request, { params: Promise<{ reference: string }> }] {
    const form = new FormData();
    if (outcome !== null) form.set('outcome', outcome);
    const headers: Record<string, string> = origin ? { origin } : {};
    return [
      new Request(`http://localhost:3000/dev/mock-pay/${reference}`, { method: 'POST', body: form, headers }),
      { params: Promise.resolve({ reference }) },
    ];
  }

  it('shows the outcome choices without changing the payment', async () => {
    const { orderId, reference, orderNumber } = await placeOrderOverHttp();
    const response = await getMockPay(
      new Request(`http://localhost:3000/dev/mock-pay/${reference}`),
      { params: Promise.resolve({ reference }) },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/text\/html/);
    const html = await response.text();
    expect(html).toContain(orderNumber);
    expect(html).toContain('value="SUCCESS"');
    expect(html).toContain('value="FAILED"');
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('PENDING_PAYMENT');
  });

  it('a failed payment leaves the order awaiting payment', async () => {
    const { orderId, reference } = await placeOrderOverHttp();
    const [req, ctx] = pageRequest(reference, 'FAILED');
    const response = await postMockPay(req, ctx);
    expect(response.status).toBe(200);
    expect(await response.text()).toMatch(/not successful/);
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('PENDING_PAYMENT');
    expect((await db.payment.findUniqueOrThrow({ where: { reference } })).status).toBe('FAILED');
  });

  // Known gap until Stage 4: docs/06 §3 allows FAILED -> PENDING (a new authorisation on the same
  // order) through POST /orders/{id}/payments, which is not built yet. Until then a failed payment is
  // final, and this test records that the order stays awaiting payment with no way to pay it.
  it('after a failed attempt, a later success does not pay the order (retry arrives in Stage 4)', async () => {
    const { orderId, reference } = await placeOrderOverHttp();
    const [failReq, failCtx] = pageRequest(reference, 'FAILED');
    await postMockPay(failReq, failCtx);
    const [okReq, okCtx] = pageRequest(reference, 'SUCCESS');
    const response = await postMockPay(okReq, okCtx);
    expect(await response.text()).toMatch(/already FAILED\. Nothing changed/);
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('PENDING_PAYMENT');
  });

  it('a successful payment is verified and marks the order paid, once', async () => {
    const { orderId, reference, orderNumber } = await placeOrderOverHttp();
    const [req, ctx] = pageRequest(reference, 'SUCCESS');
    const response = await postMockPay(req, ctx);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toMatch(/Payment verified/);
    expect(html).toContain(orderNumber);
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('PAYMENT_CONFIRMED');

    // A repeat POST must not change anything.
    const [again, againCtx] = pageRequest(reference, 'SUCCESS');
    const second = await postMockPay(again, againCtx);
    expect(await second.text()).toMatch(/already SUCCEEDED\. Nothing changed/);
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('PAYMENT_CONFIRMED');
  });

  it('refuses a cross-site POST and changes nothing', async () => {
    const { orderId, reference } = await placeOrderOverHttp();
    const [req, ctx] = pageRequest(reference, 'SUCCESS', 'https://evil.example');
    const response = await postMockPay(req, ctx);
    expect(response.status).toBe(403);
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('PENDING_PAYMENT');
  });

  it('answers an unknown reference and an invalid outcome with HTML errors', async () => {
    const unknown = await getMockPay(
      new Request('http://localhost:3000/dev/mock-pay/pay_nope'),
      { params: Promise.resolve({ reference: 'pay_nope' }) },
    );
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get('content-type')).toMatch(/text\/html/);

    const { reference } = await placeOrderOverHttp();
    const [req, ctx] = pageRequest(reference, 'REFUND_ALL_THE_THINGS');
    const bad = await postMockPay(req, ctx);
    expect(bad.status).toBe(400);
  });
});
