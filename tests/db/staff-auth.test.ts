// Staff sign-in, sessions, lockout, timeouts, revocation and MFA (A-15, 02 §8, PRD §4.1), against a real
// PostgreSQL database. Uses the seeded business (sample-brand) for anything that goes through the
// route guard, because the guard resolves the store from STORE_BUSINESS_SLUG.
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requireStaff, staffSetCookie, staffTokenFrom } from '@/server/auth/guard';
import { hashPassword } from '@/server/auth/password';
import type { StaffRoleName } from '@/server/auth/permissions';
import {
  ABSOLUTE_TIMEOUT_MS,
  beginMfaEnrolment,
  confirmMfaEnrolment,
  IDLE_TIMEOUT_MS,
  LOCK_MS,
  resolveStaffActor,
  revokeAllSessions,
  signIn,
  signOut,
  verifyMfaCode,
  type StaffActor,
} from '@/server/auth/staff';
import { base32Decode, totpAt, timeStep } from '@/server/auth/totp';
import { createPrisma, unique } from './helpers';

let db: PrismaClient;
const PASSWORD = 'correct horse battery staple';

beforeAll(() => {
  db = createPrisma();
});

afterAll(async () => {
  await db.$disconnect();
});

async function businessId(slug = 'sample-brand'): Promise<string> {
  return (await db.business.findUniqueOrThrow({ where: { slug }, select: { id: true } })).id;
}

async function makeStaff(role: StaffRoleName, options: { businessId?: string; mfa?: boolean } = {}) {
  const bizId = options.businessId ?? (await businessId());
  const email = `${unique('staff')}@example.test`;
  const user = await db.staffUser.create({
    data: { email, fullName: 'Test Staff', passwordHash: await hashPassword(PASSWORD), mfaEnabled: false },
    select: { id: true },
  });
  await db.staffMembership.create({ data: { businessId: bizId, staffUserId: user.id, role } });
  return { id: user.id, email, businessId: bizId, role };
}

async function login(staff: { email: string; businessId: string }, now = new Date(), password = PASSWORD) {
  return signIn(db, { businessId: staff.businessId, email: staff.email, password, ip: '203.0.113.7', userAgent: 'vitest', now });
}

async function actorFor(token: string, bizId: string, now = new Date()): Promise<StaffActor | null> {
  return resolveStaffActor(db, bizId, token, { ip: null, userAgent: null }, now);
}

/** The code the user's authenticator would show right now, given the secret we were shown. */
function codeFor(secretBase32: string, at = new Date()): string {
  return totpAt(base32Decode(secretBase32), timeStep(at.getTime()));
}

describe('sign-in', () => {
  it('accepts the right password and issues a session; the database keeps only a hash of the token', async () => {
    const staff = await makeStaff('SUPPORT');
    const result = await login(staff);
    expect(result.token.length).toBeGreaterThan(30);
    const stored = await db.staffSession.findFirstOrThrow({ where: { staffUserId: staff.id } });
    expect(stored.tokenHash).not.toBe(result.token);
    expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('gives the same generic answer for a wrong password and for an unknown email', async () => {
    const staff = await makeStaff('SUPPORT');
    const wrong = await login(staff, new Date(), 'not the password').catch((e) => e);
    const unknown = await signIn(db, { businessId: staff.businessId, email: 'nobody@example.test', password: PASSWORD, ip: null, userAgent: null }).catch((e) => e);
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.message).toBe(unknown.message);
  });

  it('refuses a deactivated account even with the right password', async () => {
    const staff = await makeStaff('SUPPORT');
    await db.staffUser.update({ where: { id: staff.id }, data: { isActive: false } });
    await expect(login(staff)).rejects.toMatchObject({ status: 401 });
  });

  it('refuses an account with no membership in this business', async () => {
    const staff = await makeStaff('SUPPORT');
    const other = await db.business.create({ data: { slug: unique('other'), name: 'Other' }, select: { id: true } });
    await expect(login({ email: staff.email, businessId: other.id })).rejects.toMatchObject({ status: 401 });
  });
});

describe('lockout', () => {
  it('locks after five failures, refuses even the right password while locked, and unlocks after 15 minutes', async () => {
    const staff = await makeStaff('SUPPORT');
    const start = new Date();
    for (let i = 0; i < 5; i++) {
      await expect(login(staff, start, 'wrong')).rejects.toMatchObject({ status: 401 });
    }
    await expect(login(staff, start)).rejects.toMatchObject({ status: 423, code: 'account_locked' });

    const later = new Date(start.getTime() + LOCK_MS + 1000);
    await expect(login(staff, later)).resolves.toBeDefined();
  });

  it('a success resets the failure count', async () => {
    const staff = await makeStaff('SUPPORT');
    for (let i = 0; i < 4; i++) await expect(login(staff, new Date(), 'wrong')).rejects.toMatchObject({ status: 401 });
    await login(staff);
    const user = await db.staffUser.findUniqueOrThrow({ where: { id: staff.id } });
    expect(user.failedLoginCount).toBe(0);
  });
});

describe('sessions: timeouts, logout, deactivation, revocation', () => {
  it('a session works while active', async () => {
    const staff = await makeStaff('SUPPORT');
    const { token } = await login(staff);
    expect((await actorFor(token, staff.businessId))?.role).toBe('SUPPORT');
  });

  it('expires after 30 minutes of idleness', async () => {
    const staff = await makeStaff('SUPPORT');
    const start = new Date();
    const { token } = await login(staff, start);
    expect(await actorFor(token, staff.businessId, new Date(start.getTime() + IDLE_TIMEOUT_MS + 1000))).toBeNull();
  });

  it('keeps a session alive while it is used, but never beyond 12 hours in total', async () => {
    const staff = await makeStaff('SUPPORT');
    const start = new Date();
    const { token } = await login(staff, start);
    // Use it every 20 minutes for 11 hours: the idle deadline keeps moving.
    for (let t = 20; t <= 11 * 60; t += 20) {
      expect(await actorFor(token, staff.businessId, new Date(start.getTime() + t * 60_000))).not.toBeNull();
    }
    expect(await actorFor(token, staff.businessId, new Date(start.getTime() + ABSOLUTE_TIMEOUT_MS + 60_000))).toBeNull();
  });

  it('logout ends the session at once', async () => {
    const staff = await makeStaff('SUPPORT');
    const { token } = await login(staff);
    const actor = (await actorFor(token, staff.businessId))!;
    await signOut(db, actor);
    expect(await actorFor(token, staff.businessId)).toBeNull();
  });

  it('a deactivated staff member loses access on the very next request', async () => {
    const staff = await makeStaff('SUPPORT');
    const { token } = await login(staff);
    expect(await actorFor(token, staff.businessId)).not.toBeNull();
    await db.staffUser.update({ where: { id: staff.id }, data: { isActive: false } });
    expect(await actorFor(token, staff.businessId)).toBeNull();
  });

  it('bumping tokenVersion revokes every session of that user', async () => {
    const staff = await makeStaff('SUPPORT');
    const a = await login(staff);
    const b = await login(staff);
    await revokeAllSessions(db, staff.id);
    expect(await actorFor(a.token, staff.businessId)).toBeNull();
    expect(await actorFor(b.token, staff.businessId)).toBeNull();
  });

  it('a session for another business is not valid here', async () => {
    const staff = await makeStaff('SUPPORT');
    const { token } = await login(staff);
    const other = await db.business.create({ data: { slug: unique('other'), name: 'Other' }, select: { id: true } });
    expect(await actorFor(token, other.id)).toBeNull();
  });
});

describe('MFA (TOTP) for Owner, Admin and Finance', () => {
  it('enrols, confirms with a code, and then requires a fresh code at each later sign-in', async () => {
    const staff = await makeStaff('OWNER');
    const first = await login(staff);
    expect(first.mfaRequired).toBe(true);
    expect(first.mfaEnrolled).toBe(false);
    const actor = (await actorFor(first.token, staff.businessId))!;

    const setup = await beginMfaEnrolment(db, actor);
    expect(setup.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    // The secret is stored encrypted, never in clear.
    const row = await db.staffUser.findUniqueOrThrow({ where: { id: staff.id } });
    expect(row.mfaSecretEnc).not.toContain(setup.secret);

    await confirmMfaEnrolment(db, actor, codeFor(setup.secret));
    expect((await db.staffUser.findUniqueOrThrow({ where: { id: staff.id } })).mfaEnabled).toBe(true);
    expect((await actorFor(first.token, staff.businessId))!.mfaVerified).toBe(true);

    // A new sign-in starts unverified; the step-up needs a code the server has not yet accepted.
    const second = await login(staff);
    const actor2 = (await actorFor(second.token, staff.businessId))!;
    expect(actor2.mfaVerified).toBe(false);
    await expect(verifyMfaCode(db, actor2, '000000')).rejects.toMatchObject({ status: 401 });
  });

  it('a code is accepted once: replaying the same code is refused', async () => {
    const staff = await makeStaff('ADMIN');
    const first = await login(staff);
    const actor = (await actorFor(first.token, staff.businessId))!;
    const setup = await beginMfaEnrolment(db, actor);
    const now = new Date();
    await confirmMfaEnrolment(db, actor, codeFor(setup.secret, now), now);

    const next = await login(staff);
    const nextActor = (await actorFor(next.token, staff.businessId))!;
    const code = codeFor(setup.secret, new Date(now.getTime() + 30_000));
    // Verified with the time of the next step, so it is strictly later than the enrolment step.
    await verifyMfaCode(db, nextActor, code, new Date(now.getTime() + 30_000));
    await expect(verifyMfaCode(db, nextActor, code, new Date(now.getTime() + 30_000))).rejects.toMatchObject({ status: 401 });
  });

  it('wrong codes count towards the lockout', async () => {
    const staff = await makeStaff('FINANCE');
    const first = await login(staff);
    const actor = (await actorFor(first.token, staff.businessId))!;
    const setup = await beginMfaEnrolment(db, actor);
    await confirmMfaEnrolment(db, actor, codeFor(setup.secret));

    const next = await login(staff);
    const nextActor = (await actorFor(next.token, staff.businessId))!;
    for (let i = 0; i < 5; i++) {
      await expect(verifyMfaCode(db, nextActor, '000001')).rejects.toMatchObject({ status: 401 });
    }
    await expect(login(staff)).rejects.toMatchObject({ status: 423 });
  });

  it('refuses to start a second enrolment once MFA is on', async () => {
    const staff = await makeStaff('OWNER');
    const first = await login(staff);
    const actor = (await actorFor(first.token, staff.businessId))!;
    const setup = await beginMfaEnrolment(db, actor);
    await confirmMfaEnrolment(db, actor, codeFor(setup.secret));
    await expect(beginMfaEnrolment(db, actor)).rejects.toMatchObject({ status: 409 });
  });

  it('writes an audit row for enrolment and for each verification', async () => {
    const staff = await makeStaff('OWNER');
    const first = await login(staff);
    const actor = (await actorFor(first.token, staff.businessId))!;
    const setup = await beginMfaEnrolment(db, actor);
    await confirmMfaEnrolment(db, actor, codeFor(setup.secret));
    const actions = (await db.auditLog.findMany({ where: { entityId: staff.id }, select: { action: true } })).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['MFA_ENROLMENT_STARTED', 'MFA_ENABLED', 'STAFF_SIGNED_IN']));
  });
});

describe('route guard', () => {
  async function requestWith(token: string | null): Promise<Request> {
    const headers: Record<string, string> = {};
    if (token) headers.cookie = `${staffSetCookie(token).split(';')[0]}`;
    return new Request('http://localhost/api/v1/admin/orders', { headers });
  }

  it('answers 401 without a session', async () => {
    await expect(requireStaff(db, await requestWith(null), { permission: 'orders.view' })).rejects.toMatchObject({ status: 401 });
  });

  it('reads the session from the cookie only', async () => {
    const token = 'abc.def_ghi';
    expect(staffTokenFrom(await requestWith(token))).toBe(token);
    expect(staffTokenFrom(new Request('http://x', { headers: { cookie: 'other=1' } }))).toBeNull();
  });

  it('asks an MFA-required role without MFA to enrol first, before checking the permission', async () => {
    const staff = await makeStaff('OWNER');
    const { token } = await login(staff);
    await expect(requireStaff(db, await requestWith(token), { permission: 'orders.view' })).rejects.toMatchObject({
      status: 403,
      code: 'mfa_enrolment_required',
    });
  });

  it('a non-MFA role passes the guard with the permission it holds, and is refused one it does not', async () => {
    const staff = await makeStaff('SUPPORT');
    const { token } = await login(staff);
    await expect(requireStaff(db, await requestWith(token), { permission: 'orders.view' })).resolves.toMatchObject({ role: 'SUPPORT' });
    await expect(requireStaff(db, await requestWith(token), { permission: 'staff.manage' })).rejects.toMatchObject({ status: 403, code: 'forbidden' });
  });
});
