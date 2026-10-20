import { z } from 'zod';
import { readJson, storeAndDb } from '@/server/http/api';
import { requireJsonRequest, requireStaff } from '@/server/auth/guard';
import { verifyMfaCode } from '@/server/auth/staff';
import { handle, jsonResponse } from '@/server/http/problem';

export const dynamic = 'force-dynamic';

const Body = z.object({ code: z.string().regex(/^\d{6}$/) });

// POST /api/v1/admin/auth/mfa/verify. Second step at sign-in for an enrolled account.
export function POST(request: Request) {
  return handle(async () => {
    requireJsonRequest(request);
    const body = Body.parse(await readJson(request));
    const { db } = await storeAndDb();
    const actor = await requireStaff(db, request, { allowMfaSetup: true });
    await verifyMfaCode(db, actor, body.code);
    return jsonResponse({ mfa: { required: true, enrolled: true, verified: true } }, 200, { 'Cache-Control': 'no-store' });
  });
}
