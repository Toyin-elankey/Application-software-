// Staff management (FR-ADM-10, 02 §6.5 `/admin/staff`), against a real PostgreSQL database. Covers the
// one-time temporary password, email uniqueness, owner protection, self-protection, session revocation
// on role change and deactivation, reactivation, and audit rows.
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '@/server/auth/password';
import type { StaffRoleName } from '@/server/auth/permissions';
import { resolveStaffActor, signIn, type StaffActor } from '@/server/auth/staff';
import { AppError } from '@/server/http/problem';
import { createStaffMember, listStaff, updateStaffMember } from '@/server/staff/manage';
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

/** Creates a staff member on sample-brand, signs them in, and returns their actor and session token. */
async function person(role: StaffRoleName, password = PASSWORD) {
  const bizId = await businessId();
  const email = `${unique('staff')}@example.test`;
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

async function asActor(token: string): Promise<StaffActor | null> {
  return resolveStaffActor(db, await businessId(), token, { ip: null, userAgent: null });
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

describe('creating staff', () => {
  it('creates an account with a one-time temporary password that signs in and is never stored in plain text', async () => {
    const owner = await person('OWNER');
    const email = `${unique('new')}@example.test`;
    const created = await createStaffMember(db, owner.actor, { email, fullName: '  New Person ', role: 'SUPPORT' });

    expect(created.temporaryPassword.length).toBeGreaterThanOrEqual(20);
    expect(created.role).toBe('SUPPORT');
    expect(created.fullName).toBe('New Person');

    const row = await db.staffUser.findUniqueOrThrow({ where: { id: created.id }, select: { passwordHash: true } });
    expect(row.passwordHash).toMatch(/^\$argon2id\$/);
    expect(row.passwordHash).not.toContain(created.temporaryPassword);

    const signedIn = await signIn(db, { businessId: await businessId(), email, password: created.temporaryPassword, ip: null, userAgent: null });
    expect(signedIn.role).toBe('SUPPORT');
  });

  it('writes an audit row for the creation that does not contain the password', async () => {
    const owner = await person('OWNER');
    const created = await createStaffMember(db, owner.actor, { email: `${unique('aud')}@example.test`, fullName: 'Audited', role: 'VIEWER' });
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'STAFF_CREATED', entityId: created.id } });
    expect(audit.actorId).toBe(owner.id);
    expect(audit.entityType).toBe('StaffUser');
    expect(audit.changes).toEqual({ role: 'VIEWER' });
    expect(JSON.stringify(audit)).not.toContain(created.temporaryPassword);
  });

  it('refuses an email already in use, whatever its case, with 409 email_in_use', async () => {
    const owner = await person('OWNER');
    const email = `${unique('dup')}@example.test`;
    await createStaffMember(db, owner.actor, { email, fullName: 'First', role: 'VIEWER' });
    await expectAppError(createStaffMember(db, owner.actor, { email: email.toUpperCase(), fullName: 'Second', role: 'VIEWER' }), 409, 'email_in_use');
  });

  it('refuses creation by an Admin (staff.manage is Owner only)', async () => {
    const admin = await person('ADMIN');
    await expectAppError(createStaffMember(db, admin.actor, { email: `${unique('no')}@example.test`, fullName: 'Nope', role: 'VIEWER' }), 403, 'forbidden');
  });

  it('refuses an Admin creating an Owner, with 403', async () => {
    const admin = await person('ADMIN');
    await expectAppError(createStaffMember(db, admin.actor, { email: `${unique('own')}@example.test`, fullName: 'Nope', role: 'OWNER' }), 403, 'forbidden');
  });
});

describe('changing staff', () => {
  it('a role change takes effect on the next request: the old session ends and the new role applies at sign-in', async () => {
    const owner = await person('OWNER');
    const member = await person('SUPPORT');
    const updated = await updateStaffMember(db, owner.actor, member.id, { role: 'MANAGER' });
    expect(updated.role).toBe('MANAGER');
    expect(await asActor(member.token)).toBeNull();

    const signedIn = await signIn(db, { businessId: await businessId(), email: member.email, password: PASSWORD, ip: null, userAgent: null });
    expect(signedIn.role).toBe('MANAGER');

    const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'STAFF_ROLE_CHANGED', entityId: member.id } });
    expect(audit.changes).toEqual({ from: 'SUPPORT', to: 'MANAGER' });
  });

  it('deactivation revokes every session at once and blocks sign-in with the generic error', async () => {
    const owner = await person('OWNER');
    const member = await person('FINANCE');
    expect(await asActor(member.token)).not.toBeNull();

    const updated = await updateStaffMember(db, owner.actor, member.id, { isActive: false });
    expect(updated.isActive).toBe(false);
    expect(await asActor(member.token)).toBeNull();

    const sessions = await db.staffSession.findMany({ where: { staffUserId: member.id }, select: { revokedAt: true } });
    expect(sessions.every((s) => s.revokedAt !== null)).toBe(true);

    await expectAppError(signIn(db, { businessId: await businessId(), email: member.email, password: PASSWORD, ip: null, userAgent: null }), 401, 'invalid_credentials');
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'STAFF_DEACTIVATED', entityId: member.id } });
    expect(audit.actorId).toBe(owner.id);
  });

  it('reactivation lets the member sign in again, but an old session does not come back', async () => {
    const owner = await person('OWNER');
    const member = await person('VIEWER');
    await updateStaffMember(db, owner.actor, member.id, { isActive: false });
    const reactivated = await updateStaffMember(db, owner.actor, member.id, { isActive: true });
    expect(reactivated.isActive).toBe(true);

    expect(await asActor(member.token)).toBeNull();
    const signedIn = await signIn(db, { businessId: await businessId(), email: member.email, password: PASSWORD, ip: null, userAgent: null });
    expect(signedIn.role).toBe('VIEWER');
    expect(await db.auditLog.count({ where: { action: 'STAFF_REACTIVATED', entityId: member.id } })).toBe(1);
  });

  it('an Owner account cannot be deactivated or demoted through this API', async () => {
    const owner = await person('OWNER');
    const other = await person('OWNER');
    await expectAppError(updateStaffMember(db, owner.actor, other.id, { isActive: false }), 422, 'owner_protected');
    await expectAppError(updateStaffMember(db, owner.actor, other.id, { role: 'ADMIN' }), 422, 'owner_protected');
    const row = await db.staffMembership.findFirstOrThrow({ where: { staffUserId: other.id }, select: { role: true } });
    expect(row.role).toBe('OWNER');
    expect(await asActor(other.token)).not.toBeNull();
  });

  it('nobody can change their own account', async () => {
    const owner = await person('OWNER');
    await expectAppError(updateStaffMember(db, owner.actor, owner.id, { isActive: false }), 422, 'self_change_refused');
    await expectAppError(updateStaffMember(db, owner.actor, owner.id, { role: 'ADMIN' }), 422, 'self_change_refused');
  });

  it('an Owner can promote a member to Owner', async () => {
    const owner = await person('OWNER');
    const member = await person('MANAGER');
    const updated = await updateStaffMember(db, owner.actor, member.id, { role: 'OWNER' });
    expect(updated.role).toBe('OWNER');
  });

  it('refuses every change by an Admin, and leaves the member untouched', async () => {
    const admin = await person('ADMIN');
    const member = await person('SUPPORT');
    await expectAppError(updateStaffMember(db, admin.actor, member.id, { role: 'MANAGER' }), 403, 'forbidden');
    await expectAppError(updateStaffMember(db, admin.actor, member.id, { isActive: false }), 403, 'forbidden');
    expect(await asActor(member.token)).not.toBeNull();
  });

  it('answers 404 for an unknown member on this business', async () => {
    const owner = await person('OWNER');
    await expectAppError(updateStaffMember(db, owner.actor, randomUUID(), { isActive: false }), 404, 'staff_not_found');
  });

  it('two concurrent edits to one member both run, one after the other', async () => {
    const owner = await person('OWNER');
    const member = await person('SUPPORT');
    const results = await Promise.allSettled([
      updateStaffMember(db, owner.actor, member.id, { role: 'MANAGER' }),
      updateStaffMember(db, owner.actor, member.id, { role: 'FINANCE' }),
    ]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    // The two changes form a chain: one replaces SUPPORT, the other replaces whatever that one wrote.
    const audits = await db.auditLog.findMany({ where: { action: 'STAFF_ROLE_CHANGED', entityId: member.id } });
    const steps = audits.map((a) => a.changes as { from: string; to: string });
    expect(steps).toHaveLength(2);
    const first = steps.find((s) => s.from === 'SUPPORT');
    const second = steps.find((s) => s !== first);
    expect(first).toBeDefined();
    expect(second?.from).toBe(first?.to);
    const final = await db.staffMembership.findFirstOrThrow({ where: { staffUserId: member.id }, select: { role: true } });
    expect(final.role).toBe(second?.to);
  });
});

describe('listing staff', () => {
  it('shows deactivated members and never returns secrets', async () => {
    const owner = await person('OWNER');
    const member = await person('VIEWER');
    await updateStaffMember(db, owner.actor, member.id, { isActive: false });

    const staff = await listStaff(db, owner.actor);
    const row = staff.find((s) => s.id === member.id);
    expect(row).toMatchObject({ email: member.email, role: 'VIEWER', isActive: false });
    const json = JSON.stringify(staff);
    expect(json).not.toContain('passwordHash');
    expect(json).not.toContain('mfaSecret');
    expect(json).not.toContain('$argon2id');
  });

  it('refuses a listing by an Admin', async () => {
    const admin = await person('ADMIN');
    await expectAppError(listStaff(db, admin.actor), 403, 'forbidden');
  });
});
