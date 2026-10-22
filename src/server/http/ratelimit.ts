import type { PrismaClient } from '@prisma/client';

// Per-IP sliding-window limits (02 §8). The count and the insert happen under one advisory lock per bucket,
// so parallel requests cannot all pass a limit that only one of them should. Only allowed events are
// recorded, so a refused caller does not extend its own block.

/** Builds the bucket name for one limit, one business and one IP. */
export function rateBucket(businessId: string, name: string, ip: string): string {
  return `${businessId}|${name}|ip|${ip}`.slice(0, 160);
}

/**
 * Records one event in the bucket and returns true, or returns false when `limit` events already fall inside
 * the window. Runs inside its own transaction.
 */
export async function consumeRateLimit(
  db: PrismaClient,
  input: { businessId: string; bucket: string; limit: number; windowMs: number; now?: Date },
): Promise<boolean> {
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - input.windowMs);
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`rl|${input.bucket}`}))`;
    await tx.rateLimitEvent.deleteMany({ where: { bucket: input.bucket, createdAt: { lte: since } } });
    const used = await tx.rateLimitEvent.count({ where: { bucket: input.bucket, createdAt: { gt: since } } });
    if (used >= input.limit) return false;
    await tx.rateLimitEvent.create({ data: { businessId: input.businessId, bucket: input.bucket, createdAt: now } });
    return true;
  });
}
