// Pricing as pure functions. Every amount is BigInt minor units (kobo). No I/O here, so the rules
// can be tested exhaustively. The database is only read by the callers that gather inputs.
//
// Rules (PRD BR-03, BR-07, FR-CART-04, A-06):
// - Line total = unit price x quantity. Unit price is the variant price at the time of the calculation.
// - Prices include VAT. The VAT figure is informational and is taken from the goods subtotal only.
// - Delivery fee comes from the zone. It is waived when the goods subtotal reaches the zone's
//   free-shipping threshold.
// - Discounts are not in MVP, so the discount is always zero. The field stays for the schema.

export type PriceLine = { unitPriceMinor: bigint; quantity: number };

export type ZoneFee = { feeMinor: bigint; freeShippingThresholdMinor: bigint | null };

export type OrderTotals = {
  subtotalMinor: bigint;
  discountMinor: bigint;
  shippingMinor: bigint;
  taxMinor: bigint;
  totalMinor: bigint;
  freeShipping: boolean;
};

export function lineTotal(line: PriceLine): bigint {
  return line.unitPriceMinor * BigInt(line.quantity);
}

export function subtotalOf(lines: readonly PriceLine[]): bigint {
  return lines.reduce((sum, line) => sum + lineTotal(line), 0n);
}

/**
 * VAT contained in a VAT-inclusive amount: amount x rate / (10000 + rate), rounded half up.
 * Rates are in basis points (750 = 7.5%).
 */
export function vatIncludedIn(amountMinor: bigint, vatRateBps: number): bigint {
  if (!Number.isInteger(vatRateBps) || vatRateBps < 0) throw new RangeError('vatRateBps must be a non-negative integer');
  const rate = BigInt(vatRateBps);
  const denominator = 10000n + rate;
  return (amountMinor * rate * 2n + denominator) / (denominator * 2n);
}

export function deliveryFeeFor(zone: ZoneFee, subtotalMinor: bigint): { feeMinor: bigint; freeShipping: boolean } {
  if (zone.freeShippingThresholdMinor !== null && subtotalMinor >= zone.freeShippingThresholdMinor) {
    return { feeMinor: 0n, freeShipping: true };
  }
  return { feeMinor: zone.feeMinor, freeShipping: false };
}

export function computeOrderTotals(input: {
  lines: readonly PriceLine[];
  zone: ZoneFee | null;
  vatRateBps: number;
  pricesIncludeVat: boolean;
}): OrderTotals {
  if (!input.pricesIncludeVat) {
    // The MVP is priced VAT-inclusive (A-06). Exclusive pricing would change every total, so it is refused.
    throw new Error('Only VAT-inclusive pricing is supported in the MVP');
  }
  const subtotalMinor = subtotalOf(input.lines);
  const delivery = input.zone ? deliveryFeeFor(input.zone, subtotalMinor) : { feeMinor: 0n, freeShipping: false };
  const discountMinor = 0n;
  return {
    subtotalMinor,
    discountMinor,
    shippingMinor: delivery.feeMinor,
    taxMinor: vatIncludedIn(subtotalMinor, input.vatRateBps),
    totalMinor: subtotalMinor - discountMinor + delivery.feeMinor,
    freeShipping: delivery.freeShipping,
  };
}
