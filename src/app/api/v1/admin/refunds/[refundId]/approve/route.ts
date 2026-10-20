import { z } from 'zod';
import { getEnv } from '@/lib/env';
import { requireJsonRequest, requireStaff } from '@/server/auth/guard';
import { storeAndDb } from '@/server/http/api';
import { handle, jsonResponse } from '@/server/http/problem';
import { refundApprovalThresholdMinor } from '@/server/refunds/policy';
import { approveRefund } from '@/server/refunds/service';

export const dynamic = 'force-dynamic';

const Params = z.object({ refundId: z.uuid() });

// POST /api/v1/admin/refunds/{refundId}/approve  Needs refunds.approve (Owner, Finance). Body: {}.
export function POST(request: Request, context: { params: Promise<{ refundId: string }> }) {
  return handle(async () => {
    requireJsonRequest(request);
    const { refundId } = Params.parse(await context.params);
    const { db } = await storeAndDb();
    const actor = await requireStaff(db, request, { permission: 'refunds.approve' });
    const thresholdMinor = refundApprovalThresholdMinor(getEnv().REFUND_APPROVAL_THRESHOLD_MINOR);
    const refund = await approveRefund(db, actor, refundId, { thresholdMinor });
    return jsonResponse(refund, 200, { 'Cache-Control': 'no-store' });
  });
}
