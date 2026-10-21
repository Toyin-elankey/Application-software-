import { ConsentPurpose } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { ORDER_STATUSES } from '@/server/orders/stateMachine';
import { AppError } from '@/server/http/problem';
import { requireSignIn } from './account';
import { CONSENT_PURPOSE_VALUES, CancelBodySchema, ConsentBodySchema } from './schema';
import { CUSTOMER_CANCELLABLE_STATUSES, customerMayCancel, notificationTypesFor } from './consent';
import type { CustomerAccess } from './sessions';

describe('customer may cancel (FR-ORD-06)', () => {
  it('allows only unpaid and paid-but-not-yet-confirmed orders', () => {
    expect(CUSTOMER_CANCELLABLE_STATUSES).toEqual(['PENDING_PAYMENT', 'PAYMENT_CONFIRMED']);
    for (const status of ORDER_STATUSES) {
      expect(customerMayCancel(status)).toBe(status === 'PENDING_PAYMENT' || status === 'PAYMENT_CONFIRMED');
    }
  });
});

describe('consent purposes', () => {
  it('lists exactly the purposes in the Prisma enum', () => {
    expect([...CONSENT_PURPOSE_VALUES].sort()).toEqual(Object.keys(ConsentPurpose).sort());
  });

  it('withdrawing order updates cancels every order-update notification type, and nothing else', () => {
    expect([...notificationTypesFor('ORDER_UPDATES_WHATSAPP')].sort()).toEqual(
      ['DELIVERY_UPDATE', 'ORDER_CONFIRMED', 'ORDER_STATUS_UPDATE', 'PAYMENT_RECEIVED', 'REFUND_UPDATE'],
    );
    expect(notificationTypesFor('MARKETING_WHATSAPP')).toEqual([]);
    expect(notificationTypesFor('AI_ASSISTANT_PROCESSING')).toEqual([]);
    expect(notificationTypesFor('TERMS_AND_PRIVACY')).toEqual([]);
  });

  it('accepts a known purpose and a boolean, and rejects anything else', () => {
    expect(ConsentBodySchema.parse({ purpose: 'MARKETING_WHATSAPP', granted: false })).toEqual({ purpose: 'MARKETING_WHATSAPP', granted: false });
    expect(ConsentBodySchema.safeParse({ purpose: 'SOMETHING_ELSE', granted: true }).success).toBe(false);
    expect(ConsentBodySchema.safeParse({ purpose: 'MARKETING_WHATSAPP', granted: 'yes' }).success).toBe(false);
    expect(ConsentBodySchema.safeParse({ purpose: 'MARKETING_WHATSAPP', granted: true, source: 'x' }).success).toBe(false);
  });
});

describe('cancel body', () => {
  it('takes exactly six digits and no other fields', () => {
    expect(CancelBodySchema.parse({ code: '123456' })).toEqual({ code: '123456' });
    expect(CancelBodySchema.safeParse({ code: '12345' }).success).toBe(false);
    expect(CancelBodySchema.safeParse({ code: '123456', orderNumber: 'ORD-260001' }).success).toBe(false);
  });
});

describe('requireSignIn', () => {
  const base = { customerId: 'c1', sessionId: 's1' };
  const lookup: CustomerAccess = { ...base, scopeOrderId: 'o1', kind: 'order-lookup' };
  const signIn: CustomerAccess = { ...base, scopeOrderId: null, kind: 'sign-in' };

  it('refuses a lookup session, which covers one order only', () => {
    expect(() => requireSignIn([lookup])).toThrow(AppError);
    expect(() => requireSignIn([])).toThrow(AppError);
    try {
      requireSignIn([lookup]);
    } catch (error) {
      expect((error as AppError).status).toBe(401);
    }
  });

  it('accepts the sign-in session even alongside a lookup session', () => {
    expect(requireSignIn([lookup, signIn])).toBe(signIn);
  });
});
