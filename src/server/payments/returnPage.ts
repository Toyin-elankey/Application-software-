import type { PrismaClient } from '@prisma/client';
import { logger } from '@/lib/logger';
import { applyVerifiedPayment } from './confirm';
import type { PaymentProvider } from './provider';

// The customer's return page (06 §4.2). Landing here never marks an order paid by itself: the page asks
// the provider (server-side verify) and applies the answer with the same rules as the webhook and the
// jobs. The reference in the URL is the proof of access: it is unguessable and must match the order.

export type ReturnView =
  | { kind: 'not_found' }
  | { kind: 'confirmed'; orderNumber: string; orderStatus: string }
  | { kind: 'pending'; orderNumber: string; orderStatus: string }
  | { kind: 'not_completed'; orderNumber: string; orderStatus: string }
  | { kind: 'received_after_cancel'; orderNumber: string; orderStatus: string }
  | { kind: 'unavailable'; orderNumber: string; orderStatus: string };

const VERIFIABLE = new Set(['INITIALIZED', 'PENDING', 'FAILED', 'ABANDONED']);

export async function resolvePaymentReturn(
  db: PrismaClient,
  provider: PaymentProvider | null,
  orderNumber: string,
  reference: string,
  now = new Date(),
): Promise<ReturnView> {
  const payment = await db.payment.findUnique({
    where: { reference },
    select: { businessId: true, status: true, provider: true, order: { select: { orderNumber: true, status: true } } },
  });
  if (!payment || payment.order.orderNumber !== orderNumber) return { kind: 'not_found' };

  let unavailable = false;
  if (VERIFIABLE.has(payment.status)) {
    if (!provider || provider.name !== payment.provider) {
      unavailable = true;
    } else {
      try {
        const verified = await provider.verify(reference);
        await applyVerifiedPayment(db, { businessId: payment.businessId }, reference, verified, now);
      } catch (error) {
        unavailable = true;
        logger.warn({ msg: 'return page verify failed; order unchanged', error: error instanceof Error ? error.message : 'unknown' });
      }
    }
  }

  const current = await db.payment.findUniqueOrThrow({
    where: { reference },
    select: { status: true, order: { select: { orderNumber: true, status: true } } },
  });
  const base = { orderNumber: current.order.orderNumber, orderStatus: current.order.status };
  if (current.status === 'SUCCEEDED') {
    return current.order.status === 'CANCELLED' ? { kind: 'received_after_cancel', ...base } : { kind: 'confirmed', ...base };
  }
  if (unavailable) return { kind: 'unavailable', ...base };
  if (current.status === 'INITIALIZED' || current.status === 'PENDING') return { kind: 'pending', ...base };
  return { kind: 'not_completed', ...base };
}

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

const MESSAGES: Record<Exclude<ReturnView['kind'], 'not_found'>, string> = {
  confirmed: 'Payment confirmed. Thank you, your order is paid.',
  pending: 'We are waiting for the payment provider to confirm your payment. This page will update automatically.',
  not_completed: 'The payment was not completed. No money was taken for this order.',
  received_after_cancel:
    'We received your payment, but this order can no longer be confirmed because its reservation had expired. Our team will contact you about it.',
  unavailable: 'We could not reach the payment provider just now. Your order is not marked paid yet. This page will retry automatically.',
};

export function renderReturnPage(view: ReturnView): string {
  const body =
    view.kind === 'not_found'
      ? '<h1>Payment not found</h1><p>We could not find a payment for this link.</p>'
      : `<h1>${esc(MESSAGES[view.kind])}</h1><p>Order <strong>${esc(view.orderNumber)}</strong>, status <code>${esc(view.orderStatus)}</code></p>`;
  const refresh = view.kind === 'pending' || view.kind === 'unavailable' ? '<meta http-equiv="refresh" content="10">' : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">${refresh}<title>Payment</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem;line-height:1.5">${body}</body></html>`;
}
