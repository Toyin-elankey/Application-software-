// The seed is idempotent and refuses production.
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createPrisma, requireDatabaseUrl } from './helpers';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const seedScript = join(root, 'scripts', 'db', 'seed.mjs');
let prisma: PrismaClient;

// Counts rows belonging to the sample business only. Other test files create their own businesses.
async function counts(p: PrismaClient) {
  const sample = { business: { slug: 'sample-brand' } };
  return {
    businesses: await p.business.count({ where: { slug: 'sample-brand' } }),
    products: await p.product.count({ where: sample }),
    variants: await p.productVariant.count({ where: sample }),
    zones: await p.deliveryZone.count({ where: sample }),
    staff: await p.staffMembership.count({ where: sample }),
  };
}

beforeAll(() => {
  prisma = createPrisma();
});

afterAll(async () => {
  await prisma?.$disconnect();
});

describe('seed', () => {
  it('creates the expected sample data', async () => {
    const c = await counts(prisma);
    expect(c.businesses).toBe(1);
    expect(c.products).toBe(6);
    expect(c.variants).toBe(12);
    expect(c.zones).toBe(2);
    expect(c.staff).toBe(3);
  });

  it('is idempotent: running it again changes nothing', async () => {
    const first = await counts(prisma);
    const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: requireDatabaseUrl(), NODE_ENV: 'test' };
    const run = spawnSync(process.execPath, [seedScript], { env, encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(await counts(prisma)).toEqual(first);
  });

  it('refuses to run when NODE_ENV is production, and writes nothing', async () => {
    const before = await counts(prisma);
    const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: requireDatabaseUrl(), NODE_ENV: 'production' };
    const run = spawnSync(process.execPath, [seedScript], { env, encoding: 'utf8' });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/refuses to run when NODE_ENV=production/);
    expect(await counts(prisma)).toEqual(before);
  });

  it('gives staff a password hash that matches no password', async () => {
    const staff = await prisma.staffUser.findMany({ select: { passwordHash: true } });
    for (const s of staff) expect(s.passwordHash.startsWith('!')).toBe(true);
  });
});
