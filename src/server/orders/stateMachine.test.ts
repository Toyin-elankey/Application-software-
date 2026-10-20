import { describe, expect, it } from 'vitest';
import { ACTORS, canTransition, ORDER_STATUSES, TRANSITIONS, type Actor, type OrderStatus } from './stateMachine';

// The complete expected behaviour, written out independently of TRANSITIONS so a wrong table entry fails.
const ALLOWED: Record<string, Actor[]> = {
  'PENDING_PAYMENT>PAYMENT_CONFIRMED': ['SYSTEM'],
  'PENDING_PAYMENT>CANCELLED': ['SYSTEM', 'CUSTOMER'],
  'PAYMENT_CONFIRMED>CONFIRMED': ['STAFF'],
  'PAYMENT_CONFIRMED>REFUND_PENDING': ['STAFF', 'CUSTOMER'],
  'CONFIRMED>REFUND_PENDING': ['STAFF'],
  'CONFIRMED>PROCESSING': ['STAFF'],
  'PROCESSING>READY_FOR_DISPATCH': ['STAFF'],
  'READY_FOR_DISPATCH>DISPATCHED': ['STAFF'],
  'DISPATCHED>OUT_FOR_DELIVERY': ['STAFF', 'SYSTEM'],
  'OUT_FOR_DELIVERY>DELIVERED': ['STAFF', 'SYSTEM'],
  'OUT_FOR_DELIVERY>DISPATCHED': ['STAFF'],
  'DELIVERED>REFUND_PENDING': ['STAFF'],
  'CONFIRMED>CANCELLED': ['STAFF'],
  'PROCESSING>CANCELLED': ['STAFF'],
  'READY_FOR_DISPATCH>CANCELLED': ['STAFF'],
  'REFUND_PENDING>REFUNDED': ['SYSTEM'],
};

describe('order state machine', () => {
  it('covers all 11 statuses and 5 actors', () => {
    expect(ORDER_STATUSES).toHaveLength(11);
    expect(ACTORS).toHaveLength(5);
  });

  it('matches the expected table for every (from, to, actor) triple', () => {
    const mismatches: string[] = [];
    for (const from of ORDER_STATUSES) {
      for (const to of ORDER_STATUSES) {
        for (const actor of ACTORS) {
          const expected = (ALLOWED[`${from}>${to}`] ?? []).includes(actor);
          // Paid context: CANCELLED from a non-pending status is refused on top of the table.
          const actual = canTransition(from, to, actor, { paid: false }).ok;
          if (actual !== expected) mismatches.push(`${from} -> ${to} by ${actor}: expected ${expected}, got ${actual}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('has no duplicate rules and only lists statuses that exist', () => {
    const keys = TRANSITIONS.map((r) => `${r.from}>${r.to}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.sort()).toEqual(Object.keys(ALLOWED).sort());
  });

  it('never lets the AI assistant change an order', () => {
    for (const rule of TRANSITIONS) expect(rule.actors).not.toContain('AI');
  });

  it('refuses to cancel a paid order (must be refunded)', () => {
    const result = canTransition('CONFIRMED', 'CANCELLED', 'STAFF', { paid: true });
    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/refund/) });
  });

  it('allows cancelling an unpaid pending order', () => {
    expect(canTransition('PENDING_PAYMENT', 'CANCELLED', 'CUSTOMER', { paid: false })).toEqual({ ok: true });
  });

  it('explains why a transition is refused', () => {
    const result = canTransition('DELIVERED' as OrderStatus, 'CANCELLED', 'STAFF');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not allowed/);
  });
});
