import type { Prisma, PrismaClient } from '@prisma/client';
import { logger } from '@/lib/logger';
import { hasPermission, type Permission } from '@/server/auth/permissions';
import type { StaffActor } from '@/server/auth/staff';
import { claimKey, hashIdempotencyKey, releaseKey, requestFingerprint } from '@/server/idempotency/keys';
import { AppError } from '@/server/http/problem';
import type { JobHandler } from '@/server/jobs/runner';
import type { PaymentProvider, RefundOutcome } from '@/server/payments/provider';
import type { TenantScope } from '@/server/tenant';
import { checkApprover, isDefinitiveRefusal, remainingRefundable } from './policy';

// Refund workflow (06 §4.6, FR-PAY-07, 02 §6.5). Money moves only through the states below:
//
//   request (PENDING) -> approve (PENDING, approved) -> execute (PROCESSING, provider called once)
//     -> provider status or webhook -> SUCCEEDED | FAILED
//
// Locks always go Payment, then Refund, then Order, so a refund never deadlocks with a payment
// confirmation or a cancellation. A refund is executed only from PENDING with an approval, and the
// claim is a conditional update, so a double click or a retry never calls the provider twice.

export const REFUND_SCOPE = 'refunds.request';
/** A refund still PROCESSING this long after its last change is checked with the provider. */
export const REFUND_SWEEP_AFTER_MS = 10 * 60_000;

const COMMITTED = ['PENDING', 'PROCESSING', 'SUCCEEDED'] as const;
const FINAL = new Set(['SUCCEEDED', 'FAILED']);

type StoredStatus = 'PENDING' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED';

const REFUND_SELECT = {
  id: true,
  orderId: true,
  paymentId: true,
  status: true,
  amountMinor: true,
  reason: true,
  providerRefundId: true,
  requestedByStaffId: true,
  approvedByStaffId: true,
  failureReason: true,
  createdAt: true,
  processedAt: true,
} as const;

type RefundRow = {
  id: string;
  orderId: string;
  paymentId: string;
  status: StoredStatus;
  amountMinor: bigint;
  reason: string;
  providerRefundId: string | null;
  requestedByStaffId: string | null;
  approvedByStaffId: string | null;
  failureReason: string | null;
  createdAt: Date;
  processedAt: Date | null;
};

export type RefundView = {
  id: string;
  orderId: string;
  paymentId: string;
  status: StoredStatus;
  amountMinor: string;
  reason: string;
  providerRefundId: string | null;
  requestedByStaffId: string | null;
  approvedByStaffId: string | null;
  failureReason: string | null;
  createdAt: string;
  processedAt: string | null;
};

export function refundView(row: RefundRow): RefundView {
  return {
    id: row.id,
    orderId: row.orderId,
    paymentId: row.paymentId,
    status: row.status,
    amountMinor: row.amountMinor.toString(),
    reason: row.reason,
    providerRefundId: row.providerRefundId,
    requestedByStaffId: row.requestedByStaffId,
    approvedByStaffId: row.approvedByStaffId,
    failureReason: row.failureReason,
    createdAt: row.createdAt.toISOString(),
    processedAt: row.processedAt?.toISOString() ?? null,
  };
}

function requirePermission(actor: StaffActor, permission: Permission): void {
  if (!hasPermission(actor.role, permission)) throw new AppError(403, 'forbidden', 'Your role does not allow this action.');
}

/** Audit row for a refund change. Staff actions are STAFF; provider and job changes are SYSTEM. */
async function writeAudit(
  tx: Prisma.TransactionClient,
  businessId: string,
  actor: StaffActor | null,
  action: string,
  entityType: 'Refund' | 'Order',
  entityId: string,
  changes: Prisma.InputJsonValue,
  now: Date,
): Promise<void> {
  await tx.auditLog.create({
    data: {
      businessId,
      actorType: actor ? 'STAFF' : 'SYSTEM',
      actorId: actor?.staffUserId ?? null,
      action,
      entityType,
      entityId,
      changes,
      ip: actor?.ip ?? null,
      userAgent: actor?.userAgent ?? null,
      createdAt: now,
    },
  });
}

/** Locks Payment, then Refund, then returns a fresh copy of the refund. */
async function lockRefund(tx: Prisma.TransactionClient, businessId: string, refundId: string): Promise<RefundRow> {
  const found = await tx.refund.findFirst({ where: { id: refundId, businessId }, select: { paymentId: true } });
  if (!found) throw new AppError(404, 'refund_not_found', 'Refund not found.');
  await tx.$queryRaw`SELECT id FROM "Payment" WHERE id = ${found.paymentId}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM "Refund" WHERE id = ${refundId}::uuid FOR UPDATE`;
  return tx.refund.findUniqueOrThrow({ where: { id: refundId }, select: REFUND_SELECT }) as Promise<RefundRow>;
}

/**
 * When successful refunds add up to the amount paid, and the order is waiting for a refund, the order
 * moves REFUND_PENDING -> REFUNDED. A partial refund leaves it as it is (06 §4.6, step 4).
 */
async function completeOrderIfFullyRefunded(
  tx: Prisma.TransactionClient,
  businessId: string,
  paymentId: string,
  orderId: string,
  now: Date,
): Promise<boolean> {
  const payment = await tx.payment.findUniqueOrThrow({ where: { id: paymentId }, select: { amountMinor: true } });
  const done = await tx.refund.aggregate({ where: { paymentId, status: 'SUCCEEDED' }, _sum: { amountMinor: true } });
  if ((done._sum.amountMinor ?? 0n) < payment.amountMinor) return false;

  const [order] = await tx.$queryRaw<{ status: string }[]>`
    SELECT status::text AS status FROM "Order"
    WHERE id = ${orderId}::uuid AND "businessId" = ${businessId}::uuid FOR UPDATE`;
  if (!order || order.status !== 'REFUND_PENDING') return false;

  await tx.order.update({ where: { id: orderId }, data: { status: 'REFUNDED', version: { increment: 1 } } });
  await tx.orderStatusEvent.create({
    data: { orderId, fromStatus: 'REFUND_PENDING', toStatus: 'REFUNDED', actorType: 'SYSTEM', reason: 'refund_completed' },
  });
  await writeAudit(tx, businessId, null, 'ORDER_STATUS_CHANGED', 'Order', orderId, { from: 'REFUND_PENDING', to: 'REFUNDED', reason: 'refund_completed' }, now);
  return true;
}

type Outcome = {
  status: StoredStatus;
  providerRefundId?: string | null;
  failureReason?: string | null;
};

/** Writes a refund's state in one locked transaction. A final state is never changed again. */
async function applyOutcome(
  db: PrismaClient,
  businessId: string,
  refundId: string,
  outcome: Outcome,
  action: string,
  actor: StaffActor | null,
  now: Date,
): Promise<'updated' | 'unchanged'> {
  return db.$transaction(
    async (tx) => {
      const refund = await lockRefund(tx, businessId, refundId);
      if (FINAL.has(refund.status)) return 'unchanged';
      await tx.refund.update({
        where: { id: refundId },
        data: {
          status: outcome.status,
          providerRefundId: outcome.providerRefundId ?? refund.providerRefundId,
          failureReason: outcome.failureReason !== undefined ? outcome.failureReason : refund.failureReason,
          processedAt: FINAL.has(outcome.status) ? now : refund.processedAt,
        },
      });
      await writeAudit(
        tx,
        businessId,
        actor,
        action,
        'Refund',
        refundId,
        { from: refund.status, to: outcome.status, failureReason: outcome.failureReason ?? null },
        now,
      );
      if (outcome.status === 'SUCCEEDED') await completeOrderIfFullyRefunded(tx, businessId, refund.paymentId, refund.orderId, now);
      return 'updated';
    },
    { timeout: 15_000, maxWait: 10_000 },
  );
}

// ---------- request ----------

export type RefundResponse = { status: number; body: unknown };

/**
 * Staff request a refund for an order that is REFUND_PENDING. The amount must fit in what is still
 * refundable. Idempotency-Key: the same key and body return the original response; a different body
 * with the same key is refused (422).
 */
export async function requestRefund(
  db: PrismaClient,
  actor: StaffActor,
  input: { orderId: string; amountMinor: bigint; reason: string; idempotencyKey: string },
  now = new Date(),
): Promise<RefundResponse> {
  requirePermission(actor, 'refunds.request');
  if (input.amountMinor <= 0n) throw new AppError(422, 'invalid_amount', 'The refund amount must be more than zero.');
  const scope: TenantScope = { businessId: actor.businessId };
  const claim = await claimKey(db, scope, {
    scope: REFUND_SCOPE,
    keyHash: hashIdempotencyKey(input.idempotencyKey),
    requestHash: requestFingerprint({ orderId: input.orderId, amountMinor: input.amountMinor.toString(), reason: input.reason }),
    now,
  });
  if (claim.kind === 'replay') return { status: claim.responseStatus, body: claim.responseBody };

  try {
    return await db.$transaction(
      async (tx) => {
        const order = await tx.order.findFirst({ where: { id: input.orderId, businessId: actor.businessId }, select: { id: true } });
        if (!order) throw new AppError(404, 'order_not_found', 'Order not found.');
        const payment = await tx.payment.findFirst({
          where: { orderId: input.orderId, businessId: actor.businessId, status: 'SUCCEEDED' },
          select: { id: true },
        });
        if (!payment) throw new AppError(422, 'no_payment_to_refund', 'This order has no verified payment to refund.');

        await tx.$queryRaw`SELECT id FROM "Payment" WHERE id = ${payment.id}::uuid FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${input.orderId}::uuid AND "businessId" = ${actor.businessId}::uuid FOR UPDATE`;
        const current = await tx.order.findUniqueOrThrow({ where: { id: input.orderId }, select: { status: true } });
        if (current.status !== 'REFUND_PENDING') {
          throw new AppError(422, 'order_not_refund_pending', 'Refunds can be requested once the order is waiting for a refund.');
        }

        const paid = await tx.payment.findUniqueOrThrow({ where: { id: payment.id }, select: { amountMinor: true } });
        const committed = await tx.refund.aggregate({
          where: { paymentId: payment.id, status: { in: [...COMMITTED] } },
          _sum: { amountMinor: true },
        });
        const remaining = remainingRefundable(paid.amountMinor, committed._sum.amountMinor ?? 0n);
        if (input.amountMinor > remaining) {
          throw new AppError(422, 'refund_exceeds_paid', 'That amount is more than the order has left to refund.', {
            remainingMinor: remaining.toString(),
          });
        }

        const created = await tx.refund.create({
          data: {
            businessId: actor.businessId,
            paymentId: payment.id,
            orderId: input.orderId,
            amountMinor: input.amountMinor,
            reason: input.reason,
            status: 'PENDING',
            requestedByStaffId: actor.staffUserId,
          },
          select: REFUND_SELECT,
        });
        const body = refundView(created as RefundRow);
        await tx.idempotencyKey.update({
          where: { id: claim.keyId },
          data: { state: 'COMPLETED', responseStatus: 201, responseBody: body as unknown as Prisma.InputJsonValue },
        });
        await writeAudit(tx, actor.businessId, actor, 'REFUND_REQUESTED', 'Refund', created.id, { amountMinor: body.amountMinor, reason: input.reason, orderId: input.orderId }, now);
        return { status: 201, body };
      },
      { timeout: 15_000, maxWait: 10_000 },
    );
  } catch (error) {
    // The business step did not commit, so the client may retry with the same key.
    await releaseKey(db, claim.keyId);
    throw error;
  }
}

// ---------- approve ----------

/** A second person approves (Owner or Finance). Above the threshold the approver must not be the requester. */
export async function approveRefund(
  db: PrismaClient,
  actor: StaffActor,
  refundId: string,
  options: { thresholdMinor: bigint },
  now = new Date(),
): Promise<RefundView> {
  requirePermission(actor, 'refunds.approve');
  return db.$transaction(
    async (tx) => {
      const refund = await lockRefund(tx, actor.businessId, refundId);
      if (refund.status !== 'PENDING') throw new AppError(409, 'refund_not_pending', 'This refund is no longer waiting for approval.');
      if (refund.approvedByStaffId) throw new AppError(409, 'already_approved', 'This refund is already approved.');
      const check = checkApprover({
        approverId: actor.staffUserId,
        requesterId: refund.requestedByStaffId,
        amountMinor: refund.amountMinor,
        thresholdMinor: options.thresholdMinor,
      });
      if (!check.ok) {
        throw new AppError(403, 'second_approver_required', 'A refund this large must be approved by a different person from the one who requested it.');
      }
      const updated = await tx.refund.update({
        where: { id: refundId },
        data: { approvedByStaffId: actor.staffUserId },
        select: REFUND_SELECT,
      });
      await writeAudit(tx, actor.businessId, actor, 'REFUND_APPROVED', 'Refund', refundId, { amountMinor: refund.amountMinor.toString() }, now);
      return refundView(updated as RefundRow);
    },
    { timeout: 15_000, maxWait: 10_000 },
  );
}

// ---------- execute ----------

/**
 * Sends an approved refund to the provider, once. The claim (PENDING -> PROCESSING) is taken before the
 * call, so a second execute is refused without calling the provider. A definitive refusal (4xx) marks
 * the refund FAILED. An unknown outcome (timeout, 5xx) leaves it PROCESSING and answers 502: it is not
 * retried automatically, because the provider may already have created it.
 */
export async function executeRefund(
  db: PrismaClient,
  provider: PaymentProvider,
  actor: StaffActor,
  refundId: string,
  now = new Date(),
): Promise<RefundView> {
  requirePermission(actor, 'refunds.approve');
  const claimed = await db.$transaction(
    async (tx) => {
      const refund = await lockRefund(tx, actor.businessId, refundId);
      if (refund.status !== 'PENDING') throw new AppError(409, 'refund_already_executed', 'This refund has already been sent to the provider.');
      if (!refund.approvedByStaffId) throw new AppError(422, 'refund_not_approved', 'Approve this refund before sending it.');
      const payment = await tx.payment.findUniqueOrThrow({ where: { id: refund.paymentId }, select: { providerTransactionId: true } });
      if (!payment.providerTransactionId) throw new AppError(422, 'refund_not_approved', 'The payment has no provider transaction to refund.');
      await tx.refund.update({ where: { id: refundId }, data: { status: 'PROCESSING' } });
      await writeAudit(tx, actor.businessId, actor, 'REFUND_EXECUTION_STARTED', 'Refund', refundId, { amountMinor: refund.amountMinor.toString() }, now);
      return { amountMinor: refund.amountMinor, providerTransactionId: payment.providerTransactionId };
    },
    { timeout: 15_000, maxWait: 10_000 },
  );

  let answer;
  try {
    answer = await provider.refund({ providerTransactionId: claimed.providerTransactionId, amountMinor: claimed.amountMinor, reference: refundId });
  } catch (error) {
    if (isDefinitiveRefusal(error)) {
      await applyOutcome(db, actor.businessId, refundId, { status: 'FAILED', failureReason: 'provider_refused' }, 'REFUND_STATUS_CHANGED', actor, now);
      return loadRefund(db, actor.businessId, refundId);
    }
    logger.error({ msg: 'refund outcome unknown', refundId });
    await applyOutcome(db, actor.businessId, refundId, { status: 'PROCESSING', failureReason: 'provider_outcome_unknown' }, 'REFUND_EXECUTION_UNCERTAIN', actor, now);
    throw new AppError(
      502,
      'refund_uncertain',
      'The provider did not confirm the refund. Check the provider dashboard before doing anything else. This refund will not be sent again.',
      { refundId },
    );
  }

  const stored: StoredStatus = answer.status === 'PENDING' ? 'PROCESSING' : answer.status;
  await applyOutcome(
    db,
    actor.businessId,
    refundId,
    {
      status: stored,
      providerRefundId: answer.providerRefundId,
      failureReason: stored === 'FAILED' ? 'provider_failed' : null,
    },
    'REFUND_STATUS_CHANGED',
    actor,
    now,
  );
  return loadRefund(db, actor.businessId, refundId);
}

async function loadRefund(db: PrismaClient, businessId: string, refundId: string): Promise<RefundView> {
  const row = await db.refund.findFirst({ where: { id: refundId, businessId }, select: REFUND_SELECT });
  if (!row) throw new AppError(404, 'refund_not_found', 'Refund not found.');
  return refundView(row as RefundRow);
}

// ---------- provider status (webhook job, sweep) ----------

/**
 * Applies a status the provider reported (after a getRefund call). Returns 'not_recorded' when the
 * refund does not exist yet: a webhook can arrive before the execute response is stored, and the job
 * then retries.
 */
export async function applyProviderStatus(
  db: PrismaClient,
  providerRefundId: string,
  status: RefundOutcome,
  now = new Date(),
): Promise<'updated' | 'unchanged' | 'not_recorded'> {
  const row = await db.refund.findUnique({ where: { providerRefundId }, select: { id: true, businessId: true } });
  if (!row) return 'not_recorded';
  const stored: StoredStatus = status === 'PENDING' ? 'PROCESSING' : status;
  return applyOutcome(
    db,
    row.businessId,
    row.id,
    { status: stored, failureReason: stored === 'FAILED' ? 'provider_failed' : undefined },
    'REFUND_STATUS_CHANGED',
    null,
    now,
  );
}

/** refund.reconcile job: asks the provider for the refund's state, then applies it. */
export function refundReconcileHandler(db: PrismaClient, provider: PaymentProvider): JobHandler {
  return async (job) => {
    const providerRefundId = typeof job.payload.providerRefundId === 'string' ? job.payload.providerRefundId : '';
    if (!providerRefundId) return;
    const remote = await provider.getRefund(providerRefundId);
    const result = await applyProviderStatus(db, providerRefundId, remote.status);
    if (result === 'not_recorded') throw new Error('refund is not recorded yet; the job will retry');
    const webhookEventId = typeof job.payload.webhookEventId === 'string' ? job.payload.webhookEventId : null;
    if (webhookEventId) {
      await db.webhookEvent.updateMany({
        where: { id: webhookEventId },
        data: { status: 'PROCESSED', processedAt: new Date(), attempts: { increment: 1 } },
      });
    }
  };
}

/** Checks refunds that have been PROCESSING for a while, in case the webhook never came. */
export async function sweepStaleRefunds(
  db: PrismaClient,
  provider: PaymentProvider,
  options: { now?: Date; limit?: number } = {},
): Promise<{ checked: number; updated: number; deferred: number }> {
  const now = options.now ?? new Date();
  const stale = await db.refund.findMany({
    where: { status: 'PROCESSING', providerRefundId: { not: null }, updatedAt: { lte: new Date(now.getTime() - REFUND_SWEEP_AFTER_MS) } },
    select: { providerRefundId: true },
    orderBy: { updatedAt: 'asc' },
    take: options.limit ?? 25,
  });
  const summary = { checked: stale.length, updated: 0, deferred: 0 };
  for (const row of stale) {
    if (!row.providerRefundId) continue;
    try {
      const remote = await provider.getRefund(row.providerRefundId);
      const result = await applyProviderStatus(db, row.providerRefundId, remote.status, now);
      if (result === 'updated') summary.updated += 1;
    } catch (error) {
      summary.deferred += 1;
      logger.warn({ msg: 'refund sweep deferred', error: error instanceof Error ? error.message : 'unknown' });
    }
  }
  return summary;
}

// ---------- reads ----------

export async function listRefundsForOrder(db: PrismaClient, scope: TenantScope, orderId: string): Promise<RefundView[]> {
  const order = await db.order.findFirst({ where: { id: orderId, businessId: scope.businessId }, select: { id: true } });
  if (!order) throw new AppError(404, 'order_not_found', 'Order not found.');
  const rows = await db.refund.findMany({
    where: { orderId, businessId: scope.businessId },
    orderBy: { createdAt: 'asc' },
    select: REFUND_SELECT,
  });
  return rows.map((row) => refundView(row as RefundRow));
}
