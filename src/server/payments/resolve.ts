import { AppError } from '@/server/http/problem';
import { activePaymentProviderName, type PaymentProvider } from './provider';
import { mockPaymentProvider } from './mock';
import { paystackProviderFromEnv } from './paystack';

export function getPaymentProvider(): PaymentProvider {
  let name;
  try {
    name = activePaymentProviderName();
  } catch (error) {
    // Not configured in production. Report it as unavailable, without exposing configuration detail.
    throw new AppError(503, 'payments_unavailable', 'Online payment is not available right now.', {}, { cause: error });
  }
  if (name === 'MOCK') return mockPaymentProvider();
  if (name === 'PAYSTACK') {
    try {
      return paystackProviderFromEnv();
    } catch (error) {
      throw new AppError(503, 'payments_unavailable', 'Online payment is not available right now.', {}, { cause: error });
    }
  }
  throw new AppError(503, 'payments_unavailable', 'Online payment is not available right now.');
}
