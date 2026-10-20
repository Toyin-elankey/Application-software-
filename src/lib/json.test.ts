import { describe, expect, it } from 'vitest';
import { stringifyJson, toJsonSafe } from './json';

describe('toJsonSafe', () => {
  it('turns BigInt money into exact decimal strings', () => {
    expect(toJsonSafe({ priceMinor: 1500000n })).toEqual({ priceMinor: '1500000' });
  });

  it('keeps values above Number.MAX_SAFE_INTEGER exact', () => {
    const big = 9007199254740993n; // 2^53 + 1, not representable as a Number
    expect(toJsonSafe({ amount: big })).toEqual({ amount: '9007199254740993' });
  });

  it('handles nested arrays and objects', () => {
    expect(toJsonSafe({ items: [{ lineTotalMinor: 2n }, { lineTotalMinor: 3n }] })).toEqual({
      items: [{ lineTotalMinor: '2' }, { lineTotalMinor: '3' }],
    });
  });

  it('leaves dates, null, numbers and strings unchanged', () => {
    const date = new Date('2026-10-20T00:00:00.000Z');
    expect(toJsonSafe({ at: date, n: null, count: 3, name: 'x' })).toEqual({ at: date, n: null, count: 3, name: 'x' });
  });
});

describe('stringifyJson', () => {
  it('serialises a payload that contains BigInt values', () => {
    expect(stringifyJson({ totalMinor: 4500000n })).toBe('{"totalMinor":"4500000"}');
  });

  it('fails the way plain JSON.stringify does when BigInt is not converted', () => {
    expect(() => JSON.stringify({ totalMinor: 1n })).toThrow(TypeError);
  });
});
