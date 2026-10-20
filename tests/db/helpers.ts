import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';

export function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL must be set. Run database tests with: npm run test:db');
  return url;
}

export function createPrisma(): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: requireDatabaseUrl() }) });
}

export async function connectPg(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: requireDatabaseUrl() });
  await client.connect();
  return client;
}

// Unique suffix so fixtures created by different tests never collide.
export function unique(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

// Asserts that a promise rejects with the given PostgreSQL SQLSTATE code.
export async function expectSqlState(action: Promise<unknown>, sqlState: string): Promise<void> {
  let caught: unknown;
  try {
    await action;
  } catch (error) {
    caught = error;
  }
  if (!caught) throw new Error(`expected SQLSTATE ${sqlState}, but the statement succeeded`);
  const code = (caught as { code?: string }).code;
  if (code !== sqlState) {
    throw new Error(`expected SQLSTATE ${sqlState}, got ${code}: ${(caught as Error).message}`);
  }
}
