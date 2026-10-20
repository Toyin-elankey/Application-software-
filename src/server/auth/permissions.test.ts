import { describe, expect, it } from 'vitest';
import { canGrantRole, hasPermission, PERMISSIONS, requiresMfa, ROLE_PERMISSIONS, STAFF_ROLES, type Permission, type StaffRoleName } from './permissions';

// Table-driven: every row of the PRD §8 matrix, for every role (docs/01 §8). Columns, in order:
// Owner, Admin, Manager, Fulfilment, Support, Finance, Viewer. ✔ = true, — = false.
const MATRIX: Record<Permission, [boolean, boolean, boolean, boolean, boolean, boolean, boolean]> = {
  'overview.view': [true, true, true, false, false, true, true],
  'catalogue.write': [true, true, true, false, false, false, false],
  'catalogue.publish': [true, true, true, false, false, false, false],
  'inventory.adjust': [true, true, true, true, false, false, false],
  'orders.view': [true, true, true, true, true, true, true],
  'orders.fulfil': [true, true, true, true, false, false, false],
  'orders.cancel_unpaid': [true, true, true, false, true, false, false],
  'refund.request': [true, true, false, false, false, true, false],
  'refund.approve': [true, false, false, false, false, true, false],
  'customers.view_masked': [true, true, true, false, true, false, true],
  'customers.reveal_pii': [true, true, false, false, true, false, false],
  'payments.view': [true, true, true, false, false, true, true],
  'whatsapp.inbox': [true, true, true, false, true, false, false],
  'settings.manage': [true, true, false, false, false, false, false],
  'staff.manage': [true, false, false, false, false, false, false],
  'audit.view': [true, true, false, false, false, false, true],
};

describe('PRD §8 permission matrix', () => {
  it('lists every matrix row exactly once', () => {
    expect([...PERMISSIONS].sort()).toEqual(Object.keys(MATRIX).sort());
  });

  for (const permission of PERMISSIONS) {
    it(`${permission} matches the matrix for every role`, () => {
      STAFF_ROLES.forEach((role, index) => {
        expect(hasPermission(role, permission), `${role} / ${permission}`).toBe(MATRIX[permission][index]);
      });
    });
  }

  it('gives no role a permission outside the table', () => {
    const granted = Object.values(ROLE_PERMISSIONS).flat().length;
    const expected = Object.values(MATRIX).flat().filter(Boolean).length;
    expect(granted).toBe(expected);
  });
});

describe('MFA and role grants', () => {
  it('requires MFA for Owner, Admin and Finance only (PRD §4.1)', () => {
    const required = STAFF_ROLES.filter((role: StaffRoleName) => requiresMfa(role)).sort();
    expect(required).toEqual(['ADMIN', 'FINANCE', 'OWNER']);
  });

  it('only Owner can grant Owner; Admin cannot', () => {
    expect(canGrantRole('OWNER', 'OWNER')).toBe(true);
    expect(canGrantRole('ADMIN', 'OWNER')).toBe(false);
    expect(canGrantRole('MANAGER', 'OWNER')).toBe(false);
  });

  it('Owner and Admin can grant the other roles; Manager cannot grant anything', () => {
    expect(canGrantRole('ADMIN', 'MANAGER')).toBe(true);
    expect(canGrantRole('OWNER', 'VIEWER')).toBe(true);
    expect(canGrantRole('MANAGER', 'VIEWER')).toBe(false);
  });
});
