import { afterEach, describe, expect, it, vi } from 'vitest';

// The mock checkout is for development and CI only. getEnv() caches its result, so each case loads
// a fresh module graph with its own environment.
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('mock payment guard', () => {
  it('is available in development, where the mock is the active provider', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const mod = await import('./mockPay');
    expect(() => mod.assertMockPaymentsEnabled()).not.toThrow();
  });

  it('returns 404 in production, with no provider configured', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('APP_BASE_URL', 'https://shop.example.com');
    delete process.env.PAYMENT_PROVIDER; // unset, not empty: the schema rejects an empty provider
    const mod = await import('./mockPay');
    const { AppError } = await import('@/server/http/problem');
    let caught: unknown;
    try {
      mod.assertMockPaymentsEnabled();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as InstanceType<typeof AppError>).status).toBe(404);
  });
});
