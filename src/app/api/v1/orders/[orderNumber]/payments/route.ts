import { z } from 'zod';
import { findOrderForCustomer } from '@/server/customers/auth';
import { accessesFromCookies } from '@/server/customers/sessions';
import { OrderNumberSchema } from '@/server/customers/schema';
import { parseIdempotencyKey } from '@/server/checkout/schema';
import { AppError, handle, jsonResponse } from '@/server/http/problem';
import { storeAndDb } from '@/server/http/api';
import { getPaymentProvider } from '@/server/payments/resolve';
import { retryPayment } from '@/server/payments/retry';

export const dynamic = 'force-dynamic';

const Params = z.object({ orderNumber: OrderNumberSchema });

// POST /api/v1/orders/{orderNumber}/payments. Starts a new payment for an unpaid order, or resumes the open one.
// The path uses the order number, as the other customer routes do (02 §6.1 writes {orderId}; the number is what
// the customer holds, and Next.js does not allow two parameter names at one path). Requires Idempotency-Key.
// Needs a sign-in session for the order's customer, or a lookup session for this order.
export function POST(request: Request, context: { params: Promise<{ orderNumber: string }> }) {
  return handle(async () => {
    const { orderNumber } = Params.parse(await context.params);
    const { db, store } = await storeAndDb();
    const accesses = await accessesFromCookies(db, store.scope.businessId, request.headers.get('cookie'));
    if (accesses.length === 0) {
      throw new AppError(401, 'unauthenticated', 'Sign in, or enter the code sent to the phone on the order, to pay.');
    }
    const order = await findOrderForCustomer(db, store.scope, accesses, orderNumber);
    const idempotencyKey = parseIdempotencyKey(request.headers.get('idempotency-key'));
    const provider = getPaymentProvider();
    const result = await retryPayment(db, store.scope, { orderId: order.id, orderNumber: order.orderNumber, idempotencyKey, provider });
    return jsonResponse(result.body, result.status, { 'Cache-Control': 'no-store' });
  });
}
