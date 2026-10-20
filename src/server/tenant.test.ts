import { describe, expect, it } from 'vitest';
import { tenantScope } from './tenant';

describe('tenantScope', () => {
  it('accepts a UUID business id', () => {
    expect(tenantScope('3f1c6a52-0d7e-4b8e-9d1a-2b3c4d5e6f70').businessId).toBe(
      '3f1c6a52-0d7e-4b8e-9d1a-2b3c4d5e6f70',
    );
  });

  it('rejects a missing business id, so no query can run without a tenant', () => {
    expect(() => tenantScope(undefined)).toThrow();
    expect(() => tenantScope('')).toThrow();
  });

  it('rejects a value that is not a UUID', () => {
    expect(() => tenantScope('sample-brand')).toThrow(/businessId must be a UUID/);
  });
});
