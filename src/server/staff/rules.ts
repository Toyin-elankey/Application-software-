import { AppError } from '@/server/http/problem';
import { canGrantRole, hasPermission, type StaffRoleName } from '@/server/auth/permissions';

// Staff management rules (FR-ADM-10, PRD §8). Pure functions so the policy is tested without a database.
// The service layer calls these before it writes anything.
//
// Rules:
// - Managing staff needs staff.manage (Owner only in the matrix).
// - Only an Owner can grant the Owner role (PRD §8).
// - An Owner account cannot be deactivated or demoted through this API. Nobody can change their own account.
//   (Decision recorded in docs/07: the spec says "Owner cannot be deactivated by others"; this is the
//   strictest reading, and it means the business always keeps its Owner.)

export type StaffChange = { role?: StaffRoleName; isActive?: boolean };

export type StaffTarget = { id: string; role: StaffRoleName; isActive: boolean };

function assertCanGrant(actorRole: StaffRoleName, role: StaffRoleName): void {
  if (role === 'OWNER' && !canGrantRole(actorRole, 'OWNER')) {
    throw new AppError(403, 'owner_role_required', 'Only an Owner can grant the Owner role.');
  }
  if (!canGrantRole(actorRole, role)) {
    throw new AppError(403, 'forbidden', 'Your role does not allow this change.');
  }
}

export function assertCanManageStaff(actorRole: StaffRoleName): void {
  if (!hasPermission(actorRole, 'staff.manage')) {
    throw new AppError(403, 'forbidden', 'Your role does not allow this action.');
  }
}

export function assertCanCreateStaff(actorRole: StaffRoleName, role: StaffRoleName): void {
  assertCanManageStaff(actorRole);
  assertCanGrant(actorRole, role);
}

export function assertCanChangeStaff(input: { actorId: string; actorRole: StaffRoleName; target: StaffTarget; change: StaffChange }): void {
  const { actorId, actorRole, target, change } = input;
  assertCanManageStaff(actorRole);
  if (target.id === actorId) {
    throw new AppError(422, 'self_change_refused', 'You cannot change your own account here.');
  }
  if (target.role === 'OWNER') {
    if (change.isActive === false) {
      throw new AppError(422, 'owner_protected', 'An Owner account cannot be deactivated.');
    }
    if (change.role !== undefined && change.role !== 'OWNER') {
      throw new AppError(422, 'owner_protected', 'An Owner account cannot be demoted.');
    }
  }
  if (change.role !== undefined && change.role !== target.role) {
    assertCanGrant(actorRole, change.role);
  }
}
