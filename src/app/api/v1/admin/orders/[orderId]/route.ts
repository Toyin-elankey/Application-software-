import { z } from 'zod';
import { requireStaff } from '@/server/auth/guard';
import { etagFor, getOrderForStaff } from '@/server/orders/admin';
import { handle, jsonResponse } from '@/server/http/problem';
import { storeAndDb } from '@/server/http/api';

export const dynamic = 'force-dynamic';

const Params = z.object({ orderId: z.uuid() });

// GET /api/v1/admin/orders/{orderId}. Masked contact details; ETag carries the version for If-Match.
export function GET(request: Request, context: { params: Promise<{ orderId: string }> }) {
  return handle(async () => {
    const { orderId } = Params.parse(await context.params);
    const { db, store } = await storeAndDb();
    await requireStaff(db, request, { permission: 'orders.view' });
    const order = await getOrderForStaff(db, store.scope, orderId);
    return jsonResponse(order, 200, { ETag: etagFor(order.version), 'Cache-Control': 'no-store' });
  });
}
