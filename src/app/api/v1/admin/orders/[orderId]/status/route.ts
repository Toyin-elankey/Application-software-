import { z } from 'zod';
import { readJson, storeAndDb } from '@/server/http/api';
import { requireJsonRequest, requireStaff } from '@/server/auth/guard';
import { etagFor, parseIfMatch, transitionOrderForStaff } from '@/server/orders/admin';
import { ORDER_STATUSES } from '@/server/orders/stateMachine';
import { handle, jsonResponse } from '@/server/http/problem';

export const dynamic = 'force-dynamic';

const Params = z.object({ orderId: z.uuid() });
const Body = z.object({ to: z.enum(ORDER_STATUSES), reason: z.string().trim().min(1).max(255).nullable().optional() });

// PATCH /api/v1/admin/orders/{orderId}/status  Body: { to, reason? }. Header: If-Match: "<version>".
export function PATCH(request: Request, context: { params: Promise<{ orderId: string }> }) {
  return handle(async () => {
    requireJsonRequest(request);
    const { orderId } = Params.parse(await context.params);
    const expectedVersion = parseIfMatch(request.headers.get('if-match'));
    const body = Body.parse(await readJson(request));
    const { db } = await storeAndDb();
    const actor = await requireStaff(db, request);
    const result = await transitionOrderForStaff(db, actor, {
      orderId,
      expectedVersion,
      to: body.to,
      reason: body.reason ?? null,
    });
    return jsonResponse(result, 200, { ETag: etagFor(result.version), 'Cache-Control': 'no-store' });
  });
}
