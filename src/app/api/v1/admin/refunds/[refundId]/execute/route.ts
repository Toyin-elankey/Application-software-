import { z } from 'zod';
import { requireJsonRequest, requireStaff } from '@/server/auth/guard';
import { storeAndDb } from '@/server/http/api';
import { handle, jsonResponse } from '@/server/http/problem';
import { getPaymentProvider } from '@/server/payments/resolve';
import { executeRefund } from '@/server/refunds/service';

export const dynamic = 'force-dynamic';

const Params = z.object({ refundId: z.uuid() });

// POST /api/v1/admin/refunds/{refundId}/execute  Needs refunds.approve. Sends the approved refund to the
// provider once. Body: {}.
export function POST(request: Request, context: { params: Promise<{ refundId: string }> }) {
  return handle(async () => {
    requireJsonRequest(request);
    const { refundId } = Params.parse(await context.params);
    const { db } = await storeAndDb();
    const actor = await requireStaff(db, request, { permission: 'refunds.approve' });
    const provider = getPaymentProvider();
    const refund = await executeRefund(db, provider, actor, refundId);
    return jsonResponse(refund, 200, { 'Cache-Control': 'no-store' });
  });
}
