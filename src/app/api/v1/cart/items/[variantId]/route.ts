import { z } from 'zod';
import { changeCartItemQuantity, removeCartItem, viewCart } from '@/server/cart/cart';
import { MAX_LINE_QUANTITY } from '@/server/cart/limits';
import { handle, jsonResponse } from '@/server/http/problem';
import { cartTokenFrom, readJson, storeAndDb } from '@/server/http/api';

export const dynamic = 'force-dynamic';

const QuantityBody = z.object({ quantity: z.number().int().min(1).max(MAX_LINE_QUANTITY) });
const VariantParam = z.uuid();

// PATCH /api/v1/cart/items/{variantId}  Sets the quantity of an item already in the cart.
export function PATCH(request: Request, context: { params: Promise<{ variantId: string }> }) {
  return handle(async () => {
    const variantId = VariantParam.parse((await context.params).variantId);
    const body = QuantityBody.parse(await readJson(request));
    const { db, store } = await storeAndDb();
    const token = cartTokenFrom(request);
    await changeCartItemQuantity(db, store.scope, { token, variantId, quantity: body.quantity });
    return jsonResponse({ cart: await viewCart(db, store, { token }) });
  });
}

// DELETE /api/v1/cart/items/{variantId}  Removing an absent item is not an error.
export function DELETE(request: Request, context: { params: Promise<{ variantId: string }> }) {
  return handle(async () => {
    const variantId = VariantParam.parse((await context.params).variantId);
    const { db, store } = await storeAndDb();
    const token = cartTokenFrom(request);
    await removeCartItem(db, store.scope, { token, variantId });
    return jsonResponse({ cart: await viewCart(db, store, { token }) });
  });
}
