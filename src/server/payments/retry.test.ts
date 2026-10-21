import { describe, expect, it } from 'vitest';
import { planRetry } from './retry';

describe('planRetry (06 §3, §4.1)', () => {
  it('creates a payment when the order has none, or only failed and abandoned ones', () => {
    expect(planRetry([])).toEqual({ kind: 'create' });
    expect(planRetry([{ id: 'a', status: 'FAILED' }])).toEqual({ kind: 'create' });
    expect(planRetry([{ id: 'b', status: 'FAILED' }, { id: 'a', status: 'ABANDONED' }])).toEqual({ kind: 'create' });
  });

  it('resumes an open payment rather than opening a second one', () => {
    expect(planRetry([{ id: 'new', status: 'INITIALIZED' }, { id: 'old', status: 'FAILED' }])).toEqual({ kind: 'resume', paymentId: 'new' });
    expect(planRetry([{ id: 'p', status: 'PENDING' }])).toEqual({ kind: 'resume', paymentId: 'p' });
  });

  it('refuses when the order is already paid, even if another payment is open', () => {
    expect(planRetry([{ id: 'open', status: 'PENDING' }, { id: 'paid', status: 'SUCCEEDED' }])).toEqual({ kind: 'paid' });
  });
});
