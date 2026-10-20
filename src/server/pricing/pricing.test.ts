import { describe, expect, it } from 'vitest';
import { computeOrderTotals, deliveryFeeFor, lineTotal, subtotalOf, vatIncludedIn } from './pricing';

describe('lineTotal and subtotalOf', () => {
  it('multiplies unit price by quantity in BigInt, without precision loss', () => {
    expect(lineTotal({ unitPriceMinor: 9_007_199_254_740_993n, quantity: 3 })).toBe(27_021_597_764_222_979n);
  });

  it.each([
    [[], 0n],
    [[{ unitPriceMinor: 1500000n, quantity: 1 }], 1500000n],
    [
      [
        { unitPriceMinor: 1500000n, quantity: 2 },
        { unitPriceMinor: 900000n, quantity: 1 },
      ],
      3900000n,
    ],
  ])('sums the lines %#', (lines, expected) => {
    expect(subtotalOf(lines)).toBe(expected);
  });
});

describe('vatIncludedIn (7.5% inclusive)', () => {
  it.each([
    [0n, 0n],
    [10750n, 750n], // 107.50 incl. VAT -> 7.50 VAT
    [1500000n, 104651n], // 15,000.00 incl. VAT -> 1,046.51
    [1n, 0n], // rounds down below half
    [10n, 1n], // 0.698 kobo rounds half up to 1 kobo
  ])('VAT in %s kobo is %s kobo', (amount, expected) => {
    expect(vatIncludedIn(amount, 750)).toBe(expected);
  });

  it('is zero at a 0% rate', () => {
    expect(vatIncludedIn(1500000n, 0)).toBe(0n);
  });

  it('rejects a negative or fractional rate', () => {
    expect(() => vatIncludedIn(100n, -1)).toThrow(RangeError);
    expect(() => vatIncludedIn(100n, 7.5)).toThrow(RangeError);
  });
});

describe('deliveryFeeFor', () => {
  const zone = { feeMinor: 150000n, freeShippingThresholdMinor: 1000000n };

  it.each([
    [0n, 150000n, false],
    [999999n, 150000n, false],
    [1000000n, 0n, true], // threshold is inclusive
    [5000000n, 0n, true],
  ])('subtotal %s -> fee %s (free: %s)', (subtotal, fee, free) => {
    expect(deliveryFeeFor(zone, subtotal)).toEqual({ feeMinor: fee, freeShipping: free });
  });

  it('charges the fee when no threshold is configured', () => {
    expect(deliveryFeeFor({ feeMinor: 150000n, freeShippingThresholdMinor: null }, 99999999n)).toEqual({
      feeMinor: 150000n,
      freeShipping: false,
    });
  });
});

describe('computeOrderTotals', () => {
  const lines = [{ unitPriceMinor: 1500000n, quantity: 2 }]; // subtotal 30,000.00

  it('adds the zone fee and keeps VAT informational', () => {
    const totals = computeOrderTotals({
      lines,
      zone: { feeMinor: 150000n, freeShippingThresholdMinor: null },
      vatRateBps: 750,
      pricesIncludeVat: true,
    });
    expect(totals).toEqual({
      subtotalMinor: 3000000n,
      discountMinor: 0n,
      shippingMinor: 150000n,
      taxMinor: vatIncludedIn(3000000n, 750),
      totalMinor: 3150000n,
      freeShipping: false,
    });
  });

  it('waives the fee above the threshold, and the total equals the subtotal', () => {
    const totals = computeOrderTotals({
      lines,
      zone: { feeMinor: 150000n, freeShippingThresholdMinor: 2000000n },
      vatRateBps: 750,
      pricesIncludeVat: true,
    });
    expect(totals.shippingMinor).toBe(0n);
    expect(totals.totalMinor).toBe(3000000n);
    expect(totals.freeShipping).toBe(true);
  });

  it('has no fee and no delivery when no zone is chosen', () => {
    const totals = computeOrderTotals({ lines, zone: null, vatRateBps: 750, pricesIncludeVat: true });
    expect(totals.shippingMinor).toBe(0n);
    expect(totals.totalMinor).toBe(3000000n);
  });

  it('refuses VAT-exclusive pricing rather than computing it wrongly', () => {
    expect(() => computeOrderTotals({ lines, zone: null, vatRateBps: 750, pricesIncludeVat: false })).toThrow(
      /VAT-inclusive/,
    );
  });
});
