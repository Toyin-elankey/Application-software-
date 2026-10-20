import { z } from 'zod';
import { readJson, storeAndDb } from '@/server/http/api';
import { requireJsonRequest, requireStaff } from '@/server/auth/guard';
import { revealCustomerContact } from '@/server/orders/admin';
import { handle, jsonResponse } from '@/server/http/problem';

export const dynamic = 'force-dynamic';

const Params = z.object({ orderId: z.uuid() });
const Body = z.object({ reason: z.string().trim().min(5).max(255) });

// POST /api/v1/admin/orders/{orderId}/customer/reveal  Body: { reason }. Audited on every call.
export function POST(request: Request, context: { params: Promise<{ orderId: string }> }) {
  return handle(async () => {
    requireJsonRequest(request);
    const { orderId } = Params.parse(await context.params);
    const body = Body.parse(await readJson(request));
    const { db } = await storeAndDb();
    const actor = await requireStaff(db, request, { permission: 'customers.reveal_pii' });
    const contact = await revealCustomerContact(db, actor, orderId, body.reason);
    return jsonResponse(contact, 200, { 'Cache-Control': 'no-store' });
  });
}
