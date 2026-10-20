import { requireJsonRequest, requireStaff } from '@/server/auth/guard';
import { beginMfaEnrolment } from '@/server/auth/staff';
import { handle, jsonResponse } from '@/server/http/problem';
import { storeAndDb } from '@/server/http/api';

export const dynamic = 'force-dynamic';

// POST /api/v1/admin/auth/mfa/enroll. Returns the secret once, for an authenticator app.
export function POST(request: Request) {
  return handle(async () => {
    requireJsonRequest(request);
    const { db } = await storeAndDb();
    const actor = await requireStaff(db, request, { allowMfaSetup: true });
    const setup = await beginMfaEnrolment(db, actor);
    return jsonResponse(setup, 200, { 'Cache-Control': 'no-store' });
  });
}
