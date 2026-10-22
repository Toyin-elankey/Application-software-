import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requestOtp, verifyOtp, OTP_IP_SENDS_PER_HOUR, OTP_IP_VERIFIES_PER_WINDOW, OTP_IP_VERIFY_WINDOW_MS } from '@/server/customers/otp';
import type { OtpMessage, OtpSender } from '@/server/customers/delivery';
import { consumeRateLimit, rateBucket } from '@/server/http/ratelimit';
import { AppError } from '@/server/http/problem';
import { createPrisma } from './helpers';
import { createStore } from './commerce-fixtures';

// Per-IP limits (02 §8) against a real PostgreSQL database. Every call passes `now`, so windows are tested
// without waiting.

let db: PrismaClient;
const T0 = new Date('2026-10-22T10:00:00Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const MINUTE = 60 * 1000;

class CaptureSender implements OtpSender {
  readonly sent: OtpMessage[] = [];
  async send(message: OtpMessage): Promise<void> {
    this.sent.push(message);
  }
}

function phone(index: number): string {
  return `+234801${String(1000000 + index).padStart(7, '0')}`;
}

beforeAll(() => {
  db = createPrisma();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('consumeRateLimit', () => {
  it('allows the limit within the window, refuses the next, and allows again once the window has passed', async () => {
    const store = await createStore(db);
    const bucket = rateBucket(store.businessId, 'test', '198.51.100.1');
    const check = (ms: number) => consumeRateLimit(db, { businessId: store.businessId, bucket, limit: 3, windowMs: 10 * MINUTE, now: at(ms) });

    expect([await check(0), await check(1000), await check(2000)]).toEqual([true, true, true]);
    expect(await check(3000)).toBe(false);
    expect(await check(9 * MINUTE)).toBe(false); // the first event is still inside the window
    expect(await check(10 * MINUTE + 1000)).toBe(true); // the first event has aged out
  });

  it('lets exactly the limit through when many requests arrive at once', async () => {
    const store = await createStore(db);
    const bucket = rateBucket(store.businessId, 'race', '198.51.100.2');
    const results = await Promise.all(
      Array.from({ length: 10 }, () => consumeRateLimit(db, { businessId: store.businessId, bucket, limit: 3, windowMs: 60 * MINUTE, now: at(0) })),
    );
    expect(results.filter(Boolean)).toHaveLength(3);
    expect(await db.rateLimitEvent.count({ where: { bucket } })).toBe(3);
  });

  it('keeps buckets apart: one IP over its limit does not affect another', async () => {
    const store = await createStore(db);
    const busy = rateBucket(store.businessId, 'iso', '198.51.100.3');
    const quiet = rateBucket(store.businessId, 'iso', '198.51.100.4');
    expect(await consumeRateLimit(db, { businessId: store.businessId, bucket: busy, limit: 1, windowMs: MINUTE, now: at(0) })).toBe(true);
    expect(await consumeRateLimit(db, { businessId: store.businessId, bucket: busy, limit: 1, windowMs: MINUTE, now: at(1) })).toBe(false);
    expect(await consumeRateLimit(db, { businessId: store.businessId, bucket: quiet, limit: 1, windowMs: MINUTE, now: at(1) })).toBe(true);
  });

  it('refused calls are not recorded, so a blocked caller does not extend its own block', async () => {
    const store = await createStore(db);
    const bucket = rateBucket(store.businessId, 'refused', '198.51.100.5');
    await consumeRateLimit(db, { businessId: store.businessId, bucket, limit: 1, windowMs: 10 * MINUTE, now: at(0) });
    for (let i = 1; i <= 5; i++) {
      expect(await consumeRateLimit(db, { businessId: store.businessId, bucket, limit: 1, windowMs: 10 * MINUTE, now: at(i * 1000) })).toBe(false);
    }
    expect(await db.rateLimitEvent.count({ where: { bucket } })).toBe(1);
    expect(await consumeRateLimit(db, { businessId: store.businessId, bucket, limit: 1, windowMs: 10 * MINUTE, now: at(10 * MINUTE + 1) })).toBe(true);
  });
});

describe('per-IP OTP send limit', () => {
  it('sends for the first requests from one IP, then answers the same and sends nothing', async () => {
    const store = await createStore(db);
    const sender = new CaptureSender();
    const ip = '198.51.100.10';
    const answers = [];
    for (let i = 0; i < OTP_IP_SENDS_PER_HOUR + 1; i++) {
      answers.push(await requestOtp(db, sender, { businessId: store.businessId, purpose: 'CUSTOMER_LOGIN', phoneE164: phone(i), ip }, { now: at(i * 1000) }));
    }
    expect(sender.sent).toHaveLength(OTP_IP_SENDS_PER_HOUR);
    // The refused request answers exactly as a sent one does.
    expect(answers[OTP_IP_SENDS_PER_HOUR]).toEqual(answers[0]);
    expect(await db.otpChallenge.count({ where: { phoneE164: phone(OTP_IP_SENDS_PER_HOUR) } })).toBe(0);
  });

  it('counts requests to unknown and known numbers alike, and recovers after the hour', async () => {
    const store = await createStore(db);
    const sender = new CaptureSender();
    const ip = '198.51.100.11';
    for (let i = 0; i < OTP_IP_SENDS_PER_HOUR; i++) {
      await requestOtp(db, sender, { businessId: store.businessId, purpose: 'CUSTOMER_LOGIN', phoneE164: i % 2 ? null : phone(i), ip }, { now: at(i) });
    }
    await requestOtp(db, sender, { businessId: store.businessId, purpose: 'CUSTOMER_LOGIN', phoneE164: phone(99), ip }, { now: at(MINUTE) });
    expect(sender.sent).toHaveLength(OTP_IP_SENDS_PER_HOUR - Math.floor(OTP_IP_SENDS_PER_HOUR / 2));
    expect(await db.otpChallenge.count({ where: { phoneE164: phone(99) } })).toBe(0);

    await requestOtp(db, sender, { businessId: store.businessId, purpose: 'CUSTOMER_LOGIN', phoneE164: phone(100), ip }, { now: at(61 * MINUTE) });
    expect(await db.otpChallenge.count({ where: { phoneE164: phone(100) } })).toBe(1);
  });

  it('without an IP there is no per-IP limit (the normal per-phone rules still apply)', async () => {
    const store = await createStore(db);
    const sender = new CaptureSender();
    for (let i = 0; i < OTP_IP_SENDS_PER_HOUR + 5; i++) {
      await requestOtp(db, sender, { businessId: store.businessId, purpose: 'CUSTOMER_LOGIN', phoneE164: phone(i), ip: null }, { now: at(i) });
    }
    expect(sender.sent).toHaveLength(OTP_IP_SENDS_PER_HOUR + 5);
  });
});

describe('per-IP OTP verify limit', () => {
  it('refuses attempts from one IP past the limit as invalid codes, without touching the challenge', async () => {
    const store = await createStore(db);
    const ip = '198.51.100.20';
    const sender = new CaptureSender();
    // Six numbers, each with a code issued at T0 (no IP, so sending is not limited here).
    const numbers = Array.from({ length: 7 }, (_, i) => phone(500 + i));
    for (const number of numbers) {
      await requestOtp(db, sender, { businessId: store.businessId, purpose: 'CUSTOMER_LOGIN', phoneE164: number }, { now: T0 });
    }
    const codes = new Map(sender.sent.map((m) => [m.phoneE164, m.code]));
    const wrong = (code: string) => (code === '000000' ? '111111' : '000000');

    // Five wrong attempts on each of the first six numbers: 30 attempts from this IP.
    for (const number of numbers.slice(0, 6)) {
      for (let i = 0; i < 5; i++) {
        await expect(
          verifyOtp(db, { businessId: store.businessId, purpose: 'CUSTOMER_LOGIN', phoneE164: number, code: wrong(codes.get(number) as string), ip }, { now: at(1000 * i) }),
        ).rejects.toBeInstanceOf(AppError);
      }
    }
    expect(OTP_IP_VERIFIES_PER_WINDOW).toBe(30);

    // The 31st attempt is the right code for the seventh number. It is refused, and that code is untouched.
    const seventh = numbers[6];
    await expect(
      verifyOtp(db, { businessId: store.businessId, purpose: 'CUSTOMER_LOGIN', phoneE164: seventh, code: codes.get(seventh) as string, ip }, { now: at(40_000) }),
    ).rejects.toMatchObject({ status: 422, code: 'otp_invalid' });
    const challenge = await db.otpChallenge.findFirstOrThrow({ where: { phoneE164: seventh }, orderBy: { createdAt: 'desc' } });
    expect(challenge).toMatchObject({ attempts: 0, consumedAt: null });

    // Another address is not affected.
    await expect(
      verifyOtp(db, { businessId: store.businessId, purpose: 'CUSTOMER_LOGIN', phoneE164: seventh, code: codes.get(seventh) as string, ip: '198.51.100.21' }, { now: at(41_000) }),
    ).resolves.toMatchObject({});
  });

  it('allows the same IP again once the window has passed (a fresh code, since the first one expired)', async () => {
    const store = await createStore(db);
    const ip = '198.51.100.22';
    const sender = new CaptureSender();
    const number = phone(900);
    // Exhaust the window with wrong attempts against an unrelated number from this IP.
    const other = phone(901);
    await requestOtp(db, sender, { businessId: store.businessId, purpose: 'CUSTOMER_LOGIN', phoneE164: other }, { now: T0 });
    for (let i = 0; i < OTP_IP_VERIFIES_PER_WINDOW; i++) {
      await verifyOtp(db, { businessId: store.businessId, purpose: 'CUSTOMER_LOGIN', phoneE164: other, code: '000000', ip }, { now: at(i) }).catch(() => undefined);
    }
    // A code issued just before the window ends. The first attempts in the window still count, so this is refused.
    await requestOtp(db, sender, { businessId: store.businessId, purpose: 'CUSTOMER_LOGIN', phoneE164: number }, { now: at(OTP_IP_VERIFY_WINDOW_MS - MINUTE) });
    const fresh = sender.sent.at(-1)?.code as string;
    await expect(
      verifyOtp(db, { businessId: store.businessId, purpose: 'CUSTOMER_LOGIN', phoneE164: number, code: fresh, ip }, { now: at(OTP_IP_VERIFY_WINDOW_MS - 30_000) }),
    ).rejects.toMatchObject({ code: 'otp_invalid' });
    // After the window, the same code works.
    await expect(
      verifyOtp(db, { businessId: store.businessId, purpose: 'CUSTOMER_LOGIN', phoneE164: number, code: fresh, ip }, { now: at(OTP_IP_VERIFY_WINDOW_MS + 1000) }),
    ).resolves.toMatchObject({});
  });
});
