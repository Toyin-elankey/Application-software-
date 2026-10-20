import { createHash, randomBytes } from 'node:crypto';

// Anonymous cart identity (FR-CART-01). The browser holds a random token in a cookie; the database
// stores only its SHA-256 hash, so a database leak does not reveal a usable cart cookie.

export const CART_COOKIE = 'cart_token';
export const CART_TTL_DAYS = 14;

export function newCartToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashCartToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Reads the cart cookie from a Cookie header. Returns null when absent or malformed. */
export function readCartToken(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === CART_COOKIE) {
      const value = rest.join('=');
      return /^[A-Za-z0-9_-]{20,128}$/.test(value) ? value : null;
    }
  }
  return null;
}

export function cartCookieHeader(token: string, secure: boolean): string {
  const maxAge = CART_TTL_DAYS * 24 * 60 * 60;
  return [
    `${CART_COOKIE}=${token}`,
    'Path=/',
    `Max-Age=${maxAge}`,
    'HttpOnly',
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}
