import { requireStaff } from '@/server/auth/guard';
import { overviewForStaff } from '@/server/admin/reads';
import { handle, jsonResponse } from '@/server/http/problem';
import { storeAndDb } from '@/server/http/api';

export const dynamic = 'force-dynamic';

// GET /api/v1/admin/overview. Counts and today's paid total for the staff dashboard (02 §6.5, overview.view).
export function GET(request: Request) {
  return handle(async () => {
    const { db, store } = await storeAndDb();
    await requireStaff(db, request, { permission: 'overview.view' });
    return jsonResponse(await overviewForStaff(db, store.scope), 200, { 'Cache-Control': 'no-store' });
  });
}
