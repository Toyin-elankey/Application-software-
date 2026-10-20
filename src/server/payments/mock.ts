import { getEnv } from '@/lib/env';
import type { InitializeInput, PaymentProvider, VerifiedTransaction } from './provider';

// Mock provider for development, CI and demos (06 §1). Same interface as the real adapters, so the
// confirmation path is the same code. Outcomes are simulated in process memory: they are not
// persisted, and they do not survive a restart. The simulator refuses to run in production.

type Record = {
  amountMinor: bigint;
  currency: string;
  outcome: 'PENDING' | 'SUCCESS' | 'FAILED' | 'ABANDONED';
  providerTransactionId: string;
};

export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'MOCK' as const;
  private readonly records = new Map<string, Record>();

  async initialize(input: InitializeInput) {
    this.records.set(input.reference, {
      amountMinor: input.amountMinor,
      currency: input.currency,
      outcome: 'PENDING',
      providerTransactionId: `mock_txn_${input.reference}`,
    });
    const base = getEnv().APP_BASE_URL.replace(/\/$/, '');
    return {
      authorizationUrl: `${base}/dev/mock-pay/${encodeURIComponent(input.reference)}`,
      providerReference: `mock_${input.reference}`,
    };
  }

  async verify(reference: string): Promise<VerifiedTransaction> {
    const record = this.records.get(reference);
    if (!record) throw new Error(`mock provider has no transaction for reference ${reference}`);
    return {
      reference,
      providerTransactionId: record.providerTransactionId,
      status: record.outcome,
      amountMinor: record.amountMinor,
      currency: record.currency,
      channel: 'mock',
    };
  }

  /** Test and demo control: decide what the next verification reports. */
  simulate(reference: string, outcome: Exclude<Record['outcome'], 'PENDING'>): void {
    if (getEnv().NODE_ENV === 'production') throw new Error('the mock payment simulator is disabled in production');
    const record = this.records.get(reference);
    if (!record) throw new Error(`mock provider has no transaction for reference ${reference}`);
    record.outcome = outcome;
  }
}

// One simulator per server process. It lives on globalThis because Next.js can load the checkout
// route and the mock-pay route as separate module graphs, and they must share the same records.
const globalForMock = globalThis as typeof globalThis & { __mockPaymentProvider?: MockPaymentProvider };

export function mockPaymentProvider(): MockPaymentProvider {
  globalForMock.__mockPaymentProvider ??= new MockPaymentProvider();
  return globalForMock.__mockPaymentProvider;
}
