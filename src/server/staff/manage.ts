import { randomBytes } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { hashPassword } from '@/server/auth/password';
import { audit, type StaffActor } from '@/server/auth/staff';
import type { StaffRoleName } from '@/server/auth/permissions';
import { AppError } from '@/server/http/problem';
import { assertCanChangeStaff, assertCanCreateStaff, assertCanManageStaff, type StaffChange } from './rules';

// Staff management (FR-ADM-10, 02 §6.5 `/admin/staff`). Every write runs in one transaction, ends the
// affected sessions where needed, and writes an AuditLog row. Passwords and hashes never leave this file
// except as the one-time temporary password returned by createStaffMember.

export type StaffMemberView = {
  id: string;
  email: string;
  fullName: string;
  role: StaffRoleName;
  isActive: boolean;
  mfaEnabled: boolean;
  lastLoginAt: string | null;
  lockedUntil: string | null;
  createdAt: string;
};

const USER_SELECT = {
  id: true,
  email: true,
  fullName: true,
  isActive: true,
  mfaEnabled: true,
  lastLoginAt: true,
  lockedUntil: true,
  createdAt: true,
} as const;

type UserRow = {
  id: string;
  email: string;
  fullName: string;
  isActive: boolean;
  mfaEnabled: boolean;
  lastLoginAt: Date | null;
  lockedUntil: Date | null;
  createdAt: Date;
};

function toView(role: StaffRoleName, user: UserRow): StaffMemberView {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    role,
    isActive: user.isActive,
    mfaEnabled: user.mfaEnabled,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    lockedUntil: user.lockedUntil?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';
}

/** Ends every live session of a staff member and bumps tokenVersion, so the change takes effect on the next request. */
async function endAllSessions(tx: Prisma.TransactionClient, staffUserId: string, now: Date): Promise<void> {
  await tx.staffUser.update({ where: { id: staffUserId }, data: { tokenVersion: { increment: 1 } } });
  await tx.staffSession.updateMany({ where: { staffUserId, revokedAt: null }, data: { revokedAt: now } });
}

async function loadMember(tx: Prisma.TransactionClient | PrismaClient, businessId: string, staffUserId: string): Promise<StaffMemberView> {
  const membership = await tx.staffMembership.findFirst({
    where: { businessId, staffUserId },
    select: { role: true, staffUser: { select: USER_SELECT } },
  });
  if (!membership) throw new AppError(404, 'staff_not_found', 'Staff member not found.');
  return toView(membership.role, membership.staffUser);
}

export async function listStaff(db: PrismaClient, actor: StaffActor): Promise<StaffMemberView[]> {
  assertCanManageStaff(actor.role);
  const rows = await db.staffMembership.findMany({
    where: { businessId: actor.businessId },
    orderBy: { createdAt: 'asc' },
    select: { role: true, staffUser: { select: USER_SELECT } },
  });
  return rows.map((row) => toView(row.role, row.staffUser));
}

/**
 * Creates a staff account with a generated temporary password. The password is returned once, in this
 * response, and is never stored in plain text. There is no password-change endpoint yet, so the member
 * should be given the password in person and asked to change it when that endpoint exists.
 */
export async function createStaffMember(
  db: PrismaClient,
  actor: StaffActor,
  input: { email: string; fullName: string; role: StaffRoleName },
  now = new Date(),
): Promise<StaffMemberView & { temporaryPassword: string }> {
  assertCanCreateStaff(actor.role, input.role);
  const email = input.email.trim().toLowerCase();
  const temporaryPassword = randomBytes(18).toString('base64url');
  const passwordHash = await hashPassword(temporaryPassword);
  try {
    return await db.$transaction(async (tx) => {
      const user = await tx.staffUser.create({
        data: { email, fullName: input.fullName.trim(), passwordHash },
        select: USER_SELECT,
      });
      await tx.staffMembership.create({ data: { businessId: actor.businessId, staffUserId: user.id, role: input.role } });
      await audit(tx, actor.businessId, actor.staffUserId, 'STAFF_CREATED', 'StaffUser', user.id, { role: input.role }, actor.ip, actor.userAgent, now);
      return { ...toView(input.role, user), temporaryPassword };
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new AppError(409, 'email_in_use', 'A staff account with this email already exists.');
    throw error;
  }
}

/**
 * Changes a role and/or activation state. A role change or a deactivation ends the member's sessions at
 * once. Reactivation does not restore sessions; the member signs in again.
 */
export async function updateStaffMember(
  db: PrismaClient,
  actor: StaffActor,
  staffUserId: string,
  change: StaffChange,
  now = new Date(),
): Promise<StaffMemberView> {
  assertCanManageStaff(actor.role);
  return db.$transaction(async (tx) => {
    // Lock first, then read: two concurrent edits to the same person run one after the other, and the
    // second one sees the first one's result (its audit row's `from` is the role it actually replaced).
    await tx.$queryRaw`SELECT id FROM "StaffUser" WHERE id = ${staffUserId}::uuid FOR UPDATE`;
    const membership = await tx.staffMembership.findFirst({
      where: { businessId: actor.businessId, staffUserId },
      select: { role: true, staffUser: { select: { id: true, isActive: true } } },
    });
    if (!membership) throw new AppError(404, 'staff_not_found', 'Staff member not found.');

    assertCanChangeStaff({
      actorId: actor.staffUserId,
      actorRole: actor.role,
      target: { id: staffUserId, role: membership.role, isActive: membership.staffUser.isActive },
      change,
    });

    if (change.role !== undefined && change.role !== membership.role) {
      await tx.staffMembership.update({
        where: { businessId_staffUserId: { businessId: actor.businessId, staffUserId } },
        data: { role: change.role },
      });
      await endAllSessions(tx, staffUserId, now);
      await audit(tx, actor.businessId, actor.staffUserId, 'STAFF_ROLE_CHANGED', 'StaffUser', staffUserId, { from: membership.role, to: change.role }, actor.ip, actor.userAgent, now);
    }

    if (change.isActive !== undefined && change.isActive !== membership.staffUser.isActive) {
      if (change.isActive) {
        await tx.staffUser.update({ where: { id: staffUserId }, data: { isActive: true, failedLoginCount: 0 } });
        await audit(tx, actor.businessId, actor.staffUserId, 'STAFF_REACTIVATED', 'StaffUser', staffUserId, null, actor.ip, actor.userAgent, now);
      } else {
        await tx.staffUser.update({ where: { id: staffUserId }, data: { isActive: false } });
        await endAllSessions(tx, staffUserId, now);
        await audit(tx, actor.businessId, actor.staffUserId, 'STAFF_DEACTIVATED', 'StaffUser', staffUserId, null, actor.ip, actor.userAgent, now);
      }
    }

    return loadMember(tx, actor.businessId, staffUserId);
  });
}
