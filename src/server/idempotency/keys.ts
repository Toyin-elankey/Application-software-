import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { toJsonSafe } from '@/lib/json';
import { AppError } from '@/server/http/problem';
import type { TenantScope } from '@/server/tenant';

// Idempotency for state-changing requests (PRD FR-CHK-05, 02 §5).
//
// A key is claimed in its own committed write before the business transaction starts. A concurrent
// duplicate therefore sees an in-progress claim and gets 409 instead of racing. The business
// transaction marks the claim COMPLETED in the same commit as the order. If the business step fails,
// the claim is released, so the client can retry with the same key.

export const IDEMPOTENCY_TTL_MINUTES = 15;

export function hashIdempotencyKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/** SHA-256 over a canonical JSON form (sorted keys), so the same request always gives the same hash. */
export function requestFingerprint(value: unknown): string {
  return createHash('sha256').update(canonicalJson(toJsonSafe(value)), 'utf8').digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export type KeyClaim =
  | { kind: 'claimed'; keyId: string }
  | { kind: 'replay'; responseStatus: number; responseBody: unknown };

export async function claimKey(
  db: PrismaClient,
  scope: TenantScope,
  args: { scope: string; keyHash: string; requestHash: string; now?: Date },
): Promise<KeyClaim> {
  const now = args.now ?? new Date();
  const expiresAt = new Date(now.getTime() + IDEMPOTENCY_TTL_MINUTES * 60_000);
  const where = { businessId_scope_keyHash: { businessId: scope.businessId, scope: args.scope, keyHash: args.keyHash } };

  try {
    const created = await db.idempotencyKey.create({
      data: {
        businessId: scope.businessId,
        scope: args.scope,
        keyHash: args.keyHash,
        requestHash: args.requestHash,
        state: 'IN_PROGRESS',
        expiresAt,
      },
      select: { id: true },
    });
    return { kind: 'claimed', keyId: created.id };
  } catch (error) {
    if ((error as { code?: string }).code !== 'P2002') throw error;
  }

  const existing = await db.idempotencyKey.findUnique({ where });
  if (!existing) throw new AppError(409, 'in_progress', 'This request is already being processed. Try again shortly.');
  if (existing.requestHash !== args.requestHash) {
    throw new AppError(422, 'idempotency_key_reused', 'This Idempotency-Key was used with a different request.');
  }
  if (existing.state === 'COMPLETED' && existing.responseStatus !== null) {
    return { kind: 'replay', responseStatus: existing.responseStatus, responseBody: existing.responseBody };
  }
  // IN_PROGRESS. Take it over only if the earlier attempt has expired (its process likely died).
  if (existing.expiresAt.getTime() <= now.getTime()) {
    const taken = await db.idempotencyKey.updateMany({
      where: { id: existing.id, state: 'IN_PROGRESS', expiresAt: { lte: now } },
      data: { expiresAt },
    });
    if (taken.count === 1) return { kind: 'claimed', keyId: existing.id };
  }
  throw new AppError(409, 'in_progress', 'This request is already being processed. Try again shortly.');
}

/** Releases an unfinished claim so the client can retry with the same key. */
export async function releaseKey(db: PrismaClient, keyId: string): Promise<void> {
  await db.idempotencyKey.deleteMany({ where: { id: keyId, state: 'IN_PROGRESS' } });
}
