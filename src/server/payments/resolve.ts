import { AppError } from '@/server/http/problem';
import { activePaymentProviderName, type PaymentProvider } from './provider';
import { mockPaymentProvider } from './mock';

export function getPaymentProvider(): PaymentProvider {
  let name;
  try {
    name = activePaymentProviderName();
  } catch (error) {
    // Not configured in production. Report it as unavailable, without exposing configuration detail.
    throw new AppError(503, 'payments_unavailable', 'Online payment is not available right now.', {}, { cause: error });
  }
  if (name === 'MOCK') return mockPaymentProvider();
  throw new AppError(503, 'payments_unavailable', 'Online payment is not available right now.');
}
