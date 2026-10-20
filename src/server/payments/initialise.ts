import type { PrismaClient } from '@prisma/client';
import { getEnv } from '@/lib/env';
import { AppError } from '@/server/http/problem';
import type { TenantScope } from '@/server/tenant';
import type { PaymentProvider } from './provider';

// Starts the provider transaction for a payment (06 §4.1). Runs after the checkout commit, never
// inside it, because it is a network call. Idempotent: a payment that already has an authorisation
// URL is returned as it is. A failure leaves the payment INITIALIZED so it can be resumed later.

export async function initialisePayment(
  db: PrismaClient,
  scope: TenantScope,
  paymentId: string,
  provider: PaymentProvider,
) {
  const payment = await db.payment.findFirst({
    where: { id: paymentId, businessId: scope.businessId },
    include: { order: { select: { id: true, orderNumber: true, status: true, customer: { select: { email: true } } } } },
  });
  if (!payment) throw new AppError(404, 'payment_not_found', 'Payment not found.');
  if (payment.order.status !== 'PENDING_PAYMENT') return payment;
  if (payment.status === 'PENDING' && payment.authorizationUrl) return payment;
  if (payment.status !== 'INITIALIZED' && payment.status !== 'PENDING') return payment;

  const base = getEnv().APP_BASE_URL.replace(/\/$/, '');
  const result = await provider.initialize({
    reference: payment.reference,
    amountMinor: payment.amountMinor,
    currency: 'NGN',
    email: payment.order.customer.email ?? '',
    callbackUrl: `${base}/orders/${payment.order.orderNumber}/payment-return`,
    metadata: { businessId: scope.businessId, orderId: payment.order.id, orderNumber: payment.order.orderNumber },
  });

  await db.payment.updateMany({
    where: { id: paymentId, status: { in: ['INITIALIZED', 'PENDING'] } },
    data: { status: 'PENDING', authorizationUrl: result.authorizationUrl },
  });
  return db.payment.findUniqueOrThrow({ where: { id: paymentId } });
}
