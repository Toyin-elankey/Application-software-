import type { PrismaClient } from '@prisma/client';
import type { TenantScope } from '@/server/tenant';

// Catalogue reads for the storefront. Stock counts (onHand, reserved) are deliberately not selected:
// the public catalogue must not reveal inventory levels.

const MAX_PAGE = 100;

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return 24;
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError('limit must be a positive integer');
  return Math.min(limit, MAX_PAGE);
}

export async function listPublishedProducts(db: PrismaClient, scope: TenantScope, options: { limit?: number } = {}) {
  return db.product.findMany({
    where: { businessId: scope.businessId, status: 'PUBLISHED', deletedAt: null },
    orderBy: { name: 'asc' },
    take: clampLimit(options.limit),
    select: {
      id: true,
      slug: true,
      name: true,
      shortDescription: true,
      variants: {
        where: { isActive: true },
        orderBy: { sku: 'asc' },
        select: { id: true, sku: true, title: true, priceMinor: true },
      },
    },
  });
}

export async function getPublishedProductBySlug(db: PrismaClient, scope: TenantScope, slug: string) {
  return db.product.findFirst({
    where: { businessId: scope.businessId, slug, status: 'PUBLISHED', deletedAt: null },
    select: {
      id: true,
      slug: true,
      name: true,
      shortDescription: true,
      description: true,
      variants: {
        where: { isActive: true },
        orderBy: { sku: 'asc' },
        select: { id: true, sku: true, title: true, priceMinor: true },
      },
    },
  });
}
