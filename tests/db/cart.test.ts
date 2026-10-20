import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { changeCartItemQuantity, removeCartItem, setCartItem, viewCart } from '@/server/cart/cart';
import { AppError } from '@/server/http/problem';
import { createPrisma } from './helpers';
import { createProduct, createStore } from './commerce-fixtures';

let db: PrismaClient;

beforeAll(() => {
  db = createPrisma();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('cart', () => {
  it('creates a cart on first write and returns a token that is never stored in clear', async () => {
    const { scope, store } = await createStore(db);
    const product = await createProduct(db, scope.businessId, { priceMinor: 1500000n });

    const { newToken } = await setCartItem(db, scope, { token: null, variantId: product.variantId, quantity: 2 });
    expect(newToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const carts = await db.cart.findMany({ where: { businessId: scope.businessId }, select: { tokenHash: true } });
    expect(carts).toHaveLength(1);
    expect(carts[0].tokenHash).not.toBe(newToken);
    expect(carts[0].tokenHash).toMatch(/^[0-9a-f]{64}$/);

    const view = await viewCart(db, store, { token: newToken });
    expect(view.lines).toHaveLength(1);
    expect(view.subtotalMinor).toBe(3000000n);
  });

  it('sets the quantity rather than adding, so a retried request has the same effect', async () => {
    const { scope, store } = await createStore(db);
    const product = await createProduct(db, scope.businessId);
    const { newToken: token } = await setCartItem(db, scope, { token: null, variantId: product.variantId, quantity: 3 });
    await setCartItem(db, scope, { token, variantId: product.variantId, quantity: 3 });
    await setCartItem(db, scope, { token, variantId: product.variantId, quantity: 3 });
    const view = await viewCart(db, store, { token });
    expect(view.lines.map((l) => l.quantity)).toEqual([3]);
  });

  it('refuses a quantity above the per-line limit (D-09) before touching the database', async () => {
    const { scope } = await createStore(db);
    const product = await createProduct(db, scope.businessId);
    await expect(setCartItem(db, scope, { token: null, variantId: product.variantId, quantity: 11 })).rejects.toThrow(RangeError);
  });

  it('refuses a quantity above available stock without revealing the stock level', async () => {
    const { scope } = await createStore(db);
    const product = await createProduct(db, scope.businessId, { onHand: 4, reserved: 1 });
    let caught: unknown;
    try {
      await setCartItem(db, scope, { token: null, variantId: product.variantId, quantity: 4 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe('insufficient_stock');
    expect((caught as AppError).message).not.toMatch(/\b3\b/);
  });

  it('does not let a customer add a draft product, and reports it as not purchasable', async () => {
    const { scope } = await createStore(db);
    const draft = await createProduct(db, scope.businessId, { status: 'DRAFT' });
    await expect(setCartItem(db, scope, { token: null, variantId: draft.variantId, quantity: 1 })).rejects.toMatchObject({
      code: 'variant_not_found',
    });
  });

  it('keeps a product out of the subtotal once it is unpublished after being added', async () => {
    const { scope, store } = await createStore(db);
    const kept = await createProduct(db, scope.businessId, { priceMinor: 1000000n });
    const gone = await createProduct(db, scope.businessId, { priceMinor: 500000n });
    const { newToken: token } = await setCartItem(db, scope, { token: null, variantId: kept.variantId, quantity: 1 });
    await setCartItem(db, scope, { token, variantId: gone.variantId, quantity: 1 });
    await db.product.update({ where: { id: gone.productId }, data: { status: 'ARCHIVED' } });

    const view = await viewCart(db, store, { token });
    expect(view.lines.find((l) => l.variantId === gone.variantId)?.purchasable).toBe(false);
    expect(view.subtotalMinor).toBe(1000000n);
  });

  it('includes shipping only when a state is known, and waives it above the threshold', async () => {
    const { scope, store } = await createStore(db, { threshold: 2000000n, zoneFee: 150000n });
    const product = await createProduct(db, scope.businessId, { priceMinor: 1500000n });
    const { newToken: token } = await setCartItem(db, scope, { token: null, variantId: product.variantId, quantity: 1 });

    const noState = await viewCart(db, store, { token });
    expect(noState.shippingMinor).toBeNull();
    expect(noState.totalMinor).toBe(1500000n);

    const below = await viewCart(db, store, { token, state: 'Lagos' });
    expect(below.shippingMinor).toBe(150000n);
    expect(below.totalMinor).toBe(1650000n);

    await changeCartItemQuantity(db, scope, { token, variantId: product.variantId, quantity: 2 });
    const above = await viewCart(db, store, { token, state: 'Lagos' });
    expect(above.freeShipping).toBe(true);
    expect(above.shippingMinor).toBe(0n);
    expect(above.totalMinor).toBe(3000000n);
  });

  it('reports VAT as information from the goods subtotal', async () => {
    const { scope, store } = await createStore(db);
    const product = await createProduct(db, scope.businessId, { priceMinor: 1075000n });
    const { newToken: token } = await setCartItem(db, scope, { token: null, variantId: product.variantId, quantity: 1 });
    const view = await viewCart(db, store, { token });
    expect(view.taxMinor).toBe(75000n); // 10,750.00 incl. 7.5% VAT
  });

  it('changes and removes items, and removing an absent item is not an error', async () => {
    const { scope, store } = await createStore(db);
    const product = await createProduct(db, scope.businessId);
    const { newToken: token } = await setCartItem(db, scope, { token: null, variantId: product.variantId, quantity: 1 });
    await changeCartItemQuantity(db, scope, { token, variantId: product.variantId, quantity: 5 });
    expect((await viewCart(db, store, { token })).lines[0].quantity).toBe(5);

    await removeCartItem(db, scope, { token, variantId: product.variantId });
    await removeCartItem(db, scope, { token, variantId: product.variantId });
    expect((await viewCart(db, store, { token })).lines).toHaveLength(0);
  });

  it('does not expose one business cart to another business', async () => {
    const a = await createStore(db);
    const b = await createStore(db);
    const product = await createProduct(db, a.scope.businessId);
    const { newToken: token } = await setCartItem(db, a.scope, { token: null, variantId: product.variantId, quantity: 1 });

    const seenByB = await viewCart(db, b.store, { token });
    expect(seenByB.lines).toHaveLength(0);
    await expect(setCartItem(db, b.scope, { token, variantId: product.variantId, quantity: 1 })).rejects.toMatchObject({
      code: 'variant_not_found',
    });
  });

  it('ignores an expired cart and starts a new one', async () => {
    const { scope, store } = await createStore(db);
    const product = await createProduct(db, scope.businessId);
    const { newToken: token } = await setCartItem(db, scope, { token: null, variantId: product.variantId, quantity: 1 });
    await db.cart.updateMany({ where: { businessId: scope.businessId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await viewCart(db, store, { token })).lines).toHaveLength(0);
    const { newToken: fresh } = await setCartItem(db, scope, { token, variantId: product.variantId, quantity: 1 });
    expect(fresh).not.toBeNull();
    expect((await viewCart(db, store, { token: fresh })).lines).toHaveLength(1);
  });

  it('rejects an item that is not in the cart when changing its quantity', async () => {
    const { scope } = await createStore(db);
    const product = await createProduct(db, scope.businessId);
    await expect(changeCartItemQuantity(db, scope, { token: 'x'.repeat(43), variantId: product.variantId, quantity: 2 })).rejects.toMatchObject({
      code: 'cart_item_not_found',
    });
  });
});
