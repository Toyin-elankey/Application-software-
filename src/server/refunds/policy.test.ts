import { describe, expect, it } from 'vitest';
import { PaystackError } from '@/server/payments/paystack';
import { checkApprover, DEFAULT_REFUND_APPROVAL_THRESHOLD_MINOR, isDefinitiveRefusal, refundApprovalThresholdMinor, remainingRefundable } from './policy';

// Refund policy (06 §4.6, FR-PAY-07). Each block proves one rule.

describe('approval threshold', () => {
  it('defaults to ₦50,000 in kobo, and reads a configured value', () => {
    expect(DEFAULT_REFUND_APPROVAL_THRESHOLD_MINOR).toBe(5_000_000n);
    expect(refundApprovalThresholdMinor(undefined)).toBe(5_000_000n);
    expect(refundApprovalThresholdMinor('120000')).toBe(120_000n);
  });
});

describe('two-person approval', () => {
  const threshold = 5_000_000n;
  const cases: [string, { approverId: string; requesterId: string | null; amountMinor: bigint }, boolean][] = [
    ['requester approves a small refund: allowed (threshold only applies above it)', { approverId: 'a', requesterId: 'a', amountMinor: 4_999_999n }, true],
    ['requester approves exactly the threshold: allowed', { approverId: 'a', requesterId: 'a', amountMinor: 5_000_000n }, true],
    ['requester approves above the threshold: refused', { approverId: 'a', requesterId: 'a', amountMinor: 5_000_001n }, false],
    ['a different person approves above the threshold: allowed', { approverId: 'b', requesterId: 'a', amountMinor: 9_000_000n }, true],
    ['system-requested refund (no requester) above the threshold: any approver', { approverId: 'b', requesterId: null, amountMinor: 9_000_000n }, true],
  ];
  for (const [label, input, allowed] of cases) {
    it(label, () => {
      expect(checkApprover({ ...input, thresholdMinor: threshold }).ok).toBe(allowed);
    });
  }

  it('gives the refusal a stable reason', () => {
    expect(checkApprover({ approverId: 'a', requesterId: 'a', amountMinor: 9_000_000n, thresholdMinor: threshold })).toEqual({
      ok: false,
      reason: 'second_approver_required',
    });
  });
});

describe('refundable amount', () => {
  it('is what was paid, less pending, processing and succeeded refunds', () => {
    expect(remainingRefundable(10_000n, 0n)).toBe(10_000n);
    expect(remainingRefundable(10_000n, 4_000n)).toBe(6_000n);
    expect(remainingRefundable(10_000n, 10_000n)).toBe(0n);
  });

  it('never goes negative', () => {
    expect(remainingRefundable(10_000n, 12_000n)).toBe(0n);
  });
});

describe('provider refusal', () => {
  it('counts a 4xx as a definitive refusal', () => {
    expect(isDefinitiveRefusal(new PaystackError('x', 400, false))).toBe(true);
    expect(isDefinitiveRefusal(new PaystackError('x', 422, false))).toBe(true);
  });

  it('does not count timeouts, 5xx, 408 or 429 as refusals: the refund may still exist', () => {
    expect(isDefinitiveRefusal(new PaystackError('x', null, true))).toBe(false);
    expect(isDefinitiveRefusal(new PaystackError('x', 503, true))).toBe(false);
    expect(isDefinitiveRefusal(new PaystackError('x', 408, true))).toBe(false);
    expect(isDefinitiveRefusal(new PaystackError('x', 429, true))).toBe(false);
  });

  it('does not count an unknown error as a refusal', () => {
    expect(isDefinitiveRefusal(new Error('boom'))).toBe(false);
  });
});
