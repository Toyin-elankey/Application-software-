import { z } from 'zod';
import { requireStaff } from '@/server/auth/guard';
import { listCustomersForStaff } from '@/server/admin/reads';
import { decodeCursor } from '@/server/admin/paging';
import { handle, jsonResponse } from '@/server/http/problem';
import { storeAndDb } from '@/server/http/api';

export const dynamic = 'force-dynamic';

const Query = z.object({
  q: z.string().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(200).optional(),
});

// GET /api/v1/admin/customers?q=&limit=&cursor=. Masked list (customers.view_masked). Revealing a full number
// is a separate, audited action (02 §6.5 pii.reveal).
export function GET(request: Request) {
  return handle(async () => {
    const { db, store } = await storeAndDb();
    await requireStaff(db, request, { permission: 'customers.view_masked' });
    const query = Query.parse(Object.fromEntries(new URL(request.url).searchParams));
    const page = await listCustomersForStaff(db, store.scope, { q: query.q, limit: query.limit, cursor: decodeCursor(query.cursor) });
    return jsonResponse(page, 200, { 'Cache-Control': 'no-store' });
  });
}
