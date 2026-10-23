import { describe, expect, it } from 'vitest';
import { AppError } from '@/server/http/problem';
import { decodeCursor, encodeCursor, pageOf } from './paging';
import { lagosDayStart } from './day';

const ID = '3f1c2b4a-9d8e-4f7a-8b6c-5d4e3f2a1b0c';

describe('cursors', () => {
  it('round-trip the last row of a page', () => {
    const row = { createdAt: new Date('2026-10-22T10:00:00.123Z'), id: ID };
    expect(decodeCursor(encodeCursor(row))).toEqual(row);
  });

  it('treat an absent cursor as the first page', () => {
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor('')).toBeNull();
  });

  it('refuse anything malformed with 400 invalid_cursor', () => {
    const bad = [
      'not-a-cursor',
      Buffer.from('2026-10-22T10:00:00Z', 'utf8').toString('base64url'), // no id
      Buffer.from(`not-a-date|${ID}`, 'utf8').toString('base64url'),
      Buffer.from(`2026-10-22T10:00:00Z|not-a-uuid`, 'utf8').toString('base64url'),
      Buffer.from(`2026-10-22T10:00:00Z|${ID}|extra`, 'utf8').toString('base64url'),
    ];
    for (const value of bad) {
      let caught: unknown;
      try {
        decodeCursor(value);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(AppError);
      expect((caught as AppError).code).toBe('invalid_cursor');
      expect((caught as AppError).status).toBe(400);
    }
  });
});

describe('pageOf', () => {
  const rows = [3, 2, 1].map((n) => ({ createdAt: new Date(`2026-10-22T10:00:0${n}Z`), id: `${ID.slice(0, -1)}${n}` }));

  it('returns a next cursor only when a row beyond the page exists', () => {
    const first = pageOf(rows, 2);
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    expect(pageOf(rows, 3).nextCursor).toBeNull();
    expect(pageOf(rows, 5).items).toHaveLength(3);
  });
});

describe('lagosDayStart', () => {
  it('starts the Lagos day at 23:00 UTC the day before', () => {
    expect(lagosDayStart(new Date('2026-10-22T23:30:00Z')).toISOString()).toBe('2026-10-22T23:00:00.000Z'); // 00:30 on the 23rd in Lagos
    expect(lagosDayStart(new Date('2026-10-22T22:30:00Z')).toISOString()).toBe('2026-10-21T23:00:00.000Z'); // 23:30 on the 22nd in Lagos
    expect(lagosDayStart(new Date('2026-10-22T12:00:00Z')).toISOString()).toBe('2026-10-21T23:00:00.000Z');
  });
});
