import { requireStaff } from '@/server/auth/guard';
import { requiresMfa } from '@/server/auth/permissions';
import { handle, jsonResponse } from '@/server/http/problem';
import { storeAndDb } from '@/server/http/api';

export const dynamic = 'force-dynamic';

// GET /api/v1/admin/auth/session. Who is signed in and what step they are on.
export function GET(request: Request) {
  return handle(async () => {
    const { db } = await storeAndDb();
    const actor = await requireStaff(db, request, { allowMfaSetup: true, allowPasswordChange: true });
    return jsonResponse(
      {
        email: actor.email,
        role: actor.role,
        passwordChangeRequired: actor.mustChangePassword,
        mfa: { required: requiresMfa(actor.role), enrolled: actor.mfaEnabled, verified: actor.mfaVerified },
      },
      200,
      { 'Cache-Control': 'no-store' },
    );
  });
}
