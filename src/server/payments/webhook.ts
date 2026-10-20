import { Prisma, type PrismaClient } from '@prisma/client';
import { getEnv } from '@/lib/env';
import { logger } from '@/lib/logger';
import { parsePaystackEvent, verifyPaystackSignature } from './paystack';

// Paystack webhook intake (06 §4.3). Authenticates the raw body, stores the event once, and enqueues a
// payment.verify job. It never trusts the body for money: the job calls verify with the provider.

/** Used only outside production when no Paystack key is set, so the mock flow exercises the same code. */
export const DEV_MOCK_WEBHOOK_SECRET = 'whsec_mock_development_only';

const RELEVANT_EVENTS = new Set(['charge.success', 'charge.failed']);

export function paystackWebhookSecret(): string | null {
  const env = getEnv();
  if (env.PAYSTACK_SECRET_KEY) return env.PAYSTACK_SECRET_KEY;
  return env.NODE_ENV === 'production' ? null : DEV_MOCK_WEBHOOK_SECRET;
}

export type WebhookResult =
  | { status: 200; result: 'accepted' | 'duplicate' | 'ignored' }
  | { status: 400; result: 'bad_signature' | 'bad_payload' }
  | { status: 503; result: 'unconfigured' };

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

export async function receivePaystackWebhook(
  db: PrismaClient,
  rawBody: Buffer,
  signature: string | null,
  secret: string | null,
): Promise<WebhookResult> {
  if (!secret) return { status: 503, result: 'unconfigured' };

  // Signature first. A failed check writes nothing (06 §10: "no DB write beyond log, no job").
  if (!verifyPaystackSignature(rawBody, signature, secret)) {
    logger.warn({ msg: 'paystack webhook rejected: bad signature' });
    return { status: 400, result: 'bad_signature' };
  }

  let event;
  try {
    event = parsePaystackEvent(rawBody);
  } catch {
    logger.warn({ msg: 'paystack webhook rejected: body is not valid JSON' });
    return { status: 400, result: 'bad_payload' };
  }

  const payment =
    RELEVANT_EVENTS.has(event.event) && event.reference
      ? await db.payment.findUnique({ where: { reference: event.reference }, select: { id: true, businessId: true } })
      : null;
  // Refund events are not trusted either: the job asks the provider for the refund's state. The job is
  // created even if the refund is not recorded yet (the execute response may still be on its way); the
  // job then retries.
  const refundEvent = event.event.startsWith('refund.') && event.providerId ? event.providerId : null;
  const shouldVerify = payment !== null || refundEvent !== null;

  try {
    await db.$transaction(async (tx) => {
      // The unique (provider, externalId) constraint makes the second delivery fail here, and the
      // whole transaction rolls back, so no second job exists.
      const webhook = await tx.webhookEvent.create({
        data: {
          businessId: payment?.businessId ?? null,
          provider: 'PAYSTACK',
          externalId: event.externalId,
          eventType: event.event.slice(0, 80) || null,
          signatureValid: true,
          // Redacted: only what the job needs. The full body is not stored.
          payload: { event: event.event, reference: event.reference, providerId: event.providerId, status: event.status },
          status: shouldVerify ? 'RECEIVED' : 'IGNORED',
        },
      });
      if (payment) {
        await tx.job.create({
          data: {
            businessId: payment.businessId,
            type: 'payment.verify',
            payload: { reference: event.reference, webhookEventId: webhook.id },
            dedupeKey: `payment.verify:${webhook.id}`,
          },
        });
      } else if (refundEvent) {
        await tx.job.create({
          data: {
            businessId: null,
            type: 'refund.reconcile',
            payload: { providerRefundId: refundEvent, webhookEventId: webhook.id },
            dedupeKey: `refund.reconcile:${webhook.id}`,
          },
        });
      }
    });
  } catch (error) {
    if (isUniqueViolation(error)) return { status: 200, result: 'duplicate' };
    throw error;
  }
  return { status: 200, result: shouldVerify ? 'accepted' : 'ignored' };
}
