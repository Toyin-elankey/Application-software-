// Asserts that every hand-written constraint from docs/03-data-model.md §9 exists and rejects bad
// data, and that the unique keys the application relies on for idempotency are enforced.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type pg from 'pg';
import { connectPg, createPrisma, expectSqlState, unique } from './helpers';

const CHECK_CONSTRAINTS = [
  'variant_onhand_nonneg',
  'variant_reserved_bounds',
  'variant_price_positive',
  'cartitem_qty_range',
  'orderitem_line_math',
  'order_total_math',
  'order_amounts_nonneg',
  'order_paid_invariant',
  'refund_amount_positive',
];

// Unique keys named by the Prisma convention (Model_field_key) plus the hand-written partial index.
const UNIQUE_INDEXES = [
  'ProductVariant_businessId_sku_key',
  'Order_businessId_checkoutKey_key',
  'Order_businessId_orderNumber_key',
  'Payment_reference_key',
  'Refund_providerRefundId_key',
  'WebhookEvent_provider_externalId_key',
  'Job_dedupeKey_key',
  'IdempotencyKey_businessId_scope_keyHash_key',
  'confirmation_one_open_per_cart',
];

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';

let prisma: PrismaClient;
let sql: pg.Client;

beforeAll(async () => {
  prisma = createPrisma();
  sql = await connectPg();
});

afterAll(async () => {
  await sql?.end();
  await prisma?.$disconnect();
});

// Builds a valid business, product, variant, cart and order. Tests then break one rule at a time.
async function fixture() {
  const suffix = unique('c');
  const business = await prisma.business.create({
    data: { slug: suffix, name: 'Constraint test', countryCode: 'NG', currency: 'NGN', timezone: 'Africa/Lagos' },
  });
  const businessId = business.id;
  const product = await prisma.product.create({
    data: { businessId, slug: 'linen-shirt', name: 'Linen Shirt', description: 'Test product', status: 'PUBLISHED' },
  });
  const variant = await prisma.productVariant.create({
    data: {
      businessId,
      productId: product.id,
      sku: `${suffix}-M`,
      title: 'M',
      priceMinor: 1000000n,
      trackInventory: true,
      onHand: 5,
      reserved: 0,
      isDefault: true,
      isActive: true,
    },
  });
  const cart = await prisma.cart.create({
    data: { businessId, expiresAt: new Date(Date.now() + 3_600_000), tokenHash: `${suffix}-cart` },
  });
  const cartItem = await prisma.cartItem.create({
    data: { cartId: cart.id, variantId: variant.id, quantity: 1 },
  });
  const customer = await prisma.customer.create({
    data: { businessId, phoneE164: `+23480${Math.floor(Math.random() * 1e8).toString().padStart(8, '0')}` },
  });
  const order = await prisma.order.create({
    data: {
      businessId,
      customerId: customer.id,
      orderNumber: `${suffix}-0001`,
      channel: 'WEB',
      currency: 'NGN',
      subtotalMinor: 1000000n,
      totalMinor: 1000000n,
      checkoutKey: `${suffix}-checkout`,
      checkoutRequestHash: `${suffix}-hash`,
    },
  });
  const orderItem = await prisma.orderItem.create({
    data: {
      orderId: order.id,
      sku: variant.sku,
      productName: product.name,
      variantTitle: variant.title,
      unitPriceMinor: 1000000n,
      quantity: 1,
      lineTotalMinor: 1000000n,
    },
  });
  return { businessId, product, variant, cart, cartItem, customer, order, orderItem };
}

describe('hand-written constraints exist', () => {
  it.each(CHECK_CONSTRAINTS)('CHECK constraint %s is present', async (name) => {
    const { rows } = await sql.query(
      `SELECT 1 FROM pg_constraint WHERE conname = $1 AND contype = 'c'`,
      [name],
    );
    expect(rows).toHaveLength(1);
  });

  it.each(UNIQUE_INDEXES)('unique index %s is present and unique', async (name) => {
    const { rows } = await sql.query(
      `SELECT ix.indisunique FROM pg_class c
         JOIN pg_index ix ON ix.indexrelid = c.oid
        WHERE c.relname = $1`,
      [name],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].indisunique).toBe(true);
  });

  it('Product has a generated, stored full-text search column with a GIN index', async () => {
    const col = await sql.query(
      `SELECT is_generated, generation_expression FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'Product' AND column_name = 'search_tsv'`,
    );
    expect(col.rows).toHaveLength(1);
    expect(col.rows[0].is_generated).toBe('ALWAYS');

    const idx = await sql.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'product_search_idx'`);
    expect(idx.rows[0].indexdef).toMatch(/USING gin/);
  });

  it('the job runner index is partial on PENDING jobs', async () => {
    const idx = await sql.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'job_pending_idx'`);
    expect(idx.rows[0].indexdef).toMatch(/WHERE .*PENDING/);
  });
});

describe('full-text search works', () => {
  it('finds a product by a word in its name', async () => {
    const f = await fixture();
    const { rows } = await sql.query(
      `SELECT id FROM "Product" WHERE id = $1 AND search_tsv @@ plainto_tsquery('english', 'linen')`,
      [f.product.id],
    );
    expect(rows).toHaveLength(1);
  });
});

describe('CHECK constraints reject bad data', () => {
  it('rejects negative on-hand stock', async () => {
    const f = await fixture();
    await expectSqlState(sql.query(`UPDATE "ProductVariant" SET "onHand" = -1 WHERE id = $1`, [f.variant.id]), CHECK_VIOLATION);
  });

  it('rejects reserved stock above on-hand stock', async () => {
    const f = await fixture();
    await expectSqlState(
      sql.query(`UPDATE "ProductVariant" SET "reserved" = 6 WHERE id = $1`, [f.variant.id]),
      CHECK_VIOLATION,
    );
  });

  it('rejects a zero or negative price', async () => {
    const f = await fixture();
    await expectSqlState(sql.query(`UPDATE "ProductVariant" SET "priceMinor" = 0 WHERE id = $1`, [f.variant.id]), CHECK_VIOLATION);
  });

  it('rejects cart quantities outside 1..99', async () => {
    const f = await fixture();
    await expectSqlState(sql.query(`UPDATE "CartItem" SET quantity = 0 WHERE id = $1`, [f.cartItem.id]), CHECK_VIOLATION);
    await expectSqlState(sql.query(`UPDATE "CartItem" SET quantity = 100 WHERE id = $1`, [f.cartItem.id]), CHECK_VIOLATION);
  });

  it('rejects an order line whose total is not unit price times quantity', async () => {
    const f = await fixture();
    await expectSqlState(
      sql.query(`UPDATE "OrderItem" SET "lineTotalMinor" = 1 WHERE id = $1`, [f.orderItem.id]),
      CHECK_VIOLATION,
    );
  });

  it('rejects an order total that does not equal subtotal minus discount plus shipping', async () => {
    const f = await fixture();
    await expectSqlState(sql.query(`UPDATE "Order" SET "totalMinor" = 1 WHERE id = $1`, [f.order.id]), CHECK_VIOLATION);
  });

  it('rejects negative order amounts (the arithmetic still balances)', async () => {
    const f = await fixture();
    await expectSqlState(
      sql.query(
        `UPDATE "Order" SET "subtotalMinor" = -1, "totalMinor" = -1 WHERE id = $1`,
        [f.order.id],
      ),
      CHECK_VIOLATION,
    );
  });

  it('rejects a paid status without a paidAt timestamp', async () => {
    const f = await fixture();
    await expectSqlState(
      sql.query(`UPDATE "Order" SET status = 'CONFIRMED', "paidAt" = NULL WHERE id = $1`, [f.order.id]),
      CHECK_VIOLATION,
    );
  });

  it('accepts a paid status once paidAt is set', async () => {
    const f = await fixture();
    await sql.query(
      `UPDATE "Order" SET status = 'CONFIRMED', "paidAt" = now() WHERE id = $1`,
      [f.order.id],
    );
    const { rows } = await sql.query(`SELECT status FROM "Order" WHERE id = $1`, [f.order.id]);
    expect(rows[0].status).toBe('CONFIRMED');
  });

  it('rejects a refund of zero or less', async () => {
    const f = await fixture();
    const payment = await prisma.payment.create({
      data: {
        businessId: f.businessId,
        orderId: f.order.id,
        provider: 'MOCK',
        reference: unique('ref'),
        amountMinor: 1000000n,
        currency: 'NGN',
      },
    });
    await expectSqlState(
      sql.query(
        `INSERT INTO "Refund" (id, "businessId", "paymentId", "orderId", "amountMinor", reason, status, "updatedAt")
         VALUES (gen_random_uuid(), $1, $2, $3, 0, 'test', 'PENDING', now())`,
        [f.businessId, payment.id, f.order.id],
      ),
      CHECK_VIOLATION,
    );
  });
});

describe('unique keys enforce idempotency', () => {
  it('rejects a second order with the same checkout key in the same business', async () => {
    const f = await fixture();
    const existing = await prisma.order.findUniqueOrThrow({ where: { id: f.order.id } });
    // Prisma reports unique violations with its own code (P2002), not a raw SQLSTATE.
    await expect(
      prisma.order.create({
        data: {
          businessId: f.businessId,
          customerId: f.customer.id,
          orderNumber: unique('dup'),
          channel: 'WEB',
          currency: 'NGN',
          subtotalMinor: 1n,
          totalMinor: 1n,
          checkoutKey: existing.checkoutKey,
          checkoutRequestHash: 'other',
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('allows only one open confirmation per cart and action', async () => {
    const f = await fixture();
    const action = (await sql.query(`SELECT unnest(enum_range(NULL::"ConfirmationAction"))::text AS v LIMIT 1`)).rows[0].v;
    const insert = (tokenHash: string, consumed: boolean) =>
      sql.query(
        `INSERT INTO "ConfirmationRequest"
           (id, "businessId", "cartId", action, "snapshotHash", "tokenHash", "expiresAt", "consumedAt")
         VALUES (gen_random_uuid(), $1, $2, $3::"ConfirmationAction", 'snap', $4, now() + interval '1 hour',
                 CASE WHEN $5 THEN now() ELSE NULL END)`,
        [f.businessId, f.cart.id, action, tokenHash, consumed],
      );

    await insert(unique('tok-a'), false);
    await expectSqlState(insert(unique('tok-b'), false), UNIQUE_VIOLATION);
    // A consumed confirmation does not count as open, so a new one is allowed.
    await insert(unique('tok-c'), true);
  });
});
