import type { Prisma, PrismaClient } from '@prisma/client';
import { formatNaira } from '@/lib/money';
import { AppError } from '@/server/http/problem';
import type { TenantScope } from '@/server/tenant';
import { deliveryFeeFor } from '@/server/pricing/pricing';
import { canonicalState, type NigerianState } from './states';

// Delivery quote (FR-CART-04). A zone covers a state when the state is in zone.states. When several
// active zones cover the same state, the lowest sortOrder wins. Labels are estimates, never promises.

export type DeliveryQuote =
  | { covered: false; state: NigerianState }
  | {
      covered: true;
      state: NigerianState;
      zone: { id: string; name: string };
      feeMinor: bigint;
      feeDisplay: string;
      freeShipping: boolean;
      etaLabel: string | null;
    };

export function normaliseStateOrThrow(input: string): NigerianState {
  const state = canonicalState(input);
  if (!state) throw new AppError(422, 'unknown_state', 'Choose a Nigerian state from the list.');
  return state;
}

/** The zone that covers a canonical state, or null. Used inside checkout's transaction too. */
export async function findZoneForState(
  db: Pick<Prisma.TransactionClient, 'deliveryZone'>,
  scope: TenantScope,
  state: NigerianState,
) {
  return db.deliveryZone.findFirst({
    where: { businessId: scope.businessId, isActive: true, states: { has: state } },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    select: { id: true, name: true, feeMinor: true, freeShippingThresholdMinor: true, etaLabel: true },
  });
}

export async function quoteDelivery(
  db: PrismaClient,
  scope: TenantScope,
  rawState: string,
  subtotalMinor: bigint,
): Promise<DeliveryQuote> {
  const state = normaliseStateOrThrow(rawState);
  const zone = await findZoneForState(db, scope, state);
  if (!zone) return { covered: false, state };
  const fee = deliveryFeeFor(
    { feeMinor: zone.feeMinor, freeShippingThresholdMinor: zone.freeShippingThresholdMinor },
    subtotalMinor,
  );
  return {
    covered: true,
    state,
    zone: { id: zone.id, name: zone.name },
    feeMinor: fee.feeMinor,
    feeDisplay: formatNaira(fee.feeMinor),
    freeShipping: fee.freeShipping,
    etaLabel: zone.etaLabel,
  };
}
