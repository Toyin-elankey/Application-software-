import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { getEnv } from '@/lib/env';
import { logger } from '@/lib/logger';

// TOTP (RFC 6238 with HMAC-SHA1, 6 digits, 30-second steps) for admin MFA (PRD §4.1, 02 §8).
// Secrets are encrypted at rest with AES-256-GCM. The key comes from SESSION_ENCRYPTION_KEY through
// HKDF, so the raw key is never used directly.

const STEP_SECONDS = 30;
const DIGITS = 6;
export const TOTP_WINDOW = 1; // accept one step either side for clock drift

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/=+$/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new RangeError('invalid base32 character');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function newTotpSecret(): Buffer {
  return randomBytes(20);
}

/** The RFC 6238 counter-based code for one time step. */
export function totpAt(secret: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', secret).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) | ((digest[offset + 1] & 0xff) << 16) | ((digest[offset + 2] & 0xff) << 8) | (digest[offset + 3] & 0xff);
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

export function timeStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / STEP_SECONDS);
}

/**
 * Returns the matched time step if the code is valid within the window and after `lastUsedStep`,
 * otherwise null. A step can be used once: a replayed code fails.
 */
export function matchTotp(secret: Buffer, code: string, nowMs: number, lastUsedStep: number | null): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = timeStep(nowMs);
  for (let offset = -TOTP_WINDOW; offset <= TOTP_WINDOW; offset++) {
    const step = current + offset;
    if (lastUsedStep !== null && step <= lastUsedStep) continue;
    const expected = Buffer.from(totpAt(secret, step));
    if (expected.length === code.length && timingSafeEqual(expected, Buffer.from(code))) return step;
  }
  return null;
}

export function otpauthUri(secret: Buffer, accountEmail: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${accountEmail}`);
  return `otpauth://totp/${label}?secret=${base32Encode(secret)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

// ---- encryption at rest ----

const DEV_KEY_MATERIAL = 'development-only-session-encryption-key';

function encryptionKey(): Buffer {
  const env = getEnv();
  let material = env.SESSION_ENCRYPTION_KEY;
  if (!material) {
    if (env.NODE_ENV === 'production') throw new Error('SESSION_ENCRYPTION_KEY is not set');
    logger.warn({ msg: 'SESSION_ENCRYPTION_KEY is not set; using a development-only key' });
    material = DEV_KEY_MATERIAL;
  }
  return Buffer.from(hkdfSync('sha256', material, Buffer.alloc(0), 'staff-mfa-secret-v1', 32));
}

/** Returns base64(iv || tag || ciphertext). */
export function encryptSecret(plain: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

/** Throws if the value was tampered with or the key is wrong. */
export function decryptSecret(stored: string): Buffer {
  const raw = Buffer.from(stored, 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const body = raw.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}
