import { clientMeta } from '@/server/auth/guard';
import { signOutCustomer } from '@/server/customers/auth';
import { accessesFromCookies, customerClearCookie, CUSTOMER_COOKIE, ORDER_COOKIE } from '@/server/customers/sessions';
import { handle, jsonResponse } from '@/server/http/problem';
import { storeAndDb } from '@/server/http/api';

export const dynamic = 'force-dynamic';

// POST /api/v1/auth/logout. Ends whichever customer sessions the cookies name and clears both cookies.
// No body is needed. SameSite=Lax cookies are not sent on cross-site POSTs, so this cannot be forced from another site.
export function POST(request: Request) {
  return handle(async () => {
    const { db, store } = await storeAndDb();
    const cookieHeader = request.headers.get('cookie');
    const accesses = await accessesFromCookies(db, store.scope.businessId, cookieHeader);
    await signOutCustomer(db, { businessId: store.scope.businessId, accesses, ...clientMeta(request) });
    const response = jsonResponse({ signedOut: true }, 200);
    response.headers.append('Set-Cookie', customerClearCookie(CUSTOMER_COOKIE));
    response.headers.append('Set-Cookie', customerClearCookie(ORDER_COOKIE));
    return response;
  });
}
