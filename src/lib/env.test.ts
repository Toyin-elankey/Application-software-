import { describe, expect, it } from 'vitest';
import { parseEnv } from './env';

describe('parseEnv', () => {
  it('applies defaults when optional variables are missing', () => {
    const env = parseEnv({});
    expect(env).toEqual({
      NODE_ENV: 'development',
      APP_BASE_URL: 'http://localhost:3000',
      LOG_LEVEL: 'info',
    });
  });

  it('accepts a valid configuration', () => {
    const env = parseEnv({
      NODE_ENV: 'production',
      APP_BASE_URL: 'https://shop.example.com',
      LOG_LEVEL: 'warn',
      DATABASE_URL: 'postgresql://user:pw@db:5432/app',
    });
    expect(env.LOG_LEVEL).toBe('warn');
  });

  it('rejects an APP_BASE_URL that is not an absolute URL', () => {
    expect(() => parseEnv({ APP_BASE_URL: 'shop.example.com' })).toThrow(/APP_BASE_URL/);
  });

  it('requires https in production for any host other than localhost', () => {
    expect(() =>
      parseEnv({ NODE_ENV: 'production', APP_BASE_URL: 'http://shop.example.com' }),
    ).toThrow(/must use https in production/);
  });

  it('allows http://localhost in production so the production build runs locally', () => {
    const env = parseEnv({ NODE_ENV: 'production', APP_BASE_URL: 'http://localhost:3000' });
    expect(env.APP_BASE_URL).toBe('http://localhost:3000');
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(() => parseEnv({ NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });

  it('never echoes a secret value in the error message', () => {
    const secret = 'super-secret-value-123';
    try {
      parseEnv({ APP_BASE_URL: 'not-a-url', DATABASE_URL: secret, LOG_LEVEL: secret });
      expect.unreachable('parseEnv should have thrown');
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });
});
