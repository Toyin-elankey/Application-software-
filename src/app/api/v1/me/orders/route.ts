import { requireSignIn, listCustomerOrders } from '@/server/customers/account';
import { accessesFromCookies } from '@/server/customers/sessions';
import { handle, jsonResponse } from '@/server/http/problem';
import { storeAndDb } from '@/server/http/api';

export const dynamic = 'force-dynamic';

// GET /api/v1/me/orders. The signed-in customer's own orders, newest first (02 §6.2). A lookup session is not enough.
export function GET(request: Request) {
  return handle(async () => {
    const { db, store } = await storeAndDb();
    const accesses = await accessesFromCookies(db, store.scope.businessId, request.headers.get('cookie'));
    const signIn = requireSignIn(accesses);
    const orders = await listCustomerOrders(db, store.scope, signIn.customerId);
    return jsonResponse({ orders }, 200, { 'Cache-Control': 'no-store' });
  });
}
