// Staff password change and temporary passwords (FR-ADM-10, A-15), against a real PostgreSQL database.
// Covers: a temporary password marks the member, a wrong current password counts toward the lockout,
// the length and same-password rules, the flag clearing, other sessions ending while this one stays,
// two changes at once, and an audit row that holds neither password.
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '@/server/auth/password';
import { changePassword, resolveStaffActor, signIn, type StaffActor } from '@/server/auth/staff';
import { createStaffMember } from '@/server/staff/manage';
import { createPrisma, unique } from './helpers';
import { createStore } from './commerce-fixtures';

let db: PrismaClient;
const PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'a new passphrase for 2026';
const meta = { ip: '198.51.100.7', userAgent: 'vitest' };

beforeAll(() => {
  db = createPrisma();
});

afterAll(async () => {
  await db.$disconnect();
});

async function expectAppError(action: Promise<unknown>, status: number, code: string): Promise<void> {
  const error = await action.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toMatchObject({ status, code });
}

/** An Owner signed in, to create members. Built directly, so the test does not depend on the MFA step. */
async function ownerActor(businessId: string): Promise<StaffActor> {
  const email = `${unique('owner')}@example.test`;
  const user = await db.staffUser.create({
    data: { email, fullName: 'Owner', passwordHash: await hashPassword(PASSWORD), mfaEnabled: false },
    select: { id: true },
  });
  await db.staffMembership.create({ data: { businessId, staffUserId: user.id, role: 'OWNER' } });
  const { token } = await signIn(db, { businessId, email, password: PASSWORD, ...meta });
  const actor = await resolveStaffActor(db, businessId, token, meta);
  if (!actor) throw new Error('test setup: no owner actor');
  return actor;
}

/** A member created the way the API creates one, signed in with the temporary password. */
async function newMember(businessId: string) {
  const owner = await ownerActor(businessId);
  const created = await createStaffMember(db, owner, { email: `${unique('finance')}@example.test`, fullName: 'Finance Member', role: 'FINANCE' });
  const signed = await signIn(db, { businessId, email: created.email, password: created.temporaryPassword, ...meta });
  const actor = await resolveStaffActor(db, businessId, signed.token, meta);
  if (!actor) throw new Error('test setup: no member actor');
  return { created, token: signed.token, actor, temporaryPassword: created.temporaryPassword };
}

async function flags(staffUserId: string) {
  return db.staffUser.findUniqueOrThrow({ where: { id: staffUserId }, select: { mustChangePassword: true, failedLoginCount: true, lockedUntil: true } });
}

describe('temporary passwords', () => {
  it('a new member is marked to change the temporary password, and can sign in with it', async () => {
    const store = await createStore(db);
    const { created, actor } = await newMember(store.businessId);
    expect(created).toMatchObject({ role: 'FINANCE', mustChangePassword: true });
    expect(actor.mustChangePassword).toBe(true);
    expect((await flags(created.id)).mustChangePassword).toBe(true);
  });

  it('a wrong current password is refused (422), counts as a failure, and leaves the flag set', async () => {
    const store = await createStore(db);
    const { created, actor } = await newMember(store.businessId);
    await expectAppError(changePassword(db, actor, { currentPassword: 'not the password', newPassword: NEW_PASSWORD }), 422, 'current_password_incorrect');
    expect(await flags(created.id)).toMatchObject({ mustChangePassword: true, failedLoginCount: 1 });
  });

  it('five wrong current passwords lock the account, and then even the right one is refused (423)', async () => {
    const store = await createStore(db);
    const { created, actor, temporaryPassword } = await newMember(store.businessId);
    for (let i = 0; i < 5; i += 1) {
      await expectAppError(changePassword(db, actor, { currentPassword: `wrong guess ${i} here`, newPassword: NEW_PASSWORD }), 422, 'current_password_incorrect');
    }
    expect((await flags(created.id)).lockedUntil).not.toBeNull();
    await expectAppError(changePassword(db, actor, { currentPassword: temporaryPassword, newPassword: NEW_PASSWORD }), 423, 'account_locked');
  });
});

describe('the new password', () => {
  it('refuses one character under the minimum (422 weak_password) and over the maximum', async () => {
    const store = await createStore(db);
    const { actor, temporaryPassword } = await newMember(store.businessId);
    await expectAppError(changePassword(db, actor, { currentPassword: temporaryPassword, newPassword: 'a'.repeat(11) }), 422, 'weak_password');
    await expectAppError(changePassword(db, actor, { currentPassword: temporaryPassword, newPassword: 'a'.repeat(257) }), 422, 'weak_password');
  });

  it('must differ from the current password (422 password_unchanged)', async () => {
    const store = await createStore(db);
    const { actor, temporaryPassword } = await newMember(store.businessId);
    await expectAppError(changePassword(db, actor, { currentPassword: temporaryPassword, newPassword: temporaryPassword }), 422, 'password_unchanged');
  });
});

describe('a successful change', () => {
  it('clears the flag, the old password stops working, and the new one signs in', async () => {
    const store = await createStore(db);
    const { created, actor, temporaryPassword } = await newMember(store.businessId);
    const result = await changePassword(db, actor, { currentPassword: temporaryPassword, newPassword: NEW_PASSWORD });
    expect(result.sessionsRevoked).toBe(0);

    expect(await flags(created.id)).toMatchObject({ mustChangePassword: false, failedLoginCount: 0 });
    await expectAppError(signIn(db, { businessId: store.businessId, email: created.email, password: temporaryPassword, ...meta }), 401, 'invalid_credentials');
    const again = await signIn(db, { businessId: store.businessId, email: created.email, password: NEW_PASSWORD, ...meta });
    expect(again.token).toBeTruthy();
  });

  it('ends the member\'s other sessions and keeps the one that made the change', async () => {
    const store = await createStore(db);
    const { created, actor, token, temporaryPassword } = await newMember(store.businessId);
    // A second session for the same member, signed in with the same temporary password.
    const other = await signIn(db, { businessId: store.businessId, email: created.email, password: temporaryPassword, ...meta });

    const result = await changePassword(db, actor, { currentPassword: temporaryPassword, newPassword: NEW_PASSWORD });
    expect(result.sessionsRevoked).toBe(1);
    expect(await resolveStaffActor(db, store.businessId, other.token, meta)).toBeNull();
    expect(await resolveStaffActor(db, store.businessId, token, meta)).toMatchObject({ mustChangePassword: false });
  });

  it('two changes at once: exactly one succeeds', async () => {
    const store = await createStore(db);
    const { actor, temporaryPassword } = await newMember(store.businessId);
    const results = await Promise.allSettled([
      changePassword(db, actor, { currentPassword: temporaryPassword, newPassword: 'first new passphrase here' }),
      changePassword(db, actor, { currentPassword: temporaryPassword, newPassword: 'second new passphrase here' }),
    ]);
    const succeeded = results.filter((r) => r.status === 'fulfilled');
    expect(succeeded).toHaveLength(1);
    const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect([409, 422]).toContain((failed.reason as { status: number }).status);
  });

  it('writes an audit row that holds neither password', async () => {
    const store = await createStore(db);
    const { created, actor, temporaryPassword } = await newMember(store.businessId);
    await changePassword(db, actor, { currentPassword: temporaryPassword, newPassword: NEW_PASSWORD });
    const row = await db.auditLog.findFirstOrThrow({ where: { action: 'STAFF_PASSWORD_CHANGED', entityId: created.id } });
    expect(row.actorId).toBe(created.id);
    const text = JSON.stringify(row.changes);
    expect(text).not.toContain(NEW_PASSWORD);
    expect(text).not.toContain(temporaryPassword);
  });
});
