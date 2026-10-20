import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { getEnv } from '@/lib/env';

// One Prisma client per process. Server code only: it reads DATABASE_URL, which must never reach
// the browser bundle.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export function getDb(): PrismaClient {
  if (!globalForPrisma.prisma) {
    const url = getEnv().DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    globalForPrisma.prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  }
  return globalForPrisma.prisma;
}
