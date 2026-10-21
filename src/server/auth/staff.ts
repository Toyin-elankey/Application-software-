import { createHash, randomBytes } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { getEnv } from '@/lib/env';
import { AppError } from '@/server/http/problem';
import { DUMMY_HASH, hashPassword, MIN_PASSWORD_LENGTH, passwordProblem, verifyPassword } from './password';
import { requiresMfa, type StaffRoleName } from './permissions';
import { base32Encode, decryptSecret, encryptSecret, matchTotp, newTotpSecret, otpauthUri } from './totp';

// Staff sessions and sign-in (A-15, 02 §8). Server-side sessions: the cookie holds an opaque token, the
// database holds its SHA-256. Sessions end on idle or absolute timeout, logout, deactivation, or a
// tokenVersion bump (revoke everything). Accounts lock after repeated failures, including failed MFA.

export const STAFF_COOKIE = 'staff_session';
export const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
export const ABSOLUTE_TIMEOUT_MS = 12 * 60 * 60 * 1000;
export const LOCK_THRESHOLD = 5;
export const LOCK_MS = 15 * 60 * 1000;

export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export type StaffActor = {
  staffUserId: string;
  email: string;
  role: StaffRoleName;
  businessId: string;
  sessionId: string;
  mfaEnabled: boolean;
  mfaVerified: boolean;
  /** True after a temporary password was issued and not yet changed. Only the password, session and logout routes accept it. */
  mustChangePassword: boolean;
  ip: string | null;
  userAgent: string | null;
};

export type SignInResult = {
  token: string;
  expiresAt: Date;
  mfaRequired: boolean;
  mfaEnrolled: boolean;
  role: StaffRoleName;
};

function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

function invalidCredentials(): AppError {
  return new AppError(401, 'invalid_credentials', 'Email or password is incorrect.');
}

function lockedOut(): AppError {
  return new AppError(423, 'account_locked', 'Too many failed attempts. Try again in 15 minutes.');
}

/** Counts a failed password or code check and locks the account at the threshold. */
async function recordFailure(db: PrismaClient, staffUserId: string, now: Date): Promise<void> {
  const user = await db.staffUser.update({
    where: { id: staffUserId },
    data: { failedLoginCount: { increment: 1 } },
    select: { failedLoginCount: true },
  });
  if (user.failedLoginCount >= LOCK_THRESHOLD) {
    await db.staffUser.update({
      where: { id: staffUserId },
      data: { failedLoginCount: 0, lockedUntil: new Date(now.getTime() + LOCK_MS) },
    });
  }
}

export async function signIn(
  db: PrismaClient,
  input: { businessId: string; email: string; password: string; ip: string | null; userAgent: string | null; now?: Date },
): Promise<SignInResult> {
  const now = input.now ?? new Date();
  const user = await db.staffUser.findUnique({
    where: { email: normaliseEmail(input.email) },
    include: { memberships: { where: { businessId: input.businessId }, select: { role: true } } },
  });

  if (!user) {
    // Same work as a real check, so timing does not reveal which emails exist.
    await verifyPassword(DUMMY_HASH, input.password);
    throw invalidCredentials();
  }
  if (user.lockedUntil && user.lockedUntil > now) throw lockedOut();

  const passwordOk = await verifyPassword(user.passwordHash, input.password);
  const membership = user.memberships[0];
  if (!passwordOk || !user.isActive || !membership) {
    if (user.isActive && membership) await recordFailure(db, user.id, now);
    throw invalidCredentials();
  }

  const token = newSessionToken();
  const expiresAt = new Date(now.getTime() + IDLE_TIMEOUT_MS);
  await db.$transaction(async (tx) => {
    await tx.staffUser.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: now },
    });
    await tx.staffSession.create({
      data: {
        staffUserId: user.id,
        tokenHash: hashSessionToken(token),
        tokenVersion: user.tokenVersion,
        lastSeenAt: now,
        idleExpiresAt: expiresAt,
        absoluteExpiresAt: new Date(now.getTime() + ABSOLUTE_TIMEOUT_MS),
        ip: input.ip,
        userAgent: input.userAgent,
      },
    });
    await audit(tx, input.businessId, user.id, 'STAFF_SIGNED_IN', 'StaffUser', user.id, null, input.ip, input.userAgent, now);
  });

  return {
    token,
    expiresAt,
    mfaRequired: requiresMfa(membership.role),
    mfaEnrolled: user.mfaEnabled,
    role: membership.role,
  };
}

/**
 * Looks up the session for a raw token and checks every rule. Returns null when the session is not
 * usable; the caller answers 401. Sliding idle timeout: each use moves the idle deadline forward.
 */
export async function resolveStaffActor(
  db: PrismaClient,
  businessId: string,
  token: string | null,
  meta: { ip: string | null; userAgent: string | null },
  now = new Date(),
): Promise<StaffActor | null> {
  if (!token) return null;
  const session = await db.staffSession.findUnique({
    where: { tokenHash: hashSessionToken(token) },
    include: {
      staffUser: {
        select: {
          id: true,
          email: true,
          isActive: true,
          tokenVersion: true,
          mfaEnabled: true,
          mustChangePassword: true,
          memberships: { where: { businessId }, select: { role: true } },
        },
      },
    },
  });
  if (!session || session.revokedAt) return null;
  if (session.absoluteExpiresAt <= now || session.idleExpiresAt <= now) return null;
  const user = session.staffUser;
  if (!user.isActive || user.tokenVersion !== session.tokenVersion) return null;
  const membership = user.memberships[0];
  if (!membership) return null;

  await db.staffSession.update({
    where: { id: session.id },
    data: {
      lastSeenAt: now,
      idleExpiresAt: new Date(Math.min(now.getTime() + IDLE_TIMEOUT_MS, session.absoluteExpiresAt.getTime())),
    },
  });

  return {
    staffUserId: user.id,
    email: user.email,
    role: membership.role,
    businessId,
    sessionId: session.id,
    mfaEnabled: user.mfaEnabled,
    mfaVerified: session.mfaVerifiedAt !== null,
    mustChangePassword: user.mustChangePassword,
    ip: meta.ip,
    userAgent: meta.userAgent,
  };
}

export async function signOut(db: PrismaClient, actor: StaffActor, now = new Date()): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.staffSession.update({ where: { id: actor.sessionId }, data: { revokedAt: now } });
    await audit(tx, actor.businessId, actor.staffUserId, 'STAFF_SIGNED_OUT', 'StaffUser', actor.staffUserId, null, actor.ip, actor.userAgent, now);
  });
}

/** Ends every session of a staff member at once (deactivation, password reset, role change). */
export async function revokeAllSessions(db: Prisma.TransactionClient | PrismaClient, staffUserId: string): Promise<void> {
  await db.staffUser.update({ where: { id: staffUserId }, data: { tokenVersion: { increment: 1 } } });
}

// ---- password change ----

/**
 * Changes the signed-in member's password. Needs the current password: a wrong one counts toward the
 * lockout, the same as a wrong sign-in. Clears `mustChangePassword`, ends the member's other sessions
 * (this one stays), and writes an audit row that does not contain either password.
 */
export async function changePassword(
  db: PrismaClient,
  actor: StaffActor,
  input: { currentPassword: string; newPassword: string },
  now = new Date(),
): Promise<{ sessionsRevoked: number }> {
  const problem = passwordProblem(input.newPassword);
  if (problem === 'too_short') {
    throw new AppError(422, 'weak_password', `Use at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (problem === 'too_long') throw new AppError(422, 'weak_password', 'Use at most 256 characters.');

  const user = await db.staffUser.findUniqueOrThrow({
    where: { id: actor.staffUserId },
    select: { passwordHash: true, lockedUntil: true },
  });
  if (user.lockedUntil && user.lockedUntil > now) throw lockedOut();

  if (!(await verifyPassword(user.passwordHash, input.currentPassword))) {
    await recordFailure(db, actor.staffUserId, now);
    throw new AppError(422, 'current_password_incorrect', 'The current password is not correct.');
  }
  if (await verifyPassword(user.passwordHash, input.newPassword)) {
    throw new AppError(422, 'password_unchanged', 'Choose a password that is different from the current one.');
  }

  const passwordHash = await hashPassword(input.newPassword);
  return db.$transaction(async (tx) => {
    // Conditional on the hash checked above: two changes at once cannot both succeed.
    const moved = await tx.staffUser.updateMany({
      where: { id: actor.staffUserId, passwordHash: user.passwordHash },
      data: { passwordHash, mustChangePassword: false, failedLoginCount: 0 },
    });
    if (moved.count !== 1) {
      throw new AppError(409, 'password_changed_elsewhere', 'The password was changed from another session. Sign in again.');
    }
    const ended = await tx.staffSession.updateMany({
      where: { staffUserId: actor.staffUserId, revokedAt: null, id: { not: actor.sessionId } },
      data: { revokedAt: now },
    });
    await audit(tx, actor.businessId, actor.staffUserId, 'STAFF_PASSWORD_CHANGED', 'StaffUser', actor.staffUserId, { sessionsRevoked: ended.count }, actor.ip, actor.userAgent, now);
    return { sessionsRevoked: ended.count };
  });
}

// ---- MFA (TOTP) ----

function requireMfaConfigured(): void {
  const env = getEnv();
  if (env.NODE_ENV === 'production' && !env.SESSION_ENCRYPTION_KEY) {
    throw new AppError(503, 'mfa_unconfigured', 'Multi-factor sign-in is not configured on this server.');
  }
}

/** Starts (or restarts) enrolment. The secret is returned once; only its encrypted form is stored. */
export async function beginMfaEnrolment(db: PrismaClient, actor: StaffActor, now = new Date()): Promise<{ secret: string; otpauthUri: string }> {
  requireMfaConfigured();
  const user = await db.staffUser.findUniqueOrThrow({ where: { id: actor.staffUserId }, select: { mfaEnabled: true } });
  if (user.mfaEnabled) throw new AppError(409, 'mfa_already_enabled', 'Two-factor sign-in is already set up for this account.');
  const secret = newTotpSecret();
  await db.$transaction(async (tx) => {
    await tx.staffUser.update({
      where: { id: actor.staffUserId },
      data: { mfaSecretEnc: encryptSecret(secret), mfaLastUsedStep: null },
    });
    await audit(tx, actor.businessId, actor.staffUserId, 'MFA_ENROLMENT_STARTED', 'StaffUser', actor.staffUserId, null, actor.ip, actor.userAgent, now);
  });
  return { secret: base32Encode(secret), otpauthUri: otpauthUri(secret, actor.email, 'Commerce') };
}

async function checkCode(db: PrismaClient, actor: StaffActor, code: string, now: Date, enrolling: boolean) {
  const user = await db.staffUser.findUniqueOrThrow({
    where: { id: actor.staffUserId },
    select: { mfaSecretEnc: true, mfaLastUsedStep: true },
  });
  if (!user.mfaSecretEnc) throw new AppError(409, 'mfa_not_started', 'Start two-factor setup first.');
  const secret = decryptSecret(user.mfaSecretEnc);
  // During enrolment no step has been used yet, so any valid step is accepted.
  const lastUsed = enrolling || user.mfaLastUsedStep === null ? null : Number(user.mfaLastUsedStep);
  const step = matchTotp(secret, code, now.getTime(), lastUsed);
  if (step === null) {
    await recordFailure(db, actor.staffUserId, now);
    throw new AppError(401, 'invalid_code', 'That code is not valid. Check the time on your device and try again.');
  }
  return step;
}

/** Confirms enrolment with a first code. Turns MFA on and verifies the current session. */
export async function confirmMfaEnrolment(db: PrismaClient, actor: StaffActor, code: string, now = new Date()): Promise<void> {
  requireMfaConfigured();
  const user = await db.staffUser.findUniqueOrThrow({ where: { id: actor.staffUserId }, select: { mfaEnabled: true } });
  if (user.mfaEnabled) throw new AppError(409, 'mfa_already_enabled', 'Two-factor sign-in is already set up for this account.');
  const step = await checkCode(db, actor, code, now, true);
  await db.$transaction(async (tx) => {
    await tx.staffUser.update({
      where: { id: actor.staffUserId },
      data: { mfaEnabled: true, mfaLastUsedStep: BigInt(step), failedLoginCount: 0 },
    });
    await tx.staffSession.update({ where: { id: actor.sessionId }, data: { mfaVerifiedAt: now } });
    await audit(tx, actor.businessId, actor.staffUserId, 'MFA_ENABLED', 'StaffUser', actor.staffUserId, null, actor.ip, actor.userAgent, now);
  });
}

/** Step-up for sign-in: checks a code and marks this session as MFA-verified. A code is accepted once. */
export async function verifyMfaCode(db: PrismaClient, actor: StaffActor, code: string, now = new Date()): Promise<void> {
  const user = await db.staffUser.findUniqueOrThrow({ where: { id: actor.staffUserId }, select: { mfaEnabled: true } });
  if (!user.mfaEnabled) throw new AppError(409, 'mfa_not_enabled', 'Set up two-factor sign-in first.');
  const step = await checkCode(db, actor, code, now, false);
  await db.$transaction(async (tx) => {
    // Conditional update: two concurrent submissions of one code cannot both succeed.
    const moved = await tx.staffUser.updateMany({
      where: {
        id: actor.staffUserId,
        OR: [{ mfaLastUsedStep: null }, { mfaLastUsedStep: { lt: BigInt(step) } }],
      },
      data: { mfaLastUsedStep: BigInt(step), failedLoginCount: 0 },
    });
    if (moved.count !== 1) throw new AppError(401, 'invalid_code', 'That code has already been used. Wait for the next one.');
    await tx.staffSession.update({ where: { id: actor.sessionId }, data: { mfaVerifiedAt: now } });
    await audit(tx, actor.businessId, actor.staffUserId, 'MFA_VERIFIED', 'StaffUser', actor.staffUserId, null, actor.ip, actor.userAgent, now);
  });
}

// ---- audit ----

export async function audit(
  tx: Prisma.TransactionClient | PrismaClient,
  businessId: string,
  actorId: string | null,
  action: string,
  entityType: string,
  entityId: string | null,
  changes: Prisma.InputJsonValue | null,
  ip: string | null,
  userAgent: string | null,
  now = new Date(),
): Promise<void> {
  await tx.auditLog.create({
    data: {
      businessId,
      actorType: 'STAFF',
      actorId,
      action,
      entityType,
      entityId,
      changes: changes ?? undefined,
      ip,
      userAgent: userAgent?.slice(0, 255) ?? null,
      createdAt: now,
    },
  });
}
