import { z } from 'zod';
import { requireJsonRequest, requireStaff } from '@/server/auth/guard';
import { STAFF_ROLES } from '@/server/auth/permissions';
import { readJson, storeAndDb } from '@/server/http/api';
import { handle, jsonResponse } from '@/server/http/problem';
import { updateStaffMember } from '@/server/staff/manage';

export const dynamic = 'force-dynamic';

const Params = z.object({ staffId: z.uuid() });
const PatchBody = z
  .object({ role: z.enum(STAFF_ROLES).optional(), isActive: z.boolean().optional() })
  .refine((body) => body.role !== undefined || body.isActive !== undefined, { message: 'Send role, isActive, or both.' });

// PATCH /api/v1/admin/staff/{staffId}  Body: { role?, isActive? }. Needs staff.manage (Owner).
export function PATCH(request: Request, context: { params: Promise<{ staffId: string }> }) {
  return handle(async () => {
    requireJsonRequest(request);
    const { staffId } = Params.parse(await context.params);
    const { db } = await storeAndDb();
    const actor = await requireStaff(db, request, { permission: 'staff.manage' });
    const body = PatchBody.parse(await readJson(request));
    const member = await updateStaffMember(db, actor, staffId, body);
    return jsonResponse(member, 200, { 'Cache-Control': 'no-store' });
  });
}
