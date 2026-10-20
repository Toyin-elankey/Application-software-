// A second business must never see the first business's catalogue (docs/03 §2, PRD multi-tenancy).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { getPublishedProductBySlug, listPublishedProducts } from '@/server/catalogue/products';
import { tenantScope } from '@/server/tenant';
import { createPrisma, unique } from './helpers';

const SAMPLE_SLUG = 'sample-brand';
let prisma: PrismaClient;
let sampleId: string;
let otherId: string;
let sampleProductId: string;

beforeAll(async () => {
  prisma = createPrisma();
  const sample = await prisma.business.findUniqueOrThrow({ where: { slug: SAMPLE_SLUG } });
  sampleId = sample.id;
  const sampleProduct = await prisma.product.findFirstOrThrow({
    where: { businessId: sampleId, slug: 'sample-tee' },
  });
  sampleProductId = sampleProduct.id;

  const other = await prisma.business.create({
    data: { slug: unique('other'), name: 'Other brand', countryCode: 'NG', currency: 'NGN', timezone: 'Africa/Lagos' },
  });
  otherId = other.id;
  await prisma.product.create({
    data: { businessId: otherId, slug: 'other-shirt', name: 'Other Shirt', description: 'Belongs to another business', status: 'PUBLISHED' },
  });
});

afterAll(async () => {
  await prisma?.$disconnect();
});

describe('tenant isolation', () => {
  it('lists only the products of the requested business', async () => {
    const otherProducts = await listPublishedProducts(prisma, tenantScope(otherId));
    expect(otherProducts.map((p) => p.slug)).toEqual(['other-shirt']);

    const sampleProducts = await listPublishedProducts(prisma, tenantScope(sampleId), { limit: 100 });
    expect(sampleProducts.map((p) => p.slug)).not.toContain('other-shirt');
    expect(sampleProducts.length).toBeGreaterThan(0);
  });

  it('does not return another business product by slug', async () => {
    const found = await getPublishedProductBySlug(prisma, tenantScope(sampleId), 'other-shirt');
    expect(found).toBeNull();
  });

  it('does not return a product by slug from the wrong business', async () => {
    const found = await getPublishedProductBySlug(prisma, tenantScope(otherId), 'sample-tee');
    expect(found).toBeNull();
    const own = await getPublishedProductBySlug(prisma, tenantScope(sampleId), 'sample-tee');
    expect(own?.id).toBe(sampleProductId);
  });

  it('never exposes stock levels in the public catalogue', async () => {
    const [product] = await listPublishedProducts(prisma, tenantScope(sampleId), { limit: 1 });
    const variant = product.variants[0];
    expect(variant).toBeDefined();
    expect(Object.keys(variant)).not.toContain('onHand');
    expect(Object.keys(variant)).not.toContain('reserved');
  });
});
