import { z } from 'zod';
import { requireStaff } from '@/server/auth/guard';
import { listPaymentsForStaff } from '@/server/admin/reads';
import { decodeCursor } from '@/server/admin/paging';
import { handle, jsonResponse } from '@/server/http/problem';
import { storeAndDb } from '@/server/http/api';

export const dynamic = 'force-dynamic';

const PAYMENT_STATUSES = ['INITIALIZED', 'PENDING', 'SUCCEEDED', 'FAILED', 'ABANDONED'] as const;

const Query = z.object({
  status: z.enum(PAYMENT_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(200).optional(),
});

// GET /api/v1/admin/payments?status=&limit=&cursor=  (payments.view)
export function GET(request: Request) {
  return handle(async () => {
    const { db, store } = await storeAndDb();
    await requireStaff(db, request, { permission: 'payments.view' });
    const query = Query.parse(Object.fromEntries(new URL(request.url).searchParams));
    const page = await listPaymentsForStaff(db, store.scope, { status: query.status, limit: query.limit, cursor: decodeCursor(query.cursor) });
    return jsonResponse(page, 200, { 'Cache-Control': 'no-store' });
  });
}
