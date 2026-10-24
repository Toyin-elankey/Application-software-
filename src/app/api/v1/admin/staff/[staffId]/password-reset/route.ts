import { z } from 'zod';
import { requireJsonRequest, requireStaff } from '@/server/auth/guard';
import { storeAndDb } from '@/server/http/api';
import { handle, jsonResponse } from '@/server/http/problem';
import { resetStaffPassword } from '@/server/staff/manage';

export const dynamic = 'force-dynamic';

const Params = z.object({ staffId: z.uuid() });

// POST /api/v1/admin/staff/{staffId}/password-reset  No body. Owner only (staff.manage). Returns the new
// temporary password once; the member must change it at next sign-in and all their sessions end.
export function POST(request: Request, context: { params: Promise<{ staffId: string }> }) {
  return handle(async () => {
    requireJsonRequest(request);
    const { staffId } = Params.parse(await context.params);
    const { db } = await storeAndDb();
    const actor = await requireStaff(db, request, { permission: 'staff.manage' });
    const member = await resetStaffPassword(db, actor, staffId);
    return jsonResponse(member, 200, { 'Cache-Control': 'no-store' });
  });
}
