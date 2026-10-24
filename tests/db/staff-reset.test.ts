// Owner-issued password reset for a member who has forgotten theirs (02 §6.5, 07 Stage 5), against a real
// PostgreSQL database: the old password stops working, the temporary password works once and forces a
// change, sessions end, the lockout clears, and the audit row never holds the password.
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '@/server/auth/password';
import type { StaffRoleName } from '@/server/auth/permissions';
import { resolveStaffActor, signIn, type StaffActor } from '@/server/auth/staff';
import { AppError } from '@/server/http/problem';
import { resetStaffPassword } from '@/server/staff/manage';
import { createPrisma, unique } from './helpers';

let db: PrismaClient;
const PASSWORD = 'correct horse battery staple';

beforeAll(() => {
  db = createPrisma();
});

afterAll(async () => {
  await db.$disconnect();
});

async function businessId(): Promise<string> {
  return (await db.business.findUniqueOrThrow({ where: { slug: 'sample-brand' }, select: { id: true } })).id;
}

/** A member of sample-brand, signed in once. Returns the id, email, session token and actor. */
async function person(role: StaffRoleName, password = PASSWORD) {
  const bizId = await businessId();
  const email = `${unique('reset')}@example.test`;
  const user = await db.staffUser.create({
    data: { email, fullName: 'Test Person', passwordHash: await hashPassword(password) },
    select: { id: true },
  });
  await db.staffMembership.create({ data: { businessId: bizId, staffUserId: user.id, role } });
  const { token } = await signIn(db, { businessId: bizId, email, password, ip: null, userAgent: null });
  const actor = await resolveStaffActor(db, bizId, token, { ip: '198.51.100.9', userAgent: 'vitest' });
  if (!actor) throw new Error('test setup: no actor');
  return { id: user.id, email, token, actor };
}

async function expectAppError(action: Promise<unknown>, status: number, code: string): Promise<void> {
  const error = await action.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).status).toBe(status);
  expect((error as AppError).code).toBe(code);
}

describe('resetting a forgotten password', () => {
  it('issues a one-time password: the old one stops working, the new one signs in and must be changed', async () => {
    const owner = await person('OWNER');
    const member = await person('ADMIN');
    const result = await resetStaffPassword(db, owner.actor, member.id);

    expect(result.temporaryPassword.length).toBeGreaterThanOrEqual(20);
    expect(result.id).toBe(member.id);
    expect(result.mustChangePassword).toBe(true);

    await expectAppError(signIn(db, { businessId: await businessId(), email: member.email, password: PASSWORD, ip: null, userAgent: null }), 401, 'invalid_credentials');

    const signedIn = await signIn(db, { businessId: await businessId(), email: member.email, password: result.temporaryPassword, ip: null, userAgent: null });
    const actor = await resolveStaffActor(db, await businessId(), signedIn.token, { ip: null, userAgent: null });
    expect(actor?.mustChangePassword).toBe(true);
  });

  it('stores only the hash of the new password', async () => {
    const owner = await person('OWNER');
    const member = await person('VIEWER');
    const result = await resetStaffPassword(db, owner.actor, member.id);
    const row = await db.staffUser.findUniqueOrThrow({ where: { id: member.id }, select: { passwordHash: true } });
    expect(row.passwordHash).toMatch(/^\$argon2id\$/);
    expect(row.passwordHash).not.toContain(result.temporaryPassword);
  });

  it('ends every session of the member at once, and says how many', async () => {
    const owner = await person('OWNER');
    const member = await person('SUPPORT');
    // A second session for the same member, so there are two to end.
    const second = await signIn(db, { businessId: await businessId(), email: member.email, password: PASSWORD, ip: null, userAgent: null });
    expect(await resolveStaffActor(db, await businessId(), member.token, { ip: null, userAgent: null })).not.toBeNull();

    await resetStaffPassword(db, owner.actor, member.id);

    expect(await resolveStaffActor(db, await businessId(), member.token, { ip: null, userAgent: null })).toBeNull();
    expect(await resolveStaffActor(db, await businessId(), second.token, { ip: null, userAgent: null })).toBeNull();
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'STAFF_PASSWORD_RESET', entityId: member.id } });
    expect(audit.changes).toEqual({ sessionsEnded: 2 });
  });

  it('clears a lockout, so the member can sign in with the temporary password straight away', async () => {
    const owner = await person('OWNER');
    const member = await person('FULFILMENT');
    await db.staffUser.update({ where: { id: member.id }, data: { failedLoginCount: 5, lockedUntil: new Date(Date.now() + 15 * 60 * 1000) } });

    const result = await resetStaffPassword(db, owner.actor, member.id);
    const row = await db.staffUser.findUniqueOrThrow({ where: { id: member.id }, select: { failedLoginCount: true, lockedUntil: true } });
    expect(row).toEqual({ failedLoginCount: 0, lockedUntil: null });

    const signedIn = await signIn(db, { businessId: await businessId(), email: member.email, password: result.temporaryPassword, ip: null, userAgent: null });
    expect(signedIn.role).toBe('FULFILMENT');
  });

  it('writes an audit row that names the actor and target, and never the password', async () => {
    const owner = await person('OWNER');
    const member = await person('MANAGER');
    const result = await resetStaffPassword(db, owner.actor, member.id);
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'STAFF_PASSWORD_RESET', entityId: member.id } });
    expect(audit.actorId).toBe(owner.id);
    expect(audit.entityType).toBe('StaffUser');
    expect(JSON.stringify(audit)).not.toContain(result.temporaryPassword);
  });

  it('lets an Owner reset another Owner', async () => {
    const owner = await person('OWNER');
    const otherOwner = await person('OWNER');
    const result = await resetStaffPassword(db, owner.actor, otherOwner.id);
    expect(result.role).toBe('OWNER');
    await expectAppError(signIn(db, { businessId: await businessId(), email: otherOwner.email, password: PASSWORD, ip: null, userAgent: null }), 401, 'invalid_credentials');
  });

  it('refuses a reset by an Admin, with 403, and leaves the password alone', async () => {
    const admin = await person('ADMIN');
    const member = await person('VIEWER');
    await expectAppError(resetStaffPassword(db, admin.actor, member.id), 403, 'forbidden');
    await signIn(db, { businessId: await businessId(), email: member.email, password: PASSWORD, ip: null, userAgent: null });
  });

  it('refuses an Owner resetting their own password here, with 422 use_password_change', async () => {
    const owner = await person('OWNER');
    await expectAppError(resetStaffPassword(db, owner.actor, owner.id), 422, 'use_password_change');
    await signIn(db, { businessId: await businessId(), email: owner.email, password: PASSWORD, ip: null, userAgent: null });
  });

  it('refuses a deactivated account with 422 staff_inactive', async () => {
    const owner = await person('OWNER');
    const member = await person('VIEWER');
    await db.staffUser.update({ where: { id: member.id }, data: { isActive: false } });
    await expectAppError(resetStaffPassword(db, owner.actor, member.id), 422, 'staff_inactive');
  });

  it('answers 404 for an unknown id and for a member of another business, and changes nothing', async () => {
    const owner = await person('OWNER');
    await expectAppError(resetStaffPassword(db, owner.actor, crypto.randomUUID()), 404, 'staff_not_found');

    const other = await db.business.create({ data: { slug: unique('other'), name: 'Other Shop' }, select: { id: true } });
    const outsider = await db.staffUser.create({
      data: { email: `${unique('out')}@example.test`, fullName: 'Outsider', passwordHash: await hashPassword(PASSWORD) },
      select: { id: true, email: true },
    });
    await db.staffMembership.create({ data: { businessId: other.id, staffUserId: outsider.id, role: 'VIEWER' } });
    await expectAppError(resetStaffPassword(db, owner.actor, outsider.id), 404, 'staff_not_found');
    await signIn(db, { businessId: other.id, email: outsider.email, password: PASSWORD, ip: null, userAgent: null });
  });

  it('serialises two resets of the same member: exactly one temporary password works afterwards', async () => {
    const ownerA = await person('OWNER');
    const ownerB = await person('OWNER');
    const member = await person('VIEWER');

    const [a, b] = await Promise.all([resetStaffPassword(db, ownerA.actor, member.id), resetStaffPassword(db, ownerB.actor, member.id)]);

    const bizId = await businessId();
    const outcomes = await Promise.allSettled(
      [a, b].map((r) => signIn(db, { businessId: bizId, email: member.email, password: r.temporaryPassword, ip: null, userAgent: null })),
    );
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
  });
});
