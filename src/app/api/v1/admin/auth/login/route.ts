import { z } from 'zod';
import { clientMeta, requireJsonRequest, staffSetCookie } from '@/server/auth/guard';
import { signIn } from '@/server/auth/staff';
import { handle, jsonResponse } from '@/server/http/problem';
import { readJson, storeAndDb } from '@/server/http/api';

export const dynamic = 'force-dynamic';

const Body = z.object({ email: z.string().trim().email().max(254), password: z.string().min(1).max(256) });

// POST /api/v1/admin/auth/login. Sets the staff session cookie. MFA is a separate step for roles that need it.
export function POST(request: Request) {
  return handle(async () => {
    requireJsonRequest(request);
    const body = Body.parse(await readJson(request));
    const { db, store } = await storeAndDb();
    const meta = clientMeta(request);
    const result = await signIn(db, { businessId: store.scope.businessId, email: body.email, password: body.password, ...meta });
    return jsonResponse(
      { role: result.role, expiresAt: result.expiresAt.toISOString(), mfa: { required: result.mfaRequired, enrolled: result.mfaEnrolled, verified: false } },
      200,
      { 'Set-Cookie': staffSetCookie(result.token), 'Cache-Control': 'no-store' },
    );
  });
}
