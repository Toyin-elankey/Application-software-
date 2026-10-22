import { describe, expect, it } from 'vitest';
import { clientMeta, rightmostForwardedIp } from './guard';

describe('rightmostForwardedIp', () => {
  it('takes the rightmost entry, the one the nearest proxy saw, not a value the client sent', () => {
    expect(rightmostForwardedIp('203.0.113.99, 198.51.100.7')).toBe('198.51.100.7');
    expect(rightmostForwardedIp('198.51.100.7')).toBe('198.51.100.7');
    expect(rightmostForwardedIp('  198.51.100.7 ,  10.0.0.2  ')).toBe('10.0.0.2');
  });

  it('returns null when there is no usable address', () => {
    expect(rightmostForwardedIp(null)).toBeNull();
    expect(rightmostForwardedIp('')).toBeNull();
    expect(rightmostForwardedIp(' , ')).toBeNull();
  });

  it('caps the length of what it returns', () => {
    expect(rightmostForwardedIp('x'.repeat(200))).toHaveLength(64);
  });
});

describe('clientMeta', () => {
  it('reads the rightmost forwarded address and the user agent', () => {
    const request = new Request('http://localhost/x', { headers: { 'x-forwarded-for': '203.0.113.99, 198.51.100.7', 'user-agent': 'test-agent' } });
    expect(clientMeta(request)).toEqual({ ip: '198.51.100.7', userAgent: 'test-agent' });
  });

  it('has no address when the header is absent', () => {
    expect(clientMeta(new Request('http://localhost/x')).ip).toBeNull();
  });
});
