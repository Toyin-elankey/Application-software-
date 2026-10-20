#!/usr/bin/env node
// Creates or updates a staff member on the seeded business, for development and staging only.
// Production staff management arrives with the admin UI. The password is read from STAFF_PASSWORD,
// never from the command line, so it does not end up in shell history.
//
// Usage: STAFF_PASSWORD=... DATABASE_URL=... node scripts/db/create-staff.mjs --email a@b.c --name "Name" --role OWNER

import { hash } from '@node-rs/argon2';
import pg from 'pg';

const ROLES = ['OWNER', 'ADMIN', 'MANAGER', 'FULFILMENT', 'SUPPORT', 'FINANCE', 'VIEWER'];
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, arg, i, all) => (arg.startsWith('--') ? [...acc, [arg.slice(2), all[i + 1]]] : acc), []));

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (process.env.NODE_ENV === 'production') fail('create-staff refuses to run when NODE_ENV=production.');
const url = process.env.DATABASE_URL;
if (!url) fail('DATABASE_URL is required.');
const password = process.env.STAFF_PASSWORD ?? '';
if (password.length < 12) fail('STAFF_PASSWORD must be set and at least 12 characters.');
const email = String(args.email ?? '').trim().toLowerCase();
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail('--email must be a valid address.');
const name = String(args.name ?? '').trim();
if (!name || name.length > 120) fail('--name is required (max 120 characters).');
const role = String(args.role ?? '');
if (!ROLES.includes(role)) fail(`--role must be one of: ${ROLES.join(', ')}.`);

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const business = await client.query(`SELECT id FROM "Business" WHERE slug = 'sample-brand'`);
  if (business.rowCount !== 1) fail('The sample-brand business is not seeded. Run npm run db:seed first.');
  const passwordHash = await hash(password, { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 });
  await client.query('BEGIN');
  const user = await client.query(
    `INSERT INTO "StaffUser" (id, email, "fullName", "passwordHash", "updatedAt")
     VALUES (gen_random_uuid(), $1, $2, $3, now())
     ON CONFLICT (email) DO UPDATE SET "fullName" = EXCLUDED."fullName", "passwordHash" = EXCLUDED."passwordHash",
       "failedLoginCount" = 0, "lockedUntil" = NULL, "isActive" = true, "updatedAt" = now()
     RETURNING id`,
    [email, name, passwordHash],
  );
  await client.query(
    `INSERT INTO "StaffMembership" (id, "businessId", "staffUserId", role)
     VALUES (gen_random_uuid(), $1, $2, $3::"StaffRole")
     ON CONFLICT ("businessId", "staffUserId") DO UPDATE SET role = EXCLUDED.role`,
    [business.rows[0].id, user.rows[0].id, role],
  );
  await client.query('COMMIT');
  console.log(`staff ${email} is ${role} on sample-brand`);
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  fail(`create-staff failed: ${error instanceof Error ? error.message : 'unknown error'}`);
} finally {
  await client.end();
}
