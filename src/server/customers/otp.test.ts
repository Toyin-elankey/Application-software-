import { describe, expect, it } from 'vitest';
import { digestsMatch, generateCode, hashCode, OTP_COOLDOWN_MS, OTP_MAX_ATTEMPTS, OTP_SENDS_PER_HOUR, OTP_TTL_MS } from './otp';
import { customerClearCookie, customerSetCookie, hashCustomerToken, newCustomerToken, readCookie } from './sessions';
import { PhoneSchema, OrderNumberSchema, OtpRequestSchema, OtpVerifySchema } from './schema';

const KEY = 'k'.repeat(32);
const TARGET = { businessId: '00000000-0000-4000-8000-000000000001', phoneE164: '+2348012345678', purpose: 'CUSTOMER_LOGIN' as const };

describe('OTP rules (FR-CUS-01)', () => {
  it('uses the agreed limits', () => {
    expect(OTP_TTL_MS).toBe(10 * 60 * 1000);
    expect(OTP_MAX_ATTEMPTS).toBe(5);
    expect(OTP_COOLDOWN_MS).toBe(60 * 1000);
    expect(OTP_SENDS_PER_HOUR).toBe(5);
  });

  it('generates six-digit zero-padded codes', () => {
    for (let i = 0; i < 2000; i++) {
      expect(generateCode()).toMatch(/^\d{6}$/);
    }
  });

  it('binds the hash to the code, phone, purpose and business', () => {
    const hash = hashCode(KEY, '123456', TARGET);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashCode(KEY, '123456', TARGET)).toBe(hash);
    expect(hashCode(KEY, '123457', TARGET)).not.toBe(hash);
    expect(hashCode(KEY, '123456', { ...TARGET, phoneE164: '+2348099999999' })).not.toBe(hash);
    expect(hashCode(KEY, '123456', { ...TARGET, purpose: 'ORDER_LOOKUP' })).not.toBe(hash);
    expect(hashCode(KEY, '123456', { ...TARGET, businessId: '00000000-0000-4000-8000-000000000002' })).not.toBe(hash);
    expect(hashCode('x'.repeat(32), '123456', TARGET)).not.toBe(hash);
  });

  it('compares digests in constant time and rejects mismatched lengths', () => {
    const a = hashCode(KEY, '000001', TARGET);
    expect(digestsMatch(a, a)).toBe(true);
    expect(digestsMatch(a, hashCode(KEY, '000002', TARGET))).toBe(false);
    expect(digestsMatch(a, a.slice(0, 10))).toBe(false);
  });
});

describe('customer session tokens and cookies', () => {
  it('stores only a SHA-256 of the token', () => {
    const token = newCustomerToken();
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(hashCustomerToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashCustomerToken(token)).not.toContain(token);
  });

  it('reads one named cookie and ignores malformed values', () => {
    const token = newCustomerToken();
    expect(readCookie(`a=1; customer_session=${token}; b=2`, 'customer_session')).toBe(token);
    expect(readCookie(`order_session=${token}`, 'customer_session')).toBeNull();
    expect(readCookie('customer_session=short', 'customer_session')).toBeNull();
    expect(readCookie('customer_session=bad value!', 'customer_session')).toBeNull();
    expect(readCookie(null, 'customer_session')).toBeNull();
  });

  it('sets HttpOnly and SameSite=Lax, and clears with Max-Age=0', () => {
    const set = customerSetCookie('customer_session', 'tok', 60);
    expect(set).toContain('customer_session=tok');
    expect(set).toContain('HttpOnly');
    expect(set).toContain('SameSite=Lax');
    expect(set).toContain('Max-Age=60');
    expect(customerClearCookie('customer_session')).toContain('Max-Age=0');
  });
});

describe('request and verify schemas', () => {
  it('accepts Nigerian E.164 numbers only', () => {
    expect(PhoneSchema.parse(' +2348012345678 ')).toBe('+2348012345678');
    expect(() => PhoneSchema.parse('08012345678')).toThrow();
    expect(() => PhoneSchema.parse('+23480123')).toThrow();
  });

  it('accepts order numbers in the ORD-260001 shape only', () => {
    expect(OrderNumberSchema.parse('ORD-260001')).toBe('ORD-260001');
    expect(() => OrderNumberSchema.parse("ORD-1' OR 1=1")).toThrow();
  });

  it('requires a purpose and rejects unknown fields', () => {
    expect(() => OtpRequestSchema.parse({ phoneE164: '+2348012345678' })).toThrow();
    expect(() => OtpRequestSchema.parse({ purpose: 'CUSTOMER_LOGIN', phoneE164: '+2348012345678', extra: 1 })).toThrow();
    expect(OtpRequestSchema.parse({ purpose: 'ORDER_LOOKUP', orderNumber: 'ORD-260001' })).toEqual({
      purpose: 'ORDER_LOOKUP',
      orderNumber: 'ORD-260001',
    });
  });

  it('requires exactly six digits to verify', () => {
    const base = { purpose: 'CUSTOMER_LOGIN', phoneE164: '+2348012345678' };
    expect(OtpVerifySchema.parse({ ...base, code: '012345' }).code).toBe('012345');
    expect(() => OtpVerifySchema.parse({ ...base, code: '12345' })).toThrow();
    expect(() => OtpVerifySchema.parse({ ...base, code: '12345a' })).toThrow();
  });
});
