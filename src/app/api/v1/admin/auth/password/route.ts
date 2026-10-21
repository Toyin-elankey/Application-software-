import { z } from 'zod';
import { changePassword } from '@/server/auth/staff';
import { requireJsonRequest, requireStaff } from '@/server/auth/guard';
import { MAX_PASSWORD_LENGTH } from '@/server/auth/password';
import { readJson, storeAndDb } from '@/server/http/api';
import { handle, jsonResponse } from '@/server/http/problem';

export const dynamic = 'force-dynamic';

// The length rules live in changePassword; this only checks the shape. The cap keeps hashing cheap.
const Body = z.object({
  currentPassword: z.string().min(1).max(MAX_PASSWORD_LENGTH),
  newPassword: z.string().min(1).max(MAX_PASSWORD_LENGTH),
});

// POST /api/v1/admin/auth/password  Body: { currentPassword, newPassword }. Needs a signed-in session and
// the current password. Allowed while a temporary password is still in use, and before MFA setup. Other
// sessions of the member end; this one stays signed in.
export function POST(request: Request) {
  return handle(async () => {
    requireJsonRequest(request);
    const body = Body.parse(await readJson(request));
    const { db } = await storeAndDb();
    const actor = await requireStaff(db, request, { allowMfaSetup: true, allowPasswordChange: true });
    const result = await changePassword(db, actor, body);
    return jsonResponse({ changed: true, sessionsRevoked: result.sessionsRevoked }, 200, { 'Cache-Control': 'no-store' });
  });
}
