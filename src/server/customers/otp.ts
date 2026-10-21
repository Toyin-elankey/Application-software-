import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { getEnv } from '@/lib/env';
import { logger } from '@/lib/logger';
import { AppError } from '@/server/http/problem';
import type { OtpSender } from './delivery';

// One-time codes for customer sign-in and order lookup (FR-CUS-01, FR-CUS-03, 02 §8).
//
// Rules: 6 digits; valid 10 minutes; 5 attempts per code; 60 seconds between sends to the same phone
// and purpose; at most 5 sends per phone and purpose per hour. Codes are stored as HMAC-SHA256 under a
// server key, bound to the business, phone and purpose, so a copied hash is useless elsewhere.
//
// Requests never say whether a phone or order exists. When a send is refused by a limit or the target
// is unknown, the answer is the same 202 as a real send. Only a delivery failure is reported.

export const OTP_DIGITS = 6;
export const OTP_TTL_MS = 10 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_COOLDOWN_MS = 60 * 1000;
export const OTP_SENDS_PER_HOUR = 5;

export type OtpPurposeName = 'CUSTOMER_LOGIN' | 'ORDER_LOOKUP';

const DEV_KEY_MATERIAL = 'development-only-otp-hmac-key';

/** Returns the HMAC key. Production refuses to run without one; other environments use a development key. */
export function otpHmacKey(): string {
  const env = getEnv();
  if (env.OTP_HMAC_KEY) return env.OTP_HMAC_KEY;
  if (env.NODE_ENV === 'production') {
    throw new AppError(503, 'otp_not_configured', 'Sign-in codes are not configured yet.');
  }
  logger.warn({ msg: 'OTP_HMAC_KEY is not set; using a development-only key' });
  return DEV_KEY_MATERIAL;
}

/** A uniformly random 6-digit code, zero-padded. */
export function generateCode(): string {
  return randomInt(0, 10 ** OTP_DIGITS)
    .toString()
    .padStart(OTP_DIGITS, '0');
}

export type OtpTarget = { businessId: string; phoneE164: string; purpose: OtpPurposeName };

export function hashCode(key: string, code: string, target: OtpTarget): string {
  return createHmac('sha256', key).update(`${target.businessId}|${target.phoneE164}|${target.purpose}|${code}`).digest('hex');
}

/** Constant-time comparison of two hex digests. */
export function digestsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** The only error a wrong, expired, used or exhausted code produces. The message does not say which. */
export function invalidCode(): AppError {
  return new AppError(422, 'otp_invalid', 'That code is not correct or has expired. Request a new code and try again.');
}

export type OtpRequestResult = { accepted: true; expiresInSeconds: number };

/**
 * Creates a challenge and sends its code, unless a limit applies or the target is unknown. The caller
 * gets the same answer in every case. `resolvePhone` is where the code goes: the typed number for sign-in,
 * the phone on the order for lookup (FR-CUS-03).
 */
export async function requestOtp(
  db: PrismaClient,
  sender: OtpSender,
  input: { businessId: string; purpose: OtpPurposeName; phoneE164: string | null },
  options: { now?: Date; key?: string } = {},
): Promise<OtpRequestResult> {
  const now = options.now ?? new Date();
  // Read the key first, so a missing key fails the same way for every request, not only for known targets.
  const key = options.key ?? otpHmacKey();
  const answer: OtpRequestResult = { accepted: true, expiresInSeconds: OTP_TTL_MS / 1000 };
  if (!input.phoneE164) return answer;
  const target: OtpTarget = { businessId: input.businessId, phoneE164: input.phoneE164, purpose: input.purpose };

  // Check the limits and create the challenge under one lock, so two parallel requests cannot both pass.
  const issued = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`otp|${target.businessId}|${target.phoneE164}|${target.purpose}`}))`;
    const latest = await tx.otpChallenge.findFirst({
      where: { businessId: target.businessId, phoneE164: target.phoneE164, purpose: target.purpose },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    if (latest && now.getTime() - latest.createdAt.getTime() < OTP_COOLDOWN_MS) return null;

    const sent = await tx.otpChallenge.count({
      where: {
        businessId: target.businessId,
        phoneE164: target.phoneE164,
        purpose: target.purpose,
        createdAt: { gt: new Date(now.getTime() - 60 * 60 * 1000) },
      },
    });
    if (sent >= OTP_SENDS_PER_HOUR) return null;

    const code = generateCode();
    const challenge = await tx.otpChallenge.create({
      data: {
        businessId: target.businessId,
        phoneE164: target.phoneE164,
        purpose: target.purpose,
        codeHash: hashCode(key, code, target),
        maxAttempts: OTP_MAX_ATTEMPTS,
        expiresAt: new Date(now.getTime() + OTP_TTL_MS),
        createdAt: now,
      },
      select: { id: true },
    });
    return { id: challenge.id, code };
  });

  if (!issued) return answer;

  try {
    await sender.send({ phoneE164: target.phoneE164, code: issued.code, purpose: target.purpose });
  } catch (error) {
    // The code never left, so it must not stay usable. The customer can request again after the cooldown.
    await db.otpChallenge.delete({ where: { id: issued.id } }).catch(() => undefined);
    logger.error({ msg: 'OTP delivery failed', purpose: target.purpose, error: error instanceof Error ? error.name : 'unknown' });
    throw new AppError(503, 'otp_delivery_failed', 'We could not send the code just now. Please try again in a minute.');
  }
  return answer;
}

/**
 * Checks a submitted code against the newest unused challenge for the phone and purpose. Each submission
 * counts as an attempt, even a correct one. A code is consumed on success and cannot be used twice.
 */
export async function verifyOtp(
  db: PrismaClient,
  input: { businessId: string; purpose: OtpPurposeName; phoneE164: string; code: string },
  options: { now?: Date; key?: string } = {},
): Promise<{ challengeId: string }> {
  const now = options.now ?? new Date();
  const key = options.key ?? otpHmacKey();
  const target: OtpTarget = { businessId: input.businessId, phoneE164: input.phoneE164, purpose: input.purpose };

  const challenge = await db.otpChallenge.findFirst({
    where: { businessId: target.businessId, phoneE164: target.phoneE164, purpose: target.purpose, consumedAt: null },
    orderBy: { createdAt: 'desc' },
    select: { id: true, codeHash: true, attempts: true, maxAttempts: true, expiresAt: true },
  });
  if (!challenge || challenge.expiresAt <= now || challenge.attempts >= challenge.maxAttempts) throw invalidCode();

  // Count the attempt first, conditional on the value we read: parallel guesses cannot exceed the limit.
  const counted = await db.otpChallenge.updateMany({
    where: { id: challenge.id, consumedAt: null, attempts: challenge.attempts },
    data: { attempts: { increment: 1 } },
  });
  if (counted.count !== 1) throw invalidCode();

  if (!digestsMatch(hashCode(key, input.code, target), challenge.codeHash)) throw invalidCode();

  // Consume it. Only one caller can move consumedAt from null, so a correct code works once.
  const consumed = await db.otpChallenge.updateMany({
    where: { id: challenge.id, consumedAt: null },
    data: { consumedAt: now },
  });
  if (consumed.count !== 1) throw invalidCode();
  return { challengeId: challenge.id };
}
