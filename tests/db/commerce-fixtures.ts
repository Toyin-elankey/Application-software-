import type { PrismaClient } from '@prisma/client';
import type { StoreContext, StoreSettings } from '@/server/store';
import { unique } from './helpers';

// Fixtures for Stage 3 tests. Each call creates its own business, so tests never share stock or carts.

export const DEFAULT_SETTINGS: StoreSettings = {
  pricesIncludeVat: true,
  vatRateBps: 750,
  stockReservationMinutes: 30,
  orderNumberPrefix: 'ORD',
};

export async function createStore(db: PrismaClient, options: { zoneStates?: string[]; zoneFee?: bigint; threshold?: bigint | null } = {}) {
  const business = await db.business.create({ data: { slug: unique('shop'), name: 'Test Shop' }, select: { id: true } });
  const scope = { businessId: business.id };
  await db.deliveryZone.create({
    data: {
      businessId: business.id,
      name: 'Test zone',
      states: options.zoneStates ?? ['Lagos'],
      feeMinor: options.zoneFee ?? 150000n,
      freeShippingThresholdMinor: options.threshold === undefined ? 10_000_000n : options.threshold,
      etaLabel: 'Estimate: 1-2 days',
      isActive: true,
      sortOrder: 1,
    },
  });
  const store: StoreContext = { scope, currency: 'NGN', settings: DEFAULT_SETTINGS };
  return { businessId: business.id, scope, store };
}

export async function createProduct(
  db: PrismaClient,
  businessId: string,
  options: { priceMinor?: bigint; onHand?: number; reserved?: number; trackInventory?: boolean; status?: 'PUBLISHED' | 'DRAFT' } = {},
) {
  const slug = unique('item');
  const sku = unique('SKU').toUpperCase();
  const product = await db.product.create({
    data: {
      businessId,
      slug,
      name: `Item ${slug}`,
      description: 'Test product',
      status: options.status ?? 'PUBLISHED',
      variants: {
        create: {
          businessId,
          sku,
          title: 'Default',
          priceMinor: options.priceMinor ?? 1500000n,
          trackInventory: options.trackInventory ?? true,
          onHand: options.onHand ?? 10,
          reserved: options.reserved ?? 0,
          isDefault: true,
          isActive: true,
        },
      },
    },
    select: { id: true, variants: { select: { id: true } } },
  });
  return { productId: product.id, variantId: product.variants[0].id, slug };
}

export function checkoutBody(overrides: Partial<{ state: string; whatsappUpdates: boolean; customerNote: string; phone: string; expected: { totalMinor: string; lines: { variantId: string; quantity: number; unitPriceMinor: string }[] } }> = {}) {
  return {
    recipientName: 'Ada Test',
    phoneE164: overrides.phone ?? '+2348012345678',
    email: 'ada@example.com',
    address: { line1: '12 Test Street', city: 'Yaba', state: overrides.state ?? 'Lagos', postalCode: '100001' },
    customerNote: overrides.customerNote,
    whatsappUpdates: overrides.whatsappUpdates ?? false,
    expected: overrides.expected ?? { totalMinor: '0', lines: [] },
  };
}
