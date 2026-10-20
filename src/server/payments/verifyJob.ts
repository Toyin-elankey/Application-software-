import type { PrismaClient } from '@prisma/client';
import { logger } from '@/lib/logger';
import type { JobHandler } from '@/server/jobs/runner';
import { applyVerifiedPayment } from './confirm';
import type { PaymentProvider } from './provider';

// payment.verify (06 §4.3 step 7, §4.4). The job asks the provider what is true now, then applies the
// result with the same rules every other path uses. A webhook never confirms a payment by itself.

export function paymentVerifyHandler(db: PrismaClient, provider: PaymentProvider): JobHandler {
  return async (job) => {
    const reference = typeof job.payload.reference === 'string' ? job.payload.reference : '';
    if (!reference) return; // nothing to verify; not retryable, so succeed quietly

    const payment = await db.payment.findUnique({
      where: { reference },
      select: { businessId: true, status: true, provider: true },
    });
    if (!payment) return;

    if (payment.provider !== provider.name) {
      // Misconfiguration: this payment belongs to another provider. Retried; staff see it in lastError.
      throw new Error(`payment was made with ${payment.provider}, but the active provider is ${provider.name}`);
    }

    // A FAILED or ABANDONED payment is still verified: a success can arrive after the customer's failed
    // attempt, and it must be applied (06 §5). Only a SUCCEEDED payment is final and skipped.
    if (payment.status !== 'SUCCEEDED') {
      // Verify is the source of truth. A failed call throws, so the job retries and the order is unchanged.
      const verified = await provider.verify(reference);
      const outcome = await applyVerifiedPayment(db, { businessId: payment.businessId }, reference, verified);
      if (outcome === 'pending') throw new Error('provider still reports the payment as pending');
      logger.info({ msg: 'payment verified', reference, outcome });
    }

    const webhookEventId = typeof job.payload.webhookEventId === 'string' ? job.payload.webhookEventId : null;
    if (webhookEventId) {
      await db.webhookEvent.updateMany({
        where: { id: webhookEventId },
        data: { status: 'PROCESSED', processedAt: new Date(), attempts: { increment: 1 } },
      });
    }
  };
}
