import type { PaymentStatus, PrismaClient } from '@prisma/client';
import { formatNaira } from '@/lib/money';
import { maskEmail, maskPhone } from '@/server/orders/admin';
import type { TenantScope } from '@/server/tenant';
import { afterCursor, NEWEST_FIRST, pageOf, type PageCursor } from './paging';
import { lagosDayStart } from './day';

// Read-only staff views (02 §6.5): overview, customers, payments and the audit log. Each takes the tenant
// from the verified staff session, never from the request. Contact details are masked here, not in the
// route, so no caller can get the full value by choosing a different route.

const FULFILMENT_STATUSES = ['PAYMENT_CONFIRMED', 'CONFIRMED', 'PROCESSING', 'READY_FOR_DISPATCH'] as const;

export async function overviewForStaff(db: PrismaClient, scope: TenantScope, now = new Date()) {
  const dayStart = lagosDayStart(now);
  const [awaitingPayment, toFulfil, refundsAwaitingDecision, refundsProcessing, paidToday] = await Promise.all([
    db.order.count({ where: { businessId: scope.businessId, status: 'PENDING_PAYMENT' } }),
    db.order.count({ where: { businessId: scope.businessId, status: { in: [...FULFILMENT_STATUSES] } } }),
    db.refund.count({ where: { businessId: scope.businessId, status: 'PENDING' } }),
    db.refund.count({ where: { businessId: scope.businessId, status: 'PROCESSING' } }),
    db.payment.aggregate({
      where: { businessId: scope.businessId, status: 'SUCCEEDED', verifiedAt: { gte: dayStart } },
      _sum: { amountMinor: true },
      _count: { _all: true },
    }),
  ]);
  const sum = paidToday._sum.amountMinor ?? 0n;
  return {
    asOf: now.toISOString(),
    businessDayStart: dayStart.toISOString(),
    orders: { awaitingPayment, toFulfil },
    refunds: { awaitingDecision: refundsAwaitingDecision, processing: refundsProcessing },
    paidToday: { count: paidToday._count._all, amountMinor: sum.toString(), amountDisplay: formatNaira(sum) },
  };
}

export type CustomerFilter = { q?: string; limit: number; cursor: PageCursor | null };

/** Customers, newest first. A search of four or more digits matches the phone number; text matches name or email. */
export async function listCustomersForStaff(db: PrismaClient, scope: TenantScope, options: CustomerFilter) {
  const term = options.q?.trim() ?? '';
  const digits = term.replace(/\D/g, '');
  const search: object[] = [];
  if (term) {
    const clauses: object[] = [{ fullName: { contains: term, mode: 'insensitive' } }, { email: { contains: term, mode: 'insensitive' } }];
    if (digits.length >= 4) clauses.push({ phoneE164: { contains: digits } });
    search.push({ OR: clauses });
  }
  const rows = await db.customer.findMany({
    where: { AND: [{ businessId: scope.businessId }, ...search, afterCursor(options.cursor)] },
    orderBy: NEWEST_FIRST,
    take: options.limit + 1,
    select: {
      id: true,
      phoneE164: true,
      fullName: true,
      email: true,
      anonymizedAt: true,
      createdAt: true,
      _count: { select: { orders: true } },
    },
  });
  const page = pageOf(rows, options.limit);
  return {
    items: page.items.map((row) => ({
      id: row.id,
      phone: maskPhone(row.phoneE164),
      email: row.email ? maskEmail(row.email) : null,
      firstName: row.fullName ? row.fullName.split(' ')[0] : null,
      erased: row.anonymizedAt !== null,
      orderCount: row._count.orders,
      createdAt: row.createdAt.toISOString(),
    })),
    nextCursor: page.nextCursor,
  };
}

export type PaymentFilter = { status?: PaymentStatus; limit: number; cursor: PageCursor | null };

/**
 * Payments, newest first, for reconciliation with the provider. The reference and provider transaction id are
 * shown; the checkout link (`authorizationUrl`) is not, because it lets whoever holds it open the payment page.
 */
export async function listPaymentsForStaff(db: PrismaClient, scope: TenantScope, options: PaymentFilter) {
  const rows = await db.payment.findMany({
    where: {
      AND: [
        { businessId: scope.businessId },
        ...(options.status ? [{ status: options.status }] : []),
        afterCursor(options.cursor),
      ],
    },
    orderBy: NEWEST_FIRST,
    take: options.limit + 1,
    select: {
      id: true,
      createdAt: true,
      provider: true,
      reference: true,
      providerTransactionId: true,
      status: true,
      amountMinor: true,
      currency: true,
      channel: true,
      failureReason: true,
      verifiedAt: true,
      order: { select: { orderNumber: true } },
    },
  });
  const page = pageOf(rows, options.limit);
  return {
    items: page.items.map((row) => ({
      id: row.id,
      orderNumber: row.order.orderNumber,
      provider: row.provider,
      reference: row.reference,
      providerTransactionId: row.providerTransactionId,
      status: row.status,
      amountMinor: row.amountMinor.toString(),
      amountDisplay: formatNaira(row.amountMinor),
      currency: row.currency,
      channel: row.channel,
      failureReason: row.failureReason,
      verifiedAt: row.verifiedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    })),
    nextCursor: page.nextCursor,
  };
}

export type AuditFilter = { action?: string; entityType?: string; limit: number; cursor: PageCursor | null };

/** The audit log, newest first. Rows are never edited; the list is read-only. */
export async function listAuditLogsForStaff(db: PrismaClient, scope: TenantScope, options: AuditFilter) {
  const rows = await db.auditLog.findMany({
    where: {
      AND: [
        { businessId: scope.businessId },
        ...(options.action ? [{ action: options.action }] : []),
        ...(options.entityType ? [{ entityType: options.entityType }] : []),
        afterCursor(options.cursor),
      ],
    },
    orderBy: NEWEST_FIRST,
    take: options.limit + 1,
    select: { id: true, createdAt: true, actorType: true, actorId: true, action: true, entityType: true, entityId: true, changes: true, ip: true },
  });
  const page = pageOf(rows, options.limit);
  return {
    items: page.items.map((row) => ({
      id: row.id,
      at: row.createdAt.toISOString(),
      actorType: row.actorType,
      actorId: row.actorId,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      changes: row.changes,
      ip: row.ip,
    })),
    nextCursor: page.nextCursor,
  };
}
