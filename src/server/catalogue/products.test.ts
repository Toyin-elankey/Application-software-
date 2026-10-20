import { describe, expect, it } from 'vitest';
import { clampLimit } from './products';

describe('clampLimit', () => {
  it('defaults to 24 and caps at 100', () => {
    expect(clampLimit(undefined)).toBe(24);
    expect(clampLimit(500)).toBe(100);
    expect(clampLimit(10)).toBe(10);
  });

  it('rejects zero, negative and fractional limits', () => {
    expect(() => clampLimit(0)).toThrow(RangeError);
    expect(() => clampLimit(-1)).toThrow(RangeError);
    expect(() => clampLimit(2.5)).toThrow(RangeError);
  });
});
