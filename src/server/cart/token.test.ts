import { describe, expect, it } from 'vitest';
import { cartCookieHeader, hashCartToken, newCartToken, readCartToken } from './token';

describe('cart token', () => {
  it('generates distinct, URL-safe tokens of 256 bits', () => {
    const a = newCartToken();
    const b = newCartToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('hashes deterministically and never returns the token', () => {
    const token = newCartToken();
    expect(hashCartToken(token)).toBe(hashCartToken(token));
    expect(hashCartToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashCartToken(token)).not.toContain(token);
  });

  it('reads the cart cookie among other cookies', () => {
    const token = newCartToken();
    expect(readCartToken(`theme=dark; cart_token=${token}; other=1`)).toBe(token);
  });

  it.each([null, '', 'theme=dark', 'cart_token=short', 'cart_token=has spaces in it at all!!'])(
    'returns null for %j',
    (header) => {
      expect(readCartToken(header)).toBeNull();
    },
  );

  it('sets HttpOnly and SameSite, and Secure only when asked', () => {
    const insecure = cartCookieHeader('abc', false);
    expect(insecure).toContain('HttpOnly');
    expect(insecure).toContain('SameSite=Lax');
    expect(insecure).not.toContain('Secure');
    expect(cartCookieHeader('abc', true)).toContain('; Secure');
  });
});
