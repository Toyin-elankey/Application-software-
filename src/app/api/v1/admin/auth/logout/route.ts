import { requireJsonRequest, requireStaff, staffClearCookie } from '@/server/auth/guard';
import { signOut } from '@/server/auth/staff';
import { handle, jsonResponse } from '@/server/http/problem';
import { storeAndDb } from '@/server/http/api';

export const dynamic = 'force-dynamic';

// POST /api/v1/admin/auth/logout. Ends this session and clears the cookie.
export function POST(request: Request) {
  return handle(async () => {
    requireJsonRequest(request);
    const { db } = await storeAndDb();
    const actor = await requireStaff(db, request, { allowMfaSetup: true });
    await signOut(db, actor);
    return jsonResponse({ ok: true }, 200, { 'Set-Cookie': staffClearCookie(), 'Cache-Control': 'no-store' });
  });
}
