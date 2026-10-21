import { clientMeta, requireJsonRequest } from '@/server/auth/guard';
import { grantOrderLookup, signInWithOtp } from '@/server/customers/auth';
import { CUSTOMER_COOKIE, CUSTOMER_SESSION_MS, customerSetCookie, ORDER_COOKIE, ORDER_SESSION_MS } from '@/server/customers/sessions';
import { OtpVerifySchema } from '@/server/customers/schema';
import { handle, jsonResponse } from '@/server/http/problem';
import { readJson, storeAndDb } from '@/server/http/api';

export const dynamic = 'force-dynamic';

// POST /api/v1/auth/otp/verify. A correct code opens a session: a 30-day sign-in session for CUSTOMER_LOGIN,
// or a 30-minute session for one order for ORDER_LOOKUP. Wrong, expired or used codes all answer 422.
export function POST(request: Request) {
  return handle(async () => {
    requireJsonRequest(request);
    const body = OtpVerifySchema.parse(await readJson(request));
    const { db, store } = await storeAndDb();
    const meta = clientMeta(request);
    const headers = { 'Cache-Control': 'no-store' };

    if (body.purpose === 'CUSTOMER_LOGIN') {
      const session = await signInWithOtp(db, { businessId: store.scope.businessId, phoneE164: body.phoneE164, code: body.code, ...meta });
      return jsonResponse({ signedIn: true, expiresAt: session.expiresAt.toISOString() }, 200, {
        ...headers,
        'Set-Cookie': customerSetCookie(CUSTOMER_COOKIE, session.token, CUSTOMER_SESSION_MS / 1000),
      });
    }

    const lookup = await grantOrderLookup(db, { businessId: store.scope.businessId, orderNumber: body.orderNumber, code: body.code, ...meta });
    return jsonResponse({ orderNumber: lookup.orderNumber, scope: 'ORDER', expiresAt: lookup.expiresAt.toISOString() }, 200, {
      ...headers,
      'Set-Cookie': customerSetCookie(ORDER_COOKIE, lookup.token, ORDER_SESSION_MS / 1000),
    });
  });
}
