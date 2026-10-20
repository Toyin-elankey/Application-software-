import type { PrismaClient } from '@prisma/client';
import { AppError } from '@/server/http/problem';
import type { TenantScope } from '@/server/tenant';
import { audit } from '@/server/auth/staff';
import { hasPermission, type Permission } from '@/server/auth/permissions';
import type { StaffActor } from '@/server/auth/staff';
import { cancelUnpaidOrderTx } from './cancel';
import { canTransition, type OrderStatus } from './stateMachine';

// Staff order APIs (02 §6.5). Reads are masked. Every write runs in one transaction with a version
// check (If-Match) and writes an OrderStatusEvent and an AuditLog row.

/** Fulfilment moves (PRD §8: Owner, Admin, Manager, Fulfilment). */
const FULFILMENT_MOVES = new Set([
  'PAYMENT_CONFIRMED>CONFIRMED',
  'CONFIRMED>PROCESSING',
  'PROCESSING>READY_FOR_DISPATCH',
  'READY_FOR_DISPATCH>DISPATCHED',
  'DISPATCHED>OUT_FOR_DELIVERY',
  'OUT_FOR_DELIVERY>DELIVERED',
  'OUT_FOR_DELIVERY>DISPATCHED',
]);

export function parseIfMatch(header: string | null): number {
  if (header === null || header.trim() === '') {
    throw new AppError(428, 'precondition_required', 'Send If-Match with the order version you are changing.');
  }
  const cleaned = header.trim().replace(/^W\//, '').replace(/^"(.*)"$/, '$1');
  if (!/^\d{1,9}$/.test(cleaned)) throw new AppError(400, 'invalid_if_match', 'If-Match must be the order version, for example "3".');
  return Number(cleaned);
}

export function etagFor(version: number): string {
  return `"${version}"`;
}

export function maskPhone(e164: string): string {
  return e164.length <= 6 ? '***' : `${e164.slice(0, 4)}${'*'.repeat(e164.length - 6)}${e164.slice(-2)}`;
}

export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

export async function listOrdersForStaff(db: PrismaClient, scope: TenantScope, options: { status?: OrderStatus; limit: number }) {
  const rows = await db.order.findMany({
    where: { businessId: scope.businessId, ...(options.status ? { status: options.status } : {}) },
    orderBy: { createdAt: 'desc' },
    take: options.limit,
    select: {
      id: true,
      orderNumber: true,
      status: true,
      totalMinor: true,
      currency: true,
      version: true,
      createdAt: true,
      customer: { select: { phoneE164: true, fullName: true } },
    },
  });
  return rows.map((row) => ({
    id: row.id,
    orderNumber: row.orderNumber,
    status: row.status,
    totalMinor: row.totalMinor.toString(),
    currency: row.currency,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    customer: { phone: maskPhone(row.customer.phoneE164), name: row.customer.fullName ? `${row.customer.fullName.split(' ')[0]}` : null },
  }));
}

export async function getOrderForStaff(db: PrismaClient, scope: TenantScope, orderId: string) {
  const order = await db.order.findFirst({
    where: { id: orderId, businessId: scope.businessId },
    select: {
      id: true,
      orderNumber: true,
      status: true,
      channel: true,
      currency: true,
      subtotalMinor: true,
      shippingMinor: true,
      discountMinor: true,
      totalMinor: true,
      cancelReason: true,
      paidAt: true,
      version: true,
      createdAt: true,
      items: { select: { sku: true, productName: true, quantity: true, lineTotalMinor: true } },
      customer: { select: { phoneE164: true, email: true, fullName: true } },
      statusEvents: { orderBy: { createdAt: 'asc' }, select: { fromStatus: true, toStatus: true, actorType: true, reason: true, createdAt: true } },
    },
  });
  if (!order) throw new AppError(404, 'order_not_found', 'Order not found.');
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    channel: order.channel,
    currency: order.currency,
    subtotalMinor: order.subtotalMinor.toString(),
    shippingMinor: order.shippingMinor.toString(),
    discountMinor: order.discountMinor.toString(),
    totalMinor: order.totalMinor.toString(),
    cancelReason: order.cancelReason,
    paidAt: order.paidAt?.toISOString() ?? null,
    createdAt: order.createdAt.toISOString(),
    version: order.version,
    items: order.items.map((i) => ({ sku: i.sku, productName: i.productName, quantity: i.quantity, lineTotalMinor: i.lineTotalMinor.toString() })),
    customer: { phone: maskPhone(order.customer.phoneE164), email: order.customer.email ? maskEmail(order.customer.email) : null, name: order.customer.fullName },
    timeline: order.statusEvents.map((e) => ({ from: e.fromStatus, to: e.toStatus, actor: e.actorType, reason: e.reason, at: e.createdAt.toISOString() })),
  };
}

/** Full phone and email, for an audited reveal only (PRD §8: Owner, Admin, Support). */
export async function revealCustomerContact(
  db: PrismaClient,
  actor: StaffActor,
  orderId: string,
  reason: string,
  now = new Date(),
): Promise<{ phone: string; email: string | null }> {
  if (!hasPermission(actor.role, 'customers.reveal_pii')) throw new AppError(403, 'forbidden', 'Your role does not allow this action.');
  return db.$transaction(async (tx) => {
    const order = await tx.order.findFirst({
      where: { id: orderId, businessId: actor.businessId },
      select: { id: true, customer: { select: { id: true, phoneE164: true, email: true } } },
    });
    if (!order) throw new AppError(404, 'order_not_found', 'Order not found.');
    await audit(
      tx,
      actor.businessId,
      actor.staffUserId,
      'CUSTOMER_PII_REVEALED',
      'Customer',
      order.customer.id,
      { reason, orderId: order.id, fields: ['phone', 'email'] },
      actor.ip,
      actor.userAgent,
      now,
    );
    return { phone: order.customer.phoneE164, email: order.customer.email };
  });
}

export async function transitionOrderForStaff(
  db: PrismaClient,
  actor: StaffActor,
  input: { orderId: string; expectedVersion: number; to: OrderStatus; reason: string | null },
  now = new Date(),
): Promise<{ status: OrderStatus; version: number }> {
  const scope = { businessId: actor.businessId };
  return db.$transaction(
    async (tx) => {
      const current = await tx.order.findFirst({
        where: { id: input.orderId, businessId: actor.businessId },
        select: { status: true, version: true, paidAt: true },
      });
      if (!current) throw new AppError(404, 'order_not_found', 'Order not found.');
      if (current.version !== input.expectedVersion) {
        throw new AppError(409, 'version_conflict', 'This order changed. Reload it and try again.', { currentVersion: current.version });
      }

      const from = current.status as OrderStatus;
      const key = `${from}>${input.to}`;
      let permission: Permission;
      // Cancelling is only for unpaid orders. A paid order needs a refund, which is not built yet.
      if (input.to === 'CANCELLED' && from === 'PENDING_PAYMENT') permission = 'orders.cancel_unpaid';
      else if (FULFILMENT_MOVES.has(key)) permission = 'orders.fulfil';
      else throw new AppError(422, 'transition_not_available', `Staff cannot move an order from ${from} to ${input.to} here.`);
      if (!hasPermission(actor.role, permission)) throw new AppError(403, 'forbidden', 'Your role does not allow this action.');

      if (input.to === 'CANCELLED') {
        const outcome = await cancelUnpaidOrderTx(tx, scope, input.orderId, {
          now,
          reason: 'cancelled_by_staff',
          failureReason: 'cancelled_by_staff',
          actorType: 'STAFF',
          actorId: actor.staffUserId,
          expectedVersion: input.expectedVersion,
        });
        if (outcome === 'already_paid') throw new AppError(409, 'payment_received', 'A payment was received for this order, so it cannot be cancelled.');
        if (outcome === 'not_pending') throw new AppError(409, 'transition_refused', 'This order is no longer awaiting payment.');
        await audit(tx, actor.businessId, actor.staffUserId, 'ORDER_STATUS_CHANGED', 'Order', input.orderId, { from, to: 'CANCELLED', reason: input.reason }, actor.ip, actor.userAgent, now);
        return { status: 'CANCELLED' as OrderStatus, version: input.expectedVersion + 1 };
      }

      const rule = canTransition(from, input.to, 'STAFF', { paid: current.paidAt !== null });
      if (!rule.ok) throw new AppError(422, 'transition_refused', rule.reason);

      // Lock the order row, then write only if the version is still the one we checked.
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${input.orderId}::uuid AND "businessId" = ${actor.businessId}::uuid FOR UPDATE`;
      const moved = await tx.order.updateMany({
        where: { id: input.orderId, businessId: actor.businessId, version: input.expectedVersion, status: from },
        data: { status: input.to, version: { increment: 1 } },
      });
      if (moved.count !== 1) throw new AppError(409, 'version_conflict', 'This order changed. Reload it and try again.');

      await tx.orderStatusEvent.create({
        data: { orderId: input.orderId, fromStatus: from, toStatus: input.to, actorType: 'STAFF', actorId: actor.staffUserId, reason: input.reason },
      });
      await audit(tx, actor.businessId, actor.staffUserId, 'ORDER_STATUS_CHANGED', 'Order', input.orderId, { from, to: input.to, reason: input.reason }, actor.ip, actor.userAgent, now);
      return { status: input.to, version: input.expectedVersion + 1 };
    },
    { timeout: 15_000, maxWait: 10_000 },
  );
}

