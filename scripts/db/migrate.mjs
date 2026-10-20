#!/usr/bin/env node
// Applies pending SQL migrations from prisma/migrations in name order.
//
// Bookkeeping uses Prisma's own `_prisma_migrations` table, with the same columns and the same
// checksum (SHA-256 of migration.sql). `prisma migrate deploy` therefore sees these migrations as
// applied, and the reverse is also true.
//
// Safety:
//  - An advisory lock stops two runs from applying the same migration at once.
//  - Each migration runs in one transaction, so a failure leaves nothing half-applied.
//  - An applied migration whose file has changed is an error. It is never re-applied.
//
// Usage: DATABASE_URL=postgresql://... node scripts/db/migrate.mjs

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const migrationsDir = join(root, 'prisma', 'migrations');

export function listMigrations(dir = migrationsDir) {
  return readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isDirectory())
    .filter((name) => existsSync(join(dir, name, 'migration.sql')))
    .sort()
    .map((name) => {
      const sql = readFileSync(join(dir, name, 'migration.sql'), 'utf8');
      return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    });
}

const BOOKKEEPING_DDL = `
CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
  "id" VARCHAR(36) PRIMARY KEY NOT NULL,
  "checksum" VARCHAR(64) NOT NULL,
  "finished_at" TIMESTAMPTZ,
  "migration_name" VARCHAR(255) NOT NULL,
  "logs" TEXT,
  "rolled_back_at" TIMESTAMPTZ,
  "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "applied_steps_count" INTEGER NOT NULL DEFAULT 0
)`;

export async function migrate(client, migrations = listMigrations()) {
  const applied = [];
  await client.query('SELECT pg_advisory_lock(hashtext($1))', ['commerce_schema_migrations']);
  try {
    await client.query(BOOKKEEPING_DDL);
    const { rows } = await client.query(
      'SELECT "migration_name", "checksum", "finished_at" FROM "_prisma_migrations" WHERE "rolled_back_at" IS NULL',
    );
    const done = new Map(rows.map((r) => [r.migration_name, r]));

    for (const m of migrations) {
      const existing = done.get(m.name);
      if (existing?.finished_at) {
        if (existing.checksum !== m.checksum) {
          throw new Error(`Migration ${m.name} was applied with different contents. Refusing to continue.`);
        }
        continue;
      }
      const started = Date.now();
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query(
          `INSERT INTO "_prisma_migrations" ("id", "checksum", "finished_at", "migration_name", "logs", "applied_steps_count")
           VALUES (gen_random_uuid()::text, $1, now(), $2, $3, 1)`,
          [m.checksum, m.name, `applied in ${Date.now() - started} ms`],
        );
        await client.query('COMMIT');
        applied.push(m.name);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${m.name} failed: ${error.message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', ['commerce_schema_migrations']);
  }
  return applied;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const applied = await migrate(client);
    console.log(applied.length ? `applied: ${applied.join(', ')}` : 'database is up to date');
  } finally {
    await client.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
