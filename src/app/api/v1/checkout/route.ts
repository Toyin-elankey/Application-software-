import { placeOrder } from '@/server/checkout/checkout';
import { CheckoutBodySchema, parseIdempotencyKey } from '@/server/checkout/schema';
import { handle, jsonResponse } from '@/server/http/problem';
import { cartTokenFrom, readJson, storeAndDb } from '@/server/http/api';
import { getPaymentProvider } from '@/server/payments/resolve';

export const dynamic = 'force-dynamic';

// POST /api/v1/checkout  Creates a PENDING_PAYMENT order and reserves stock. Requires Idempotency-Key.
export function POST(request: Request) {
  return handle(async () => {
    const idempotencyKey = parseIdempotencyKey(request.headers.get('idempotency-key'));
    const body = CheckoutBodySchema.parse(await readJson(request));
    const { db, store } = await storeAndDb();
    const provider = getPaymentProvider();
    const result = await placeOrder(db, store, {
      cartToken: cartTokenFrom(request),
      idempotencyKey,
      body,
      provider,
    });
    return jsonResponse(result.body, result.status);
  });
}
