import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { logger } from '@/lib/logger';
import { hashCartToken } from '@/server/cart/token';
import { findZoneForState, normaliseStateOrThrow } from '@/server/delivery/quote';
import type { NigerianState } from '@/server/delivery/states';
import { claimKey, hashIdempotencyKey, releaseKey, requestFingerprint } from '@/server/idempotency/keys';
import { formatOrderNumber } from '@/server/orders/number';
import { buildOrderView, buildPaymentView } from '@/server/orders/view';
import { computeOrderTotals } from '@/server/pricing/pricing';
import type { PaymentProvider } from '@/server/payments/provider';
import { initialisePayment } from '@/server/payments/initialise';
import { AppError } from '@/server/http/problem';
import type { StoreContext } from '@/server/store';
import type { TenantScope } from '@/server/tenant';
import { CHECKOUT_POLICY_VERSION, type CheckoutBody } from './schema';

// Checkout (02 §sequence, 03 §4-5, PRD FR-CHK-*).
//
// 1. Claim the Idempotency-Key in its own committed write. A replay returns the stored result; a
//    concurrent duplicate gets 409; the same key with a different body gets 422.
// 2. One transaction: lock the cart row, re-price from the database, compare with what the customer
//    saw (409 with a diff on any change), reserve stock with conditional UPDATEs, then create the
//    order, its items, address, status event, reservation movements and a payment in INITIALIZED.
// 3. After commit: start the provider transaction (a network call, so never inside step 2).
// If step 2 fails, the claim is released so the customer can retry with the same key.

export const CHECKOUT_SCOPE = 'checkout';

type Snapshot = {
  totalMinor: bigint;
  lines: { variantId: string; quantity: number; unitPriceMinor: bigint }[];
};

type CurrentLine = {
  variantId: string;
  sku: string;
  productName: string;
  productSlug: string;
  variantTitle: string;
  quantity: number;
  unitPriceMinor: bigint;
  trackInventory: boolean;
  onHand: number;
  reserved: number;
  purchasable: boolean;
};

export type SnapshotChange = {
  variantId: string;
  field: 'removed' | 'added' | 'unavailable' | 'unitPriceMinor' | 'quantity' | 'totalMinor';
  expected?: string;
  actual?: string;
};

export type CheckoutResult = { status: number; body: CheckoutBodyView };

export type CheckoutBodyView = {
  order: Awaited<ReturnType<typeof buildOrderView>>;
  payment: Awaited<ReturnType<typeof buildPaymentView>>;
};

const TX_OPTIONS = { timeout: 15_000, maxWait: 10_000 };

export async function placeOrder(
  db: PrismaClient,
  store: StoreContext,
  args: {
    cartToken: string | null;
    idempotencyKey: string;
    body: CheckoutBody;
    provider: PaymentProvider;
    now?: Date;
  },
): Promise<CheckoutResult> {
  const scope = store.scope;
  const now = args.now ?? new Date();
  const state = normaliseStateOrThrow(args.body.address.state);

  // Any status, not only ACTIVE. After a successful checkout the cart is CONVERTED, and a retry with
  // the same cookie must still reach the idempotency replay. The transaction below requires an
  // ACTIVE cart for a new order.
  const cart = args.cartToken
    ? await db.cart.findFirst({
        where: { businessId: scope.businessId, tokenHash: hashCartToken(args.cartToken) },
        select: { id: true },
      })
    : null;
  if (!cart) throw new AppError(422, 'empty_cart', 'Your cart is empty.');

  const keyHash = hashIdempotencyKey(args.idempotencyKey);
  const requestHash = requestFingerprint({
    cartId: cart.id,
    body: { ...args.body, address: { ...args.body.address, state } },
  });
  const claim = await claimKey(db, scope, { scope: CHECKOUT_SCOPE, keyHash, requestHash, now });

  if (claim.kind === 'replay') {
    const stored = claim.responseBody as { orderId: string };
    return { status: claim.responseStatus, body: await viewOf(db, scope, stored.orderId) };
  }

  let placed: { orderId: string; paymentId: string };
  try {
    placed = await db.$transaction(
      (tx) =>
        placeInTransaction(tx, store, {
          cartId: cart.id,
          keyId: claim.keyId,
          keyHash,
          requestHash,
          body: args.body,
          state,
          now,
        }),
      TX_OPTIONS,
    );
  } catch (error) {
    await releaseKey(db, claim.keyId);
    throw error;
  }

  try {
    await initialisePayment(db, scope, placed.paymentId, args.provider);
  } catch (error) {
    // The order exists and the payment is INITIALIZED. It can be resumed; the customer is not charged.
    logger.warn({ err: error, orderId: placed.orderId }, 'payment initialisation failed after checkout commit');
  }
  return { status: 201, body: await viewOf(db, scope, placed.orderId) };
}

async function viewOf(db: PrismaClient, scope: TenantScope, orderId: string): Promise<CheckoutBodyView> {
  return {
    order: await buildOrderView(db, scope, orderId),
    payment: await buildPaymentView(db, scope, orderId),
  };
}

async function placeInTransaction(
  tx: Prisma.TransactionClient,
  store: StoreContext,
  args: {
    cartId: string;
    keyId: string;
    keyHash: string;
    requestHash: string;
    body: CheckoutBody;
    state: NigerianState;
    now: Date;
  },
): Promise<{ orderId: string; paymentId: string }> {
  const scope = store.scope;
  const { body, now } = args;

  // Serialise checkouts from the same cart and confirm it is still active.
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Cart"
    WHERE id = ${args.cartId}::uuid AND "businessId" = ${scope.businessId}::uuid AND status = 'ACTIVE' AND "expiresAt" > ${now}
    FOR UPDATE`;
  if (locked.length === 0) throw new AppError(422, 'empty_cart', 'Your cart is empty.');

  const rows = await tx.cartItem.findMany({
    where: { cartId: args.cartId },
    select: {
      quantity: true,
      variant: {
        select: {
          id: true,
          sku: true,
          title: true,
          priceMinor: true,
          isActive: true,
          trackInventory: true,
          onHand: true,
          reserved: true,
          product: { select: { name: true, slug: true, status: true, deletedAt: true } },
        },
      },
    },
  });
  if (rows.length === 0) throw new AppError(422, 'empty_cart', 'Your cart is empty.');

  const current: CurrentLine[] = rows
    .map((row) => ({
      variantId: row.variant.id,
      sku: row.variant.sku,
      productName: row.variant.product.name,
      productSlug: row.variant.product.slug,
      variantTitle: row.variant.title,
      quantity: row.quantity,
      unitPriceMinor: row.variant.priceMinor,
      trackInventory: row.variant.trackInventory,
      onHand: row.variant.onHand,
      reserved: row.variant.reserved,
      purchasable:
        row.variant.isActive && row.variant.product.status === 'PUBLISHED' && row.variant.product.deletedAt === null,
    }))
    .sort((a, b) => (a.variantId < b.variantId ? -1 : a.variantId > b.variantId ? 1 : 0));

  const zone = await findZoneForState(tx, scope, args.state);
  if (!zone) throw new AppError(422, 'not_delivered', 'We do not deliver to this state yet.');

  const purchasable = current.filter((l) => l.purchasable);
  const settings = store.settings;
  const totals = computeOrderTotals({
    lines: purchasable.map((l) => ({ unitPriceMinor: l.unitPriceMinor, quantity: l.quantity })),
    zone: { feeMinor: zone.feeMinor, freeShippingThresholdMinor: zone.freeShippingThresholdMinor },
    vatRateBps: settings.vatRateBps,
    pricesIncludeVat: settings.pricesIncludeVat,
  });

  const changes = diffSnapshot(
    { totalMinor: BigInt(body.expected.totalMinor), lines: body.expected.lines.map(toSnapshotLine) },
    current,
    totals.totalMinor,
  );
  if (changes.length > 0) {
    throw new AppError(409, 'cart_changed', 'Prices or items have changed since you last viewed your cart. Review it and try again.', {
      changes,
      current: {
        totalMinor: totals.totalMinor.toString(),
        lines: current.map((l) => ({
          variantId: l.variantId,
          quantity: l.quantity,
          unitPriceMinor: l.unitPriceMinor.toString(),
          purchasable: l.purchasable,
        })),
      },
    });
  }

  const orderId = randomUUID();
  const paymentId = randomUUID();

  // Reserve stock in variantId order, so concurrent checkouts lock rows in the same order.
  const reserved = purchasable.filter((l) => l.trackInventory);
  for (const line of reserved) {
    const updated = await tx.$executeRaw`
      UPDATE "ProductVariant"
      SET "reserved" = "reserved" + ${line.quantity}, "updatedAt" = now()
      WHERE id = ${line.variantId}::uuid AND "businessId" = ${scope.businessId}::uuid
        AND "isActive" = true AND ("onHand" - "reserved") >= ${line.quantity}`;
    if (updated !== 1) {
      throw new AppError(409, 'out_of_stock', `Sorry, ${line.productName} (${line.variantTitle}) does not have that many left.`, {
        variantId: line.variantId,
      });
    }
  }

  const customerId = await upsertCustomer(tx, scope, body);
  if (body.whatsappUpdates) {
    await tx.consentRecord.create({
      data: {
        businessId: scope.businessId,
        customerId,
        purpose: 'ORDER_UPDATES_WHATSAPP',
        granted: true,
        source: 'CHECKOUT_FORM',
        policyVersion: CHECKOUT_POLICY_VERSION,
      },
    });
  }

  const [seq] = await tx.$queryRaw<{ nextval: bigint }[]>`SELECT nextval('order_number_seq') AS nextval`;
  const orderNumber = formatOrderNumber(settings.orderNumberPrefix, now, Number(seq.nextval));
  const reservationExpiresAt = new Date(now.getTime() + settings.stockReservationMinutes * 60_000);
  const reference = `pay_${randomUUID().replace(/-/g, '')}`;
  const address = body.address;

  await tx.order.create({
    data: {
      id: orderId,
      businessId: scope.businessId,
      customerId,
      orderNumber,
      status: 'PENDING_PAYMENT',
      channel: 'WEB',
      currency: 'NGN',
      subtotalMinor: totals.subtotalMinor,
      discountMinor: totals.discountMinor,
      shippingMinor: totals.shippingMinor,
      taxMinor: totals.taxMinor,
      totalMinor: totals.totalMinor,
      deliveryZoneId: zone.id,
      deliveryZoneName: zone.name,
      checkoutKey: args.keyHash,
      checkoutRequestHash: args.requestHash,
      reservationExpiresAt,
      customerNote: body.customerNote || null,
      items: {
        create: purchasable.map((l) => ({
          variantId: l.variantId,
          sku: l.sku,
          productName: l.productName,
          variantTitle: l.variantTitle,
          unitPriceMinor: l.unitPriceMinor,
          quantity: l.quantity,
          lineTotalMinor: l.unitPriceMinor * BigInt(l.quantity),
        })),
      },
      address: {
        create: {
          recipientName: body.recipientName,
          phoneE164: body.phoneE164,
          line1: address.line1,
          line2: address.line2 || null,
          city: address.city,
          state: args.state,
          postalCode: address.postalCode || null,
          landmark: address.landmark || null,
        },
      },
      statusEvents: {
        create: {
          fromStatus: null,
          toStatus: 'PENDING_PAYMENT',
          actorType: 'CUSTOMER',
          actorId: customerId,
          reason: 'checkout',
        },
      },
      payments: {
        create: {
          id: paymentId,
          businessId: scope.businessId,
          provider: 'MOCK',
          reference,
          status: 'INITIALIZED',
          amountMinor: totals.totalMinor,
          currency: 'NGN',
        },
      },
    },
  });

  if (reserved.length > 0) {
    await tx.inventoryMovement.createMany({
      data: reserved.map((l) => ({
        businessId: scope.businessId,
        variantId: l.variantId,
        delta: l.quantity,
        reason: 'RESERVED' as const,
        orderId,
        actorType: 'CUSTOMER' as const,
        note: 'checkout',
      })),
    });
  }

  await tx.cart.update({ where: { id: args.cartId }, data: { status: 'CONVERTED' } });
  await tx.idempotencyKey.update({
    where: { id: args.keyId },
    data: { state: 'COMPLETED', responseStatus: 201, responseBody: { orderId, orderNumber } },
  });

  return { orderId, paymentId };
}

function toSnapshotLine(line: CheckoutBody['expected']['lines'][number]) {
  return { variantId: line.variantId, quantity: line.quantity, unitPriceMinor: BigInt(line.unitPriceMinor) };
}

/**
 * Compares what the customer reviewed with the database. Returns one entry per difference. An empty
 * array means the cart is exactly as the customer saw it.
 */
export function diffSnapshot(expected: Snapshot, current: CurrentLine[], totalMinor: bigint): SnapshotChange[] {
  const changes: SnapshotChange[] = [];
  const byVariant = new Map(current.map((l) => [l.variantId, l]));
  const expectedIds = new Set(expected.lines.map((l) => l.variantId));

  for (const e of expected.lines) {
    const c = byVariant.get(e.variantId);
    if (!c) {
      changes.push({ variantId: e.variantId, field: 'removed', expected: String(e.quantity) });
      continue;
    }
    if (!c.purchasable) {
      changes.push({ variantId: e.variantId, field: 'unavailable' });
      continue;
    }
    if (c.unitPriceMinor !== e.unitPriceMinor) {
      changes.push({
        variantId: e.variantId,
        field: 'unitPriceMinor',
        expected: e.unitPriceMinor.toString(),
        actual: c.unitPriceMinor.toString(),
      });
    }
    if (c.quantity !== e.quantity) {
      changes.push({ variantId: e.variantId, field: 'quantity', expected: String(e.quantity), actual: String(c.quantity) });
    }
  }
  for (const c of current) {
    if (!expectedIds.has(c.variantId)) changes.push({ variantId: c.variantId, field: 'added', actual: String(c.quantity) });
  }
  if (expected.totalMinor !== totalMinor) {
    changes.push({ variantId: '', field: 'totalMinor', expected: expected.totalMinor.toString(), actual: totalMinor.toString() });
  }
  return changes;
}

async function upsertCustomer(tx: Prisma.TransactionClient, scope: TenantScope, body: CheckoutBody): Promise<string> {
  const email = body.email.toLowerCase();
  const customer = await tx.customer.upsert({
    where: { businessId_phoneE164: { businessId: scope.businessId, phoneE164: body.phoneE164 } },
    create: { businessId: scope.businessId, phoneE164: body.phoneE164, fullName: body.recipientName, email },
    update: {},
    select: { id: true, fullName: true, email: true, anonymizedAt: true },
  });
  if (customer.anonymizedAt) {
    throw new AppError(409, 'customer_erased', 'This phone number cannot be used for checkout. Please contact the shop.');
  }
  // Fill in blanks only. An existing customer's details are not overwritten by a checkout form.
  // Phone-only identity is unverified until OTP sign-in arrives (Stage 5).
  if (!customer.fullName || !customer.email) {
    await tx.customer.update({
      where: { id: customer.id },
      data: { fullName: customer.fullName ?? body.recipientName, email: customer.email ?? email },
    });
  }
  return customer.id;
}
