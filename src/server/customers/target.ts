import type { PrismaClient } from '@prisma/client';
import type { TenantScope } from '@/server/tenant';

// Decides which phone number a code goes to. Sign-in: the number the customer typed. Lookup: the number
// on the order, never a number typed into the request (FR-CUS-03). Returns null when no code should be sent,
// which keeps the response identical for unknown or erased targets.

export async function codeTargetPhone(
  db: PrismaClient,
  scope: TenantScope,
  request: { purpose: 'CUSTOMER_LOGIN'; phoneE164: string } | { purpose: 'ORDER_LOOKUP'; orderNumber: string },
): Promise<string | null> {
  if (request.purpose === 'CUSTOMER_LOGIN') {
    const customer = await db.customer.findUnique({
      where: { businessId_phoneE164: { businessId: scope.businessId, phoneE164: request.phoneE164 } },
      select: { anonymizedAt: true },
    });
    // A number with no customer yet is valid: the customer is created on first verified sign-in.
    return customer?.anonymizedAt ? null : request.phoneE164;
  }
  const order = await db.order.findFirst({
    where: { businessId: scope.businessId, orderNumber: request.orderNumber },
    select: { customer: { select: { phoneE164: true, anonymizedAt: true } } },
  });
  if (!order || order.customer.anonymizedAt) return null;
  return order.customer.phoneE164;
}
