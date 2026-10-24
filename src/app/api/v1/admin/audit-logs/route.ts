import { z } from 'zod';
import { requireStaff } from '@/server/auth/guard';
import { listAuditLogsForStaff } from '@/server/admin/reads';
import { decodeCursor } from '@/server/admin/paging';
import { handle, jsonResponse } from '@/server/http/problem';
import { storeAndDb } from '@/server/http/api';

export const dynamic = 'force-dynamic';

const Query = z.object({
  action: z.string().max(80).optional(),
  entityType: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(200).optional(),
});

// GET /api/v1/admin/audit-logs?action=&entityType=&limit=&cursor=  (audit.view)
export function GET(request: Request) {
  return handle(async () => {
    const { db, store } = await storeAndDb();
    await requireStaff(db, request, { permission: 'audit.view' });
    const query = Query.parse(Object.fromEntries(new URL(request.url).searchParams));
    const page = await listAuditLogsForStaff(db, store.scope, {
      action: query.action,
      entityType: query.entityType,
      limit: query.limit,
      cursor: decodeCursor(query.cursor),
    });
    return jsonResponse(page, 200, { 'Cache-Control': 'no-store' });
  });
}
