import { viewCart } from '@/server/cart/cart';
import { handle, jsonResponse } from '@/server/http/problem';
import { cartTokenFrom, storeAndDb } from '@/server/http/api';

export const dynamic = 'force-dynamic';

// GET /api/v1/cart?state=Lagos  Server-computed cart. Shipping appears when a state is given.
export function GET(request: Request) {
  return handle(async () => {
    const { db, store } = await storeAndDb();
    const state = new URL(request.url).searchParams.get('state') ?? undefined;
    const cart = await viewCart(db, store, { token: cartTokenFrom(request), state });
    return jsonResponse({ cart });
  });
}
