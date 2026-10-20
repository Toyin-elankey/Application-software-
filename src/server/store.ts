import type { PrismaClient } from '@prisma/client';
import { getEnv } from '@/lib/env';
import { AppError } from '@/server/http/problem';
import type { TenantScope } from '@/server/tenant';

// Resolves the one brand this storefront serves (MVP is single-brand, PRD A-01). Multi-brand routing
// would replace this with a host or path lookup.

export type StoreSettings = {
  pricesIncludeVat: boolean;
  vatRateBps: number;
  stockReservationMinutes: number;
  orderNumberPrefix: string;
};

export type StoreContext = { scope: TenantScope; currency: 'NGN'; settings: StoreSettings };

const DEFAULTS: StoreSettings = {
  pricesIncludeVat: true,
  vatRateBps: 750,
  stockReservationMinutes: 30,
  orderNumberPrefix: 'ORD',
};

export async function getStoreContext(db: PrismaClient): Promise<StoreContext> {
  const business = await db.business.findUnique({
    where: { slug: getEnv().STORE_BUSINESS_SLUG },
    select: { id: true, currency: true, settings: true },
  });
  if (!business) throw new AppError(503, 'store_not_configured', 'The store is not set up yet.');
  if (business.currency !== 'NGN') throw new AppError(503, 'store_not_configured', 'Only NGN is supported in the MVP.');
  const s = business.settings;
  return {
    scope: { businessId: business.id },
    currency: 'NGN',
    settings: s
      ? {
          pricesIncludeVat: s.pricesIncludeVat,
          vatRateBps: s.vatRateBps,
          stockReservationMinutes: s.stockReservationMinutes,
          orderNumberPrefix: s.orderNumberPrefix,
        }
      : DEFAULTS,
  };
}
