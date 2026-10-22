import { z } from 'zod';
import { clientMeta, requireJsonRequest } from '@/server/auth/guard';
import { cancelOrderAsCustomer, requireSignIn } from '@/server/customers/account';
import { CancelBodySchema, OrderNumberSchema } from '@/server/customers/schema';
import { accessesFromCookies } from '@/server/customers/sessions';
import { handle, jsonResponse } from '@/server/http/problem';
import { readJson, storeAndDb } from '@/server/http/api';

export const dynamic = 'force-dynamic';

const Params = z.object({ orderNumber: OrderNumberSchema });

// POST /api/v1/me/orders/{orderNumber}/cancel with {code}. Needs the customer's sign-in session and the code
// sent by /cancel/code (02 §6.2: "recent OTP"). A wrong, expired or used code answers 422 otp_invalid.
// Unpaid orders are cancelled; paid ones move to REFUND_PENDING. Someone else's order answers 404.
export function POST(request: Request, context: { params: Promise<{ orderNumber: string }> }) {
  return handle(async () => {
    requireJsonRequest(request);
    const { orderNumber } = Params.parse(await context.params);
    const body = CancelBodySchema.parse(await readJson(request));
    const { db, store } = await storeAndDb();
    const accesses = await accessesFromCookies(db, store.scope.businessId, request.headers.get('cookie'));
    const signIn = requireSignIn(accesses);
    const result = await cancelOrderAsCustomer(db, store.scope, { customerId: signIn.customerId, orderNumber, code: body.code, ...clientMeta(request) });
    return jsonResponse(result, 200, { 'Cache-Control': 'no-store' });
  });
}
