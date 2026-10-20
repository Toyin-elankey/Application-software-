#!/usr/bin/env node
// Seeds a SAMPLE business for local development and tests. Idempotent: every row is an upsert on a
// unique key, so running it twice leaves the same data. It refuses to run when NODE_ENV=production.
//
// Contains only placeholder data: no real customers, phone numbers, prices or credentials.
// Staff users get a sentinel password hash that cannot match any password, so nobody can sign in
// with them until Stage 5 (Argon2id hashing) provides a proper development credential flow.

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { fileURLToPath } from 'node:url';

export const SAMPLE_SLUG = 'sample-brand';
export const NO_LOGIN_HASH = '!seed-no-login';

export function assertSeedAllowed(env) {
  if (env.NODE_ENV === 'production') {
    throw new Error('The seed refuses to run when NODE_ENV=production.');
  }
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
}

const CATEGORIES = [
  { slug: 'tops', name: 'Tops (sample)' },
  { slug: 'accessories', name: 'Accessories (sample)' },
];

// Six products, two sizes each: twelve variants. Prices are in kobo (NGN minor units).
const PRODUCTS = [
  { slug: 'sample-tee', name: 'Sample Tee', category: 'tops', priceMinor: 1500000n, status: 'PUBLISHED' },
  { slug: 'sample-shirt', name: 'Sample Shirt', category: 'tops', priceMinor: 2500000n, status: 'PUBLISHED' },
  { slug: 'sample-hoodie', name: 'Sample Hoodie', category: 'tops', priceMinor: 4500000n, status: 'PUBLISHED' },
  { slug: 'sample-cap', name: 'Sample Cap', category: 'accessories', priceMinor: 900000n, status: 'PUBLISHED' },
  { slug: 'sample-tote', name: 'Sample Tote', category: 'accessories', priceMinor: 1800000n, status: 'PUBLISHED' },
  { slug: 'sample-scarf', name: 'Sample Scarf (draft)', category: 'accessories', priceMinor: 1200000n, status: 'DRAFT' },
];

const SIZES = ['S', 'M'];

const ZONES = [
  { name: 'Lagos Mainland (sample)', feeMinor: 150000n, etaLabel: 'Sample estimate: 1-2 days', sortOrder: 1 },
  { name: 'Lagos Island (sample)', feeMinor: 200000n, etaLabel: 'Sample estimate: 2-3 days', sortOrder: 2 },
];

const STAFF = [
  { email: 'owner@sample.invalid', fullName: 'Sample Owner', role: 'OWNER' },
  { email: 'manager@sample.invalid', fullName: 'Sample Manager', role: 'MANAGER' },
  { email: 'fulfilment@sample.invalid', fullName: 'Sample Fulfilment', role: 'FULFILMENT' },
];

export async function seed(prisma) {
  const business = await prisma.business.upsert({
    where: { slug: SAMPLE_SLUG },
    update: {},
    create: {
      slug: SAMPLE_SLUG,
      name: 'SAMPLE Brand (placeholder)',
      countryCode: 'NG',
      currency: 'NGN',
      timezone: 'Africa/Lagos',
    },
  });
  const businessId = business.id;

  const categoryIds = {};
  for (const c of CATEGORIES) {
    const row = await prisma.category.upsert({
      where: { businessId_slug: { businessId, slug: c.slug } },
      update: {},
      create: { businessId, slug: c.slug, name: c.name },
    });
    categoryIds[c.slug] = row.id;
  }

  for (const p of PRODUCTS) {
    const product = await prisma.product.upsert({
      where: { businessId_slug: { businessId, slug: p.slug } },
      update: {},
      create: {
        businessId,
        slug: p.slug,
        name: p.name,
        description: 'Placeholder description. Replace before launch.',
        categoryId: categoryIds[p.category],
        status: p.status,
      },
    });

    const option = await prisma.productOption.upsert({
      where: { productId_name: { productId: product.id, name: 'Size' } },
      update: {},
      create: { productId: product.id, name: 'Size', position: 1 },
    });

    for (const [index, size] of SIZES.entries()) {
      const value = await prisma.productOptionValue.upsert({
        where: { optionId_value: { optionId: option.id, value: size } },
        update: {},
        create: { optionId: option.id, value: size, position: index + 1 },
      });
      const sku = `SAMPLE-${p.slug.toUpperCase()}-${size}`;
      const variant = await prisma.productVariant.upsert({
        where: { businessId_sku: { businessId, sku } },
        update: {},
        create: {
          businessId,
          productId: product.id,
          sku,
          title: `${p.name} / ${size}`,
          priceMinor: p.priceMinor,
          trackInventory: true,
          onHand: 20,
          reserved: 0,
          isDefault: index === 0,
          isActive: true,
        },
      });
      await prisma.variantOptionValue.upsert({
        where: { variantId_optionValueId: { variantId: variant.id, optionValueId: value.id } },
        update: {},
        create: { variantId: variant.id, optionValueId: value.id },
      });
    }
  }

  for (const z of ZONES) {
    const existing = await prisma.deliveryZone.findFirst({ where: { businessId, name: z.name } });
    if (!existing) {
      await prisma.deliveryZone.create({
        data: { businessId, name: z.name, feeMinor: z.feeMinor, etaLabel: z.etaLabel, isActive: true, sortOrder: z.sortOrder },
      });
    }
  }

  for (const s of STAFF) {
    const user = await prisma.staffUser.upsert({
      where: { email: s.email },
      update: {},
      create: { email: s.email, fullName: s.fullName, passwordHash: NO_LOGIN_HASH },
    });
    await prisma.staffMembership.upsert({
      where: { businessId_staffUserId: { businessId, staffUserId: user.id } },
      update: {},
      create: { businessId, staffUserId: user.id, role: s.role },
    });
  }

  return { businessId };
}

async function main() {
  assertSeedAllowed(process.env);
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });
  try {
    const { businessId } = await seed(prisma);
    console.log(`seeded sample business ${businessId}`);
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
