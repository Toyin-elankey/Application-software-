import { z } from 'zod';
import { setCartItem, viewCart } from '@/server/cart/cart';
import { MAX_LINE_QUANTITY } from '@/server/cart/limits';
import { handle } from '@/server/http/problem';
import { cartTokenFrom, jsonWithCookie, readJson, storeAndDb } from '@/server/http/api';

export const dynamic = 'force-dynamic';

const SetItemBody = z.object({
  variantId: z.uuid(),
  quantity: z.number().int().min(1).max(MAX_LINE_QUANTITY),
});

// POST /api/v1/cart/items  Sets a variant's quantity (adds it if new). Retrying has the same effect.
export function POST(request: Request) {
  return handle(async () => {
    const body = SetItemBody.parse(await readJson(request));
    const { db, store } = await storeAndDb();
    const token = cartTokenFrom(request);
    const { newToken } = await setCartItem(db, store.scope, { token, variantId: body.variantId, quantity: body.quantity });
    const cart = await viewCart(db, store, { token: token ?? newToken });
    return jsonWithCookie({ cart }, 200, newToken);
  });
}
