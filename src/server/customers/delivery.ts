import { appendFile } from 'node:fs/promises';
import type { OtpPurposeName } from './otp';
import { getEnv } from '@/lib/env';
import { AppError } from '@/server/http/problem';

// Delivers one-time codes. The production channel is the WhatsApp authentication template (05 §1.5), which
// is drafted but not approved by Meta, so there is no production sender yet and OTP requests answer 503.
// Until then, development and tests use the mock below.

export type OtpMessage = { phoneE164: string; code: string; purpose: OtpPurposeName };

export interface OtpSender {
  send(message: OtpMessage): Promise<void>;
}

/**
 * Development and test only. It never logs the code. With OTP_MOCK_OUTBOX_FILE set it appends one JSON
 * line per code so a tester can finish a sign-in. Production refuses this configuration (see env.ts).
 */
export class MockOtpSender implements OtpSender {
  constructor(private readonly outboxFile: string | undefined) {}

  async send(message: OtpMessage): Promise<void> {
    if (!this.outboxFile) return;
    const line = JSON.stringify({ at: new Date().toISOString(), ...message }) + '\n';
    await appendFile(this.outboxFile, line, { encoding: 'utf8', mode: 0o600 });
  }
}

export function getOtpSender(): OtpSender {
  const env = getEnv();
  const mockAllowed = env.OTP_DELIVERY === 'MOCK' || (env.OTP_DELIVERY === undefined && env.NODE_ENV !== 'production');
  if (mockAllowed) return new MockOtpSender(env.OTP_MOCK_OUTBOX_FILE);
  throw new AppError(503, 'otp_delivery_unavailable', 'Sign-in codes are not available right now. Please try again later.');
}
