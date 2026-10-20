import { z } from 'zod';
import { requireJsonRequest, requireStaff } from '@/server/auth/guard';
import { STAFF_ROLES } from '@/server/auth/permissions';
import { readJson, storeAndDb } from '@/server/http/api';
import { handle, jsonResponse } from '@/server/http/problem';
import { createStaffMember, listStaff } from '@/server/staff/manage';

export const dynamic = 'force-dynamic';

const CreateBody = z.object({
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
  fullName: z.string().trim().min(1).max(120),
  role: z.enum(STAFF_ROLES),
});

// GET /api/v1/admin/staff  Lists staff on this business, including deactivated members. Needs staff.manage (Owner).
export function GET(request: Request) {
  return handle(async () => {
    const { db } = await storeAndDb();
    const actor = await requireStaff(db, request, { permission: 'staff.manage' });
    const staff = await listStaff(db, actor);
    return jsonResponse({ staff }, 200, { 'Cache-Control': 'no-store' });
  });
}

// POST /api/v1/admin/staff  Body: { email, fullName, role }. Returns the account once, with a temporary password.
export function POST(request: Request) {
  return handle(async () => {
    requireJsonRequest(request);
    const { db } = await storeAndDb();
    const actor = await requireStaff(db, request, { permission: 'staff.manage' });
    const body = CreateBody.parse(await readJson(request));
    const created = await createStaffMember(db, actor, body);
    return jsonResponse(created, 201, { 'Cache-Control': 'no-store' });
  });
}
