import { z } from 'zod';
import { clientMeta, requireJsonRequest } from '@/server/auth/guard';
import { requireSignIn, requestCancelCode } from '@/server/customers/account';
import { getOtpSender } from '@/server/customers/delivery';
import { OrderNumberSchema } from '@/server/customers/schema';
import { accessesFromCookies } from '@/server/customers/sessions';
import { handle, jsonResponse } from '@/server/http/problem';
import { storeAndDb } from '@/server/http/api';

export const dynamic = 'force-dynamic';

const Params = z.object({ orderNumber: OrderNumberSchema });

// POST /api/v1/me/orders/{orderNumber}/cancel/code. Sends the code that authorises cancelling this order
// (the "recent OTP" of 02 §6.2). It goes to the phone on the order. Answers 202 whether or not a code was sent
// (limits and cooldown apply), as the other OTP requests do. Needs the customer's sign-in session. Send
// Content-Type: application/json with any body or `{}`; the body is ignored (the header is a cross-site guard).
export function POST(request: Request, context: { params: Promise<{ orderNumber: string }> }) {
  return handle(async () => {
    requireJsonRequest(request);
    const { orderNumber } = Params.parse(await context.params);
    const { db, store } = await storeAndDb();
    const accesses = await accessesFromCookies(db, store.scope.businessId, request.headers.get('cookie'));
    const signIn = requireSignIn(accesses);
    const result = await requestCancelCode(db, getOtpSender(), store.scope, { customerId: signIn.customerId, orderNumber, ip: clientMeta(request).ip });
    return jsonResponse(result, 202, { 'Cache-Control': 'no-store' });
  });
}
