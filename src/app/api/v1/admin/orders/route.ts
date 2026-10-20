import { z } from 'zod';
import { requireStaff } from '@/server/auth/guard';
import { listOrdersForStaff } from '@/server/orders/admin';
import { ORDER_STATUSES } from '@/server/orders/stateMachine';
import { handle, jsonResponse } from '@/server/http/problem';
import { storeAndDb } from '@/server/http/api';

export const dynamic = 'force-dynamic';

const Query = z.object({
  status: z.enum(ORDER_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

// GET /api/v1/admin/orders?status=&limit=  Recent orders, customer contact masked.
export function GET(request: Request) {
  return handle(async () => {
    const { db, store } = await storeAndDb();
    await requireStaff(db, request, { permission: 'orders.view' });
    const url = new URL(request.url);
    const query = Query.parse(Object.fromEntries(url.searchParams));
    const orders = await listOrdersForStaff(db, store.scope, query);
    return jsonResponse({ orders }, 200, { 'Cache-Control': 'no-store' });
  });
}
