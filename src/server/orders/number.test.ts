import { describe, expect, it } from 'vitest';
import { formatOrderNumber } from './number';

describe('formatOrderNumber', () => {
  const date = new Date('2026-10-20T10:00:00Z');

  it.each([
    [1, 'ORD-260001'],
    [42, 'ORD-260042'],
    [9999, 'ORD-269999'],
    [10000, 'ORD-2610000'],
  ])('sequence %s is %s', (sequence, expected) => {
    expect(formatOrderNumber('ORD', date, sequence)).toBe(expected);
  });

  it('uses the configured prefix', () => {
    expect(formatOrderNumber('SHOP', date, 7)).toBe('SHOP-260007');
  });

  it('rejects a non-positive or fractional sequence', () => {
    expect(() => formatOrderNumber('ORD', date, 0)).toThrow(RangeError);
    expect(() => formatOrderNumber('ORD', date, 1.5)).toThrow(RangeError);
  });
});
