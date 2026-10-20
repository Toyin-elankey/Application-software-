import type { PrismaClient } from '@prisma/client';
import { formatNaira } from '@/lib/money';
import { AppError } from '@/server/http/problem';
import type { TenantScope } from '@/server/tenant';

// Customer-facing order and payment views. Internal notes, staff names and provider payloads are
// never selected here (PRD BR-06).

export type OrderView = Awaited<ReturnType<typeof buildOrderView>>;

export async function buildOrderView(db: PrismaClient, scope: TenantScope, orderId: string) {
  const order = await db.order.findFirst({
    where: { id: orderId, businessId: scope.businessId },
    select: {
      id: true,
      orderNumber: true,
      status: true,
      currency: true,
      subtotalMinor: true,
      discountMinor: true,
      shippingMinor: true,
      taxMinor: true,
      totalMinor: true,
      deliveryZoneName: true,
      reservationExpiresAt: true,
      paidAt: true,
      createdAt: true,
      items: {
        orderBy: { sku: 'asc' },
        select: {
          sku: true,
          productName: true,
          variantTitle: true,
          unitPriceMinor: true,
          quantity: true,
          lineTotalMinor: true,
        },
      },
      address: {
        select: {
          recipientName: true,
          line1: true,
          line2: true,
          city: true,
          state: true,
          postalCode: true,
          landmark: true,
        },
      },
    },
  });
  if (!order) throw new AppError(404, 'order_not_found', 'Order not found.');
  return {
    ...order,
    display: {
      subtotal: formatNaira(order.subtotalMinor),
      shipping: formatNaira(order.shippingMinor),
      tax: formatNaira(order.taxMinor),
      total: formatNaira(order.totalMinor),
    },
  };
}

export async function buildPaymentView(db: PrismaClient, scope: TenantScope, orderId: string) {
  const payment = await db.payment.findFirst({
    where: { orderId, businessId: scope.businessId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true, authorizationUrl: true, amountMinor: true },
  });
  if (!payment) return null;
  return {
    id: payment.id,
    status: payment.status,
    // The URL is only offered while the provider transaction is open.
    authorizationUrl: payment.status === 'PENDING' ? payment.authorizationUrl : null,
    amountMinor: payment.amountMinor,
    amountDisplay: formatNaira(payment.amountMinor),
  };
}
