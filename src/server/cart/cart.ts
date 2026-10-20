import type { PrismaClient } from '@prisma/client';
import { AppError } from '@/server/http/problem';
import { computeOrderTotals } from '@/server/pricing/pricing';
import { quoteDelivery, type DeliveryQuote } from '@/server/delivery/quote';
import type { StoreContext } from '@/server/store';
import type { TenantScope } from '@/server/tenant';
import { CART_TTL_DAYS, hashCartToken, newCartToken } from './token';
import { assertValidQuantity } from './limits';

// Cart operations. A cart is found by the hash of the cookie token. Writes never trust the client
// for price or stock: prices are read from the variant, and stock is checked against the database.
// The stock check here is advisory. Checkout re-checks and reserves atomically.

const DAY_MS = 24 * 60 * 60 * 1000;

export type CartLine = {
  variantId: string;
  sku: string;
  productSlug: string;
  productName: string;
  variantTitle: string;
  quantity: number;
  unitPriceMinor: bigint;
  lineTotalMinor: bigint;
  purchasable: boolean;
  inStock: boolean;
};

export type CartView = {
  lines: CartLine[];
  subtotalMinor: bigint;
  shippingMinor: bigint | null;
  taxMinor: bigint;
  totalMinor: bigint;
  freeShipping: boolean;
  delivery: DeliveryQuote | null;
};

export async function findActiveCart(db: PrismaClient, scope: TenantScope, token: string | null, now = new Date()) {
  if (!token) return null;
  return db.cart.findFirst({
    where: {
      businessId: scope.businessId,
      tokenHash: hashCartToken(token),
      status: 'ACTIVE',
      expiresAt: { gt: now },
    },
    select: { id: true },
  });
}

/** Ensures an active cart exists. Returns the new token when one was created, so the caller can set the cookie. */
async function ensureCart(
  db: PrismaClient,
  scope: TenantScope,
  token: string | null,
  now: Date,
): Promise<{ cartId: string; newToken: string | null }> {
  const existing = await findActiveCart(db, scope, token, now);
  if (existing) {
    await db.cart.update({ where: { id: existing.id }, data: { expiresAt: new Date(now.getTime() + CART_TTL_DAYS * DAY_MS) } });
    return { cartId: existing.id, newToken: null };
  }
  const newToken = newCartToken();
  const cart = await db.cart.create({
    data: {
      businessId: scope.businessId,
      tokenHash: hashCartToken(newToken),
      expiresAt: new Date(now.getTime() + CART_TTL_DAYS * DAY_MS),
    },
    select: { id: true },
  });
  return { cartId: cart.id, newToken };
}

async function loadVariantForCart(db: PrismaClient, scope: TenantScope, variantId: string) {
  return db.productVariant.findFirst({
    where: {
      id: variantId,
      businessId: scope.businessId,
      isActive: true,
      product: { status: 'PUBLISHED', deletedAt: null, businessId: scope.businessId },
    },
    select: { id: true, sku: true, priceMinor: true, trackInventory: true, onHand: true, reserved: true },
  });
}

function assertStock(variant: { trackInventory: boolean; onHand: number; reserved: number }, quantity: number): void {
  if (variant.trackInventory && variant.onHand - variant.reserved < quantity) {
    // The message does not say how many are left: stock levels are not shown to customers.
    throw new AppError(409, 'insufficient_stock', 'There is not enough stock for that quantity.');
  }
}

/** Adds a variant or sets its quantity (set semantics, so a retried request has the same effect). */
export async function setCartItem(
  db: PrismaClient,
  scope: TenantScope,
  args: { token: string | null; variantId: string; quantity: number; now?: Date },
): Promise<{ newToken: string | null }> {
  assertValidQuantity(args.quantity);
  const now = args.now ?? new Date();
  const variant = await loadVariantForCart(db, scope, args.variantId);
  if (!variant) throw new AppError(404, 'variant_not_found', 'That product option is not available.');
  assertStock(variant, args.quantity);

  const { cartId, newToken } = await ensureCart(db, scope, args.token, now);
  await db.cartItem.upsert({
    where: { cartId_variantId: { cartId, variantId: args.variantId } },
    update: { quantity: args.quantity },
    create: { cartId, variantId: args.variantId, quantity: args.quantity },
  });
  return { newToken };
}

export async function changeCartItemQuantity(
  db: PrismaClient,
  scope: TenantScope,
  args: { token: string | null; variantId: string; quantity: number; now?: Date },
): Promise<void> {
  assertValidQuantity(args.quantity);
  const cart = await findActiveCart(db, scope, args.token, args.now);
  if (!cart) throw new AppError(404, 'cart_item_not_found', 'That item is not in your cart.');
  const item = await db.cartItem.findUnique({
    where: { cartId_variantId: { cartId: cart.id, variantId: args.variantId } },
    select: { id: true },
  });
  if (!item) throw new AppError(404, 'cart_item_not_found', 'That item is not in your cart.');
  const variant = await loadVariantForCart(db, scope, args.variantId);
  if (!variant) throw new AppError(409, 'variant_unavailable', 'That product option is no longer available.');
  assertStock(variant, args.quantity);
  await db.cartItem.update({ where: { id: item.id }, data: { quantity: args.quantity } });
}

/** Removing an item that is not there is not an error, so retries are safe. */
export async function removeCartItem(
  db: PrismaClient,
  scope: TenantScope,
  args: { token: string | null; variantId: string; now?: Date },
): Promise<void> {
  const cart = await findActiveCart(db, scope, args.token, args.now);
  if (!cart) return;
  await db.cartItem.deleteMany({ where: { cartId: cart.id, variantId: args.variantId } });
}

/** Server-computed cart. Shipping is included only when a delivery state is known (FR-CART-03). */
export async function viewCart(
  db: PrismaClient,
  store: StoreContext,
  args: { token: string | null; state?: string; now?: Date },
): Promise<CartView> {
  const cart = await findActiveCart(db, store.scope, args.token, args.now);
  const rows = cart
    ? await db.cartItem.findMany({
        where: { cartId: cart.id },
        orderBy: { variant: { sku: 'asc' } },
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
              product: { select: { slug: true, name: true, status: true, deletedAt: true } },
            },
          },
        },
      })
    : [];

  const lines: CartLine[] = rows.map((row) => {
    const v = row.variant;
    const purchasable = v.isActive && v.product.status === 'PUBLISHED' && v.product.deletedAt === null;
    return {
      variantId: v.id,
      sku: v.sku,
      productSlug: v.product.slug,
      productName: v.product.name,
      variantTitle: v.title,
      quantity: row.quantity,
      unitPriceMinor: v.priceMinor,
      lineTotalMinor: v.priceMinor * BigInt(row.quantity),
      purchasable,
      inStock: !v.trackInventory || v.onHand - v.reserved >= row.quantity,
    };
  });

  const priced = lines.filter((l) => l.purchasable);
  const subtotalMinor = priced.reduce((sum, l) => sum + l.lineTotalMinor, 0n);
  const delivery = args.state ? await quoteDelivery(db, store.scope, args.state, subtotalMinor) : null;

  // quoteDelivery has already applied the free-shipping rule, so the zone passed here carries the final fee.
  const totals = computeOrderTotals({
    lines: priced.map((l) => ({ unitPriceMinor: l.unitPriceMinor, quantity: l.quantity })),
    zone: delivery?.covered ? { feeMinor: delivery.feeMinor, freeShippingThresholdMinor: null } : null,
    vatRateBps: store.settings.vatRateBps,
    pricesIncludeVat: store.settings.pricesIncludeVat,
  });

  return {
    lines,
    subtotalMinor: totals.subtotalMinor,
    shippingMinor: delivery ? totals.shippingMinor : null,
    taxMinor: totals.taxMinor,
    totalMinor: totals.totalMinor,
    freeShipping: delivery?.covered ? delivery.freeShipping : false,
    delivery,
  };
}
