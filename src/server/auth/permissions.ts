// Central permission policy (PRD §8). The server checks these; the UI only hides controls.
// Keep this table in step with the matrix in docs/01 §8: tests/db and permissions.test.ts check every row.

export const STAFF_ROLES = ['OWNER', 'ADMIN', 'MANAGER', 'FULFILMENT', 'SUPPORT', 'FINANCE', 'VIEWER'] as const;
export type StaffRoleName = (typeof STAFF_ROLES)[number];

export const PERMISSIONS = [
  'overview.view',
  'catalogue.write',
  'catalogue.publish',
  'inventory.adjust',
  'orders.view',
  'orders.fulfil',
  'orders.cancel_unpaid',
  'refund.request',
  'refund.approve',
  'customers.view_masked',
  'customers.reveal_pii',
  'payments.view',
  'whatsapp.inbox',
  'settings.manage',
  'staff.manage',
  'audit.view',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ALL: readonly StaffRoleName[] = STAFF_ROLES;

export const ROLE_PERMISSIONS: Record<Permission, readonly StaffRoleName[]> = {
  'overview.view': ['OWNER', 'ADMIN', 'MANAGER', 'FINANCE', 'VIEWER'],
  'catalogue.write': ['OWNER', 'ADMIN', 'MANAGER'],
  'catalogue.publish': ['OWNER', 'ADMIN', 'MANAGER'],
  'inventory.adjust': ['OWNER', 'ADMIN', 'MANAGER', 'FULFILMENT'],
  'orders.view': ALL,
  'orders.fulfil': ['OWNER', 'ADMIN', 'MANAGER', 'FULFILMENT'],
  'orders.cancel_unpaid': ['OWNER', 'ADMIN', 'MANAGER', 'SUPPORT'],
  'refund.request': ['OWNER', 'ADMIN', 'FINANCE'],
  'refund.approve': ['OWNER', 'FINANCE'],
  'customers.view_masked': ['OWNER', 'ADMIN', 'MANAGER', 'SUPPORT', 'VIEWER'],
  'customers.reveal_pii': ['OWNER', 'ADMIN', 'SUPPORT'],
  'payments.view': ['OWNER', 'ADMIN', 'MANAGER', 'FINANCE', 'VIEWER'],
  'whatsapp.inbox': ['OWNER', 'ADMIN', 'MANAGER', 'SUPPORT'],
  'settings.manage': ['OWNER', 'ADMIN'],
  'staff.manage': ['OWNER'],
  'audit.view': ['OWNER', 'ADMIN', 'VIEWER'],
};

/** Roles that must complete TOTP MFA before any permission is granted (PRD §4.1, A-15). */
export const MFA_REQUIRED_ROLES: readonly StaffRoleName[] = ['OWNER', 'ADMIN', 'FINANCE'];

export function hasPermission(role: StaffRoleName, permission: Permission): boolean {
  return ROLE_PERMISSIONS[permission].includes(role);
}

export function requiresMfa(role: StaffRoleName): boolean {
  return MFA_REQUIRED_ROLES.includes(role);
}

/** PRD §8: only Owner can grant Owner; Admin cannot grant Owner. Every grant is audited by the caller. */
export function canGrantRole(actor: StaffRoleName, target: StaffRoleName): boolean {
  if (target === 'OWNER') return actor === 'OWNER';
  return actor === 'OWNER' || actor === 'ADMIN';
}
