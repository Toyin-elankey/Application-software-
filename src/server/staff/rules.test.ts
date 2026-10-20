import { describe, expect, it } from 'vitest';
import { AppError } from '@/server/http/problem';
import type { StaffRoleName } from '@/server/auth/permissions';
import { assertCanChangeStaff, assertCanCreateStaff, type StaffChange } from './rules';

// Staff management policy (FR-ADM-10, PRD §8). Each case names the rule it proves.

const OWNER_ID = 'owner-1';
const OTHER_ID = 'staff-2';

function outcome(fn: () => void): { status: number; code: string } | 'ok' {
  try {
    fn();
    return 'ok';
  } catch (error) {
    if (error instanceof AppError) return { status: error.status, code: error.code };
    throw error;
  }
}

function change(actorRole: StaffRoleName, target: { role: StaffRoleName; isActive?: boolean }, edit: StaffChange, actorId = OWNER_ID) {
  return outcome(() =>
    assertCanChangeStaff({
      actorId,
      actorRole,
      target: { id: OTHER_ID, role: target.role, isActive: target.isActive ?? true },
      change: edit,
    }),
  );
}

describe('creating staff', () => {
  it('lets an Owner create any role, including Owner', () => {
    for (const role of ['OWNER', 'ADMIN', 'MANAGER', 'FULFILMENT', 'SUPPORT', 'FINANCE', 'VIEWER'] as const) {
      expect(outcome(() => assertCanCreateStaff('OWNER', role))).toBe('ok');
    }
  });

  it('refuses an Admin any staff creation (staff.manage is Owner only)', () => {
    expect(outcome(() => assertCanCreateStaff('ADMIN', 'VIEWER'))).toEqual({ status: 403, code: 'forbidden' });
  });

  it('refuses every non-Owner role for creation', () => {
    for (const actor of ['ADMIN', 'MANAGER', 'FULFILMENT', 'SUPPORT', 'FINANCE', 'VIEWER'] as const) {
      expect(outcome(() => assertCanCreateStaff(actor, 'OWNER'))).toEqual({ status: 403, code: 'forbidden' });
    }
  });
});

describe('changing staff', () => {
  it('lets an Owner change an ordinary member to any role', () => {
    expect(change('OWNER', { role: 'SUPPORT' }, { role: 'MANAGER' })).toBe('ok');
    expect(change('OWNER', { role: 'SUPPORT' }, { role: 'ADMIN' })).toBe('ok');
  });

  it('lets an Owner promote a member to Owner', () => {
    expect(change('OWNER', { role: 'MANAGER' }, { role: 'OWNER' })).toBe('ok');
  });

  it('refuses an Owner changing their own account (role or activation)', () => {
    expect(change('OWNER', { role: 'OWNER' }, { isActive: false }, OTHER_ID)).toEqual({ status: 422, code: 'self_change_refused' });
    expect(change('OWNER', { role: 'OWNER' }, { role: 'ADMIN' }, OTHER_ID)).toEqual({ status: 422, code: 'self_change_refused' });
  });

  it('never deactivates an Owner account', () => {
    expect(change('OWNER', { role: 'OWNER' }, { isActive: false })).toEqual({ status: 422, code: 'owner_protected' });
  });

  it('never demotes an Owner account', () => {
    expect(change('OWNER', { role: 'OWNER' }, { role: 'ADMIN' })).toEqual({ status: 422, code: 'owner_protected' });
  });

  it('allows a request that keeps an Owner as Owner', () => {
    expect(change('OWNER', { role: 'OWNER' }, { role: 'OWNER' })).toBe('ok');
  });

  it('allows deactivating and reactivating an ordinary member', () => {
    expect(change('OWNER', { role: 'FINANCE' }, { isActive: false })).toBe('ok');
    expect(change('OWNER', { role: 'FINANCE', isActive: false }, { isActive: true })).toBe('ok');
  });

  it('refuses every change by a non-Owner (staff.manage is Owner only)', () => {
    expect(change('ADMIN', { role: 'SUPPORT' }, { role: 'MANAGER' })).toEqual({ status: 403, code: 'forbidden' });
    expect(change('MANAGER', { role: 'SUPPORT' }, { isActive: false })).toEqual({ status: 403, code: 'forbidden' });
  });

  it('refuses an Admin granting Owner, even though an Admin may grant other roles', () => {
    expect(change('ADMIN', { role: 'SUPPORT' }, { role: 'OWNER' })).toEqual({ status: 403, code: 'forbidden' });
  });

  it('does not treat an unchanged role as a grant', () => {
    expect(change('OWNER', { role: 'SUPPORT' }, { role: 'SUPPORT' })).toBe('ok');
  });
});
