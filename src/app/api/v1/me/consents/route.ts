import { clientMeta, requireJsonRequest } from '@/server/auth/guard';
import { recordConsent, requireSignIn } from '@/server/customers/account';
import { ConsentBodySchema } from '@/server/customers/schema';
import { accessesFromCookies } from '@/server/customers/sessions';
import { handle, jsonResponse } from '@/server/http/problem';
import { readJson, storeAndDb } from '@/server/http/api';

export const dynamic = 'force-dynamic';

// POST /api/v1/me/consents {purpose, granted}. Grants or withdraws one WhatsApp or assistant purpose (02 §6.2).
// Each decision is a new ConsentRecord row. Withdrawing cancels that purpose's pending notifications (05 §2.6).
// Needs the customer's sign-in session.
export function POST(request: Request) {
  return handle(async () => {
    requireJsonRequest(request);
    const body = ConsentBodySchema.parse(await readJson(request));
    const { db, store } = await storeAndDb();
    const accesses = await accessesFromCookies(db, store.scope.businessId, request.headers.get('cookie'));
    const signIn = requireSignIn(accesses);
    const result = await recordConsent(db, store.scope, { customerId: signIn.customerId, ...body, ...clientMeta(request) });
    return jsonResponse(result, 200, { 'Cache-Control': 'no-store' });
  });
}
