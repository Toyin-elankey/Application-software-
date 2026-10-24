import { AppError } from '@/server/http/problem';

// Keyset pagination for staff lists, newest first. The cursor names the last row returned, so a page
// never skips or repeats rows when new rows arrive in between. Opaque to the caller: base64url of
// `<ISO time>|<id>`, checked on the way in.

export type PageCursor = { createdAt: Date; id: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`, 'utf8').toString('base64url');
}

/** Reads a cursor from a query value. Absent gives null; anything malformed is a 400. */
export function decodeCursor(value: string | undefined | null): PageCursor | null {
  if (!value) return null;
  const text = Buffer.from(value, 'base64url').toString('utf8');
  const [iso, id, ...rest] = text.split('|');
  const createdAt = iso ? new Date(iso) : null;
  if (rest.length > 0 || !createdAt || Number.isNaN(createdAt.getTime()) || !id || !UUID.test(id)) {
    throw new AppError(400, 'invalid_cursor', 'The page cursor is not valid. Start again from the first page.');
  }
  return { createdAt, id };
}

/** The condition that selects rows strictly after the cursor in newest-first order. */
export function afterCursor(cursor: PageCursor | null): object {
  if (!cursor) return {};
  return {
    OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }],
  };
}

export const NEWEST_FIRST = [{ createdAt: 'desc' as const }, { id: 'desc' as const }];

/** Takes one more row than the page size, to tell whether another page exists. */
export function pageOf<T extends { createdAt: Date; id: string }>(rows: T[], limit: number): { items: T[]; nextCursor: string | null } {
  const items = rows.slice(0, limit);
  const more = rows.length > limit;
  return { items, nextCursor: more && items.length > 0 ? encodeCursor(items[items.length - 1]) : null };
}
