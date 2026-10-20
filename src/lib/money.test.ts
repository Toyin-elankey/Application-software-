import { describe, expect, it } from 'vitest';
import { formatNaira } from './money';

describe('formatNaira', () => {
  it.each([
    [0n, '₦0.00'],
    [5n, '₦0.05'],
    [150000n, '₦1,500.00'],
    [1250000n, '₦12,500.00'],
    [123456789012n, '₦1,234,567,890.12'],
    [-150000n, '-₦1,500.00'],
  ])('formats %s kobo as %s', (minor, expected) => {
    expect(formatNaira(minor)).toBe(expected);
  });
});
