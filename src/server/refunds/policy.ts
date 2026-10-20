import { PaystackError } from '@/server/payments/paystack';

// Refund policy (06 §4.6, FR-PAY-07, A-10). Pure functions, tested without a database.

/** ₦50,000 in kobo. The default when REFUND_APPROVAL_THRESHOLD_MINOR is unset. A business decision (06 §4.6). */
export const DEFAULT_REFUND_APPROVAL_THRESHOLD_MINOR = 5_000_000n;

export function refundApprovalThresholdMinor(raw: string | undefined): bigint {
  return raw === undefined ? DEFAULT_REFUND_APPROVAL_THRESHOLD_MINOR : BigInt(raw);
}

/** Every refund needs approval by an Owner or Finance. Above the threshold, the approver must not be the requester. */
export function checkApprover(input: {
  approverId: string;
  requesterId: string | null;
  amountMinor: bigint;
  thresholdMinor: bigint;
}): { ok: true } | { ok: false; reason: 'second_approver_required' } {
  if (input.amountMinor > input.thresholdMinor && input.requesterId !== null && input.requesterId === input.approverId) {
    return { ok: false, reason: 'second_approver_required' };
  }
  return { ok: true };
}

/** Amount still refundable: what was paid, less refunds that are pending, in progress, or succeeded. */
export function remainingRefundable(paidMinor: bigint, committedMinor: bigint): bigint {
  const remaining = paidMinor - committedMinor;
  return remaining > 0n ? remaining : 0n;
}

/**
 * A provider answer that definitely did not create a refund: a 4xx response (the refund was refused),
 * not a timeout or a 5xx, after which the refund may still have been created.
 */
export function isDefinitiveRefusal(error: unknown): boolean {
  return (
    error instanceof PaystackError &&
    error.retryable === false &&
    error.httpStatus !== null &&
    error.httpStatus >= 400 &&
    error.httpStatus < 500
  );
}
