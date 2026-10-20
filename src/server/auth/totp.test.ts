import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, decryptSecret, encryptSecret, matchTotp, totpAt } from './totp';

// RFC 6238 Appendix B, SHA-1, secret "12345678901234567890". The RFC lists 8-digit codes; these are the
// same codes truncated to 6 digits, which is what authenticator apps show.
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');
const RFC_VECTORS: [number, string][] = [
  [59, '287082'],
  [1111111109, '081804'],
  [1111111111, '050471'],
  [1234567890, '005924'],
  [2000000000, '279037'],
  [20000000000, '353130'],
];

describe('TOTP (RFC 6238)', () => {
  for (const [time, code] of RFC_VECTORS) {
    it(`produces ${code} at T=${time}`, () => {
      expect(totpAt(RFC_SECRET, Math.floor(time / 30))).toBe(code);
    });
  }

  it('accepts the current code and one step either side', () => {
    const now = 1111111111_000;
    const step = Math.floor(now / 30_000);
    expect(matchTotp(RFC_SECRET, totpAt(RFC_SECRET, step - 1), now, null)).toBe(step - 1);
    expect(matchTotp(RFC_SECRET, totpAt(RFC_SECRET, step + 1), now, null)).toBe(step + 1);
  });

  it('rejects a code two steps away', () => {
    const now = 1111111111_000;
    const step = Math.floor(now / 30_000);
    expect(matchTotp(RFC_SECRET, totpAt(RFC_SECRET, step + 2), now, null)).toBeNull();
  });

  it('a code can be used once: the same step, or an earlier one, is refused after it is accepted', () => {
    const now = 1111111111_000;
    const step = Math.floor(now / 30_000);
    const code = totpAt(RFC_SECRET, step);
    expect(matchTotp(RFC_SECRET, code, now, step - 1)).toBe(step);
    expect(matchTotp(RFC_SECRET, code, now, step)).toBeNull();
  });

  it('refuses anything that is not six digits', () => {
    expect(matchTotp(RFC_SECRET, '12345', 59_000, null)).toBeNull();
    expect(matchTotp(RFC_SECRET, 'abcdef', 59_000, null)).toBeNull();
  });
});

describe('base32', () => {
  it('round-trips and matches the RFC 4648 example', () => {
    expect(base32Encode(Buffer.from('foobar', 'ascii'))).toBe('MZXW6YTBOI');
    expect(base32Decode('MZXW6YTBOI').toString('ascii')).toBe('foobar');
    expect(base32Decode(base32Encode(RFC_SECRET)).equals(RFC_SECRET)).toBe(true);
  });
});

describe('secret encryption at rest', () => {
  it('round-trips, and a tampered value is refused', () => {
    const stored = encryptSecret(RFC_SECRET);
    expect(stored).not.toContain(RFC_SECRET.toString('base64'));
    expect(decryptSecret(stored).equals(RFC_SECRET)).toBe(true);

    const raw = Buffer.from(stored, 'base64');
    raw[raw.length - 1] ^= 0x01;
    expect(() => decryptSecret(raw.toString('base64'))).toThrow();
  });

  it('uses a fresh nonce each time', () => {
    expect(encryptSecret(RFC_SECRET)).not.toBe(encryptSecret(RFC_SECRET));
  });
});
