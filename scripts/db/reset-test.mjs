#!/usr/bin/env node
// Resets a DISPOSABLE test database: drops and recreates the public schema, applies every migration,
// then seeds. It refuses any database whose name does not contain "test", so it cannot wipe a
// development or production database by mistake.

import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { migrate, listMigrations } from './migrate.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function assertTestDatabase(url) {
  const parsed = new URL(url);
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!/test/i.test(name)) {
    throw new Error(`Refusing to reset database "${name}": its name must contain "test".`);
  }
  return name;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const name = assertTestDatabase(url);

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public');
    const applied = await migrate(client, listMigrations());
    console.log(`reset ${name}; applied ${applied.length} migrations`);
  } finally {
    await client.end();
  }

  execFileSync(process.execPath, [join(root, 'scripts', 'db', 'seed.mjs')], {
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'test' },
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
