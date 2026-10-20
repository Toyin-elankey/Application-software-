import { z } from 'zod';
import { requireJsonRequest, requireStaff } from '@/server/auth/guard';
import { parseIdempotencyKey } from '@/server/checkout/schema';
import { readJson, storeAndDb } from '@/server/http/api';
import { handle, jsonResponse } from '@/server/http/problem';
import { listRefundsForOrder, requestRefund } from '@/server/refunds/service';

export const dynamic = 'force-dynamic';

const Params = z.object({ orderId: z.uuid() });
const Body = z.object({
  amountMinor: z.union([z.number().int().positive().max(Number.MAX_SAFE_INTEGER), z.string().regex(/^[1-9]\d{0,14}$/)]).transform((v) => BigInt(v)),
  reason: z.string().trim().min(3).max(255),
});

// GET /api/v1/admin/orders/{orderId}/refunds  Refunds for one order. Needs payments.view.
export function GET(request: Request, context: { params: Promise<{ orderId: string }> }) {
  return handle(async () => {
    const { orderId } = Params.parse(await context.params);
    const { db, store } = await storeAndDb();
    await requireStaff(db, request, { permission: 'payments.view' });
    const refunds = await listRefundsForOrder(db, store.scope, orderId);
    return jsonResponse({ refunds }, 200, { 'Cache-Control': 'no-store' });
  });
}

// POST /api/v1/admin/orders/{orderId}/refunds  Body: { amountMinor, reason }. Needs refunds.request and Idempotency-Key.
export function POST(request: Request, context: { params: Promise<{ orderId: string }> }) {
  return handle(async () => {
    requireJsonRequest(request);
    const idempotencyKey = parseIdempotencyKey(request.headers.get('idempotency-key'));
    const { orderId } = Params.parse(await context.params);
    const { db } = await storeAndDb();
    const actor = await requireStaff(db, request, { permission: 'refunds.request' });
    const body = Body.parse(await readJson(request));
    const result = await requestRefund(db, actor, { orderId, amountMinor: body.amountMinor, reason: body.reason, idempotencyKey });
    return jsonResponse(result.body, result.status, { 'Cache-Control': 'no-store' });
  });
}
