import { createHmac, randomInt } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { getEnv } from '@/lib/env';
import { formatNaira } from '@/lib/money';
import { AppError } from '@/server/http/problem';
import { activePaymentProviderName } from './provider';
import { mockPaymentProvider } from './mock';
import { applyVerifiedPayment, type ConfirmOutcome } from './confirm';
import { drainPaymentJobs } from './drain';
import { paystackWebhookSecret, receivePaystackWebhook } from './webhook';

// The mock checkout page (dev, CI and demos only). A customer lands here from the authorisation URL
// the mock provider returns, chooses an outcome, and the server then verifies that outcome through
// the provider interface and applies it with the same code the real webhook and return path will
// use (06 §4.4). Nothing here is reachable when the active provider is not MOCK.

export const MOCK_OUTCOMES = ['SUCCESS', 'FAILED', 'ABANDONED'] as const;
export type MockOutcome = (typeof MOCK_OUTCOMES)[number];

/** Throws 404 unless the mock provider is the active one. Production never reaches this. */
export function assertMockPaymentsEnabled(): void {
  if (getEnv().NODE_ENV === 'production') throw new AppError(404, 'not_found', 'Not found.');
  let name;
  try {
    name = activePaymentProviderName();
  } catch {
    throw new AppError(404, 'not_found', 'Not found.');
  }
  if (name !== 'MOCK') throw new AppError(404, 'not_found', 'Not found.');
}

export async function loadMockPayment(db: PrismaClient, reference: string) {
  assertMockPaymentsEnabled();
  const payment = await db.payment.findUnique({
    where: { reference },
    select: {
      reference: true,
      status: true,
      amountMinor: true,
      businessId: true,
      order: { select: { orderNumber: true, status: true } },
    },
  });
  if (!payment) throw new AppError(404, 'payment_not_found', 'Payment not found.');
  return payment;
}

/**
 * Simulates the chosen outcome at the mock provider and delivers it the way Paystack would: a signed
 * charge.success or charge.failed goes through the real webhook intake, then the due jobs run inline.
 * The job verifies with the provider before anything is applied (06 §4.3, §4.4). ABANDONED has no
 * webhook (Paystack sends none for an abandoned checkout), so it is verified directly (06 §6).
 */
export async function completeMockPayment(
  db: PrismaClient,
  reference: string,
  outcome: MockOutcome,
): Promise<{ outcome: ConfirmOutcome; orderNumber: string; orderStatus: string; paymentStatus: string; amountMinor: bigint }> {
  const payment = await loadMockPayment(db, reference);
  const before = await db.payment.findUniqueOrThrow({ where: { reference }, select: { status: true, order: { select: { status: true } } } });
  const provider = mockPaymentProvider();
  try {
    provider.simulate(reference, outcome);
  } catch {
    // The mock keeps no record after a restart. Tell the customer, rather than guessing a result.
    throw new AppError(409, 'mock_transaction_unknown', 'This mock payment is no longer known to the server. Start the checkout again.');
  }

  if (outcome === 'ABANDONED') {
    const verified = await provider.verify(reference);
    await applyVerifiedPayment(db, { businessId: payment.businessId }, reference, verified);
  } else {
    const body = Buffer.from(
      JSON.stringify({
        event: outcome === 'SUCCESS' ? 'charge.success' : 'charge.failed',
        // A fresh id per simulated delivery, so each press is a new webhook event. Repeats are still
        // safe: the verify job and the confirmation rules decide what changes.
        data: { id: randomInt(1, 2 ** 31), reference, status: outcome === 'SUCCESS' ? 'success' : 'failed' },
      }),
    );
    const secret = paystackWebhookSecret();
    if (!secret) throw new AppError(503, 'payments_unavailable', 'Payments are not configured.');
    const signature = createHmac('sha512', secret).update(body).digest('hex');
    const received = await receivePaystackWebhook(db, body, signature, secret);
    if (received.status !== 200) throw new AppError(500, 'mock_webhook_rejected', 'The mock webhook was rejected.');
    await drainPaymentJobs(db, { limit: 10 });
  }

  const after = await db.payment.findUniqueOrThrow({
    where: { reference },
    select: { status: true, order: { select: { orderNumber: true, status: true } } },
  });
  return {
    outcome: deriveOutcome(before, after),
    orderNumber: after.order.orderNumber,
    orderStatus: after.order.status,
    paymentStatus: after.status,
    amountMinor: payment.amountMinor,
  };
}

/** Maps the state before and after delivery to the outcome the customer sees. */
export function deriveOutcome(
  before: { status: string; order: { status: string } },
  after: { status: string; order: { status: string } },
): ConfirmOutcome {
  if (after.status === 'SUCCEEDED') {
    if (before.status === 'SUCCEEDED') return 'already_processed';
    if (after.order.status === 'CANCELLED') return 'late_success';
    if (before.order.status === 'CANCELLED') return 'late_reinstated';
    return 'confirmed';
  }
  if (after.status === 'FAILED' || after.status === 'ABANDONED') {
    return before.status === after.status ? 'already_processed' : 'failed';
  }
  return 'pending';
}

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem;line-height:1.5"><p style="background:#fff3cd;padding:.5rem;border-radius:.25rem"><strong>Mock payment.</strong> No money moves. This page exists for development and demos.</p>${body}</body></html>`;
}

export function renderMockPayPage(payment: { reference: string; amountMinor: bigint; order: { orderNumber: string } }): string {
  const form = (outcome: MockOutcome, label: string) =>
    `<form method="post" style="margin:.5rem 0"><input type="hidden" name="outcome" value="${outcome}"><button type="submit" style="padding:.5rem 1rem">${esc(label)}</button></form>`;
  return page(
    'Mock payment',
    `<h1 style="font-size:1.25rem">Pay ${esc(formatNaira(payment.amountMinor))} for order ${esc(payment.order.orderNumber)}</h1>
     <p>Reference <code>${esc(payment.reference)}</code></p>
     ${form('SUCCESS', 'Simulate successful payment')}
     ${form('FAILED', 'Simulate failed payment')}
     ${form('ABANDONED', 'Simulate abandoned payment')}`,
  );
}

export function renderMockErrorPage(message: string): string {
  return page('Mock payment error', `<h1 style="font-size:1.25rem">${esc(message)}</h1>`);
}

export function renderMockResultPage(result: {
  outcome: ConfirmOutcome;
  orderNumber: string;
  orderStatus: string;
  paymentStatus: string;
}): string {
  const message =
    result.outcome === 'confirmed'
      ? 'Payment verified. The order is now paid and awaiting staff confirmation.'
      : result.outcome === 'late_reinstated'
        ? 'Payment received after the reservation had expired. Stock was still free, so the order is paid again.'
      : result.outcome === 'already_processed'
        ? `This payment is already ${result.paymentStatus}. Nothing changed.`
        : result.outcome === 'failed'
          ? 'The payment was not successful. The order is still awaiting payment.'
          : result.outcome === 'pending'
            ? 'The provider still reports this payment as pending.'
            : result.outcome === 'late_success'
              ? 'Money was received after the order was no longer awaiting payment. It needs a refund review.'
              : `The payment could not be applied (${result.outcome}).`;
  return page(
    'Mock payment result',
    `<h1 style="font-size:1.25rem">${esc(message)}</h1><p>Order <strong>${esc(result.orderNumber)}</strong>, status <code>${esc(result.orderStatus)}</code></p>`,
  );
}
