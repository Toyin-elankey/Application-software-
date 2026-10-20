import { getEnv } from '@/lib/env';

// Payment provider contract (06 §2). Domain code uses only this interface. Provider payload shapes
// are mapped inside each adapter. Stage 4 adds the Paystack adapter; FLUTTERWAVE is post-MVP.

export type ProviderName = 'MOCK' | 'PAYSTACK';

export type InitializeInput = {
  reference: string;
  amountMinor: bigint;
  currency: 'NGN';
  email: string;
  callbackUrl: string;
  metadata: { businessId: string; orderId: string; orderNumber: string };
};

export type VerifiedTransaction = {
  reference: string;
  providerTransactionId: string;
  status: 'SUCCESS' | 'FAILED' | 'ABANDONED' | 'PENDING';
  amountMinor: bigint;
  currency: string;
  channel?: string;
  paidAt?: Date;
};

export interface PaymentProvider {
  readonly name: ProviderName;
  initialize(input: InitializeInput): Promise<{ authorizationUrl: string; providerReference: string }>;
  verify(reference: string): Promise<VerifiedTransaction>;
}

/**
 * The provider in use. Development and tests get the mock. Production must name a real provider in
 * PAYMENT_PROVIDER; none exists before Stage 4, so production payment code fails here, on use.
 */
export function activePaymentProviderName(): ProviderName {
  const env = getEnv();
  if (env.PAYMENT_PROVIDER) return env.PAYMENT_PROVIDER;
  if (env.NODE_ENV === 'production') {
    throw new Error('PAYMENT_PROVIDER is not configured; no live payment provider exists in this build');
  }
  return 'MOCK';
}
