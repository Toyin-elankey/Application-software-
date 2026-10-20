import { z } from 'zod';
import { viewCart } from '@/server/cart/cart';
import { quoteDelivery } from '@/server/delivery/quote';
import { handle, jsonResponse } from '@/server/http/problem';
import { cartTokenFrom, readJson, storeAndDb } from '@/server/http/api';

export const dynamic = 'force-dynamic';

const QuoteBody = z.object({ state: z.string().trim().min(1).max(60) });

// POST /api/v1/delivery/quote  Fee and estimate label for a state. Free shipping uses the cart subtotal.
export function POST(request: Request) {
  return handle(async () => {
    const body = QuoteBody.parse(await readJson(request));
    const { db, store } = await storeAndDb();
    const token = cartTokenFrom(request);
    const { subtotalMinor } = await viewCart(db, store, { token });
    return jsonResponse({ quote: await quoteDelivery(db, store.scope, body.state, subtotalMinor) });
  });
}
