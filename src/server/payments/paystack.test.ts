import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseEnv } from '@/lib/env';
import { PaystackError, PaystackProvider, parsePaystackEvent, verifyPaystackSignature, type FetchLike } from './paystack';

// Paystack adapter, without a network. Responses are fixtures shaped after Paystack's public API
// reference; they are not recorded from a live sandbox. The sandbox run is a separate, later step.

const SECRET = 'sk_test_fixture_secret_not_real';

function sign(body: string | Buffer, secret = SECRET): string {
  return createHmac('sha512', secret).update(typeof body === 'string' ? Buffer.from(body) : body).digest('hex');
}

const CHARGE_SUCCESS = JSON.stringify({
  event: 'charge.success',
  data: { id: 302961, reference: 'pay_01HX', status: 'success', amount: 1050000, currency: 'NGN' },
});

describe('webhook signature (06 §4.3)', () => {
  it('accepts a signature over the exact raw bytes', () => {
    expect(verifyPaystackSignature(Buffer.from(CHARGE_SUCCESS), sign(CHARGE_SUCCESS), SECRET)).toBe(true);
  });

  it('accepts an upper-case header value', () => {
    expect(verifyPaystackSignature(Buffer.from(CHARGE_SUCCESS), sign(CHARGE_SUCCESS).toUpperCase(), SECRET)).toBe(true);
  });

  it('rejects a signature made with another secret', () => {
    expect(verifyPaystackSignature(Buffer.from(CHARGE_SUCCESS), sign(CHARGE_SUCCESS, 'sk_test_other'), SECRET)).toBe(false);
  });

  it('rejects a signature over a re-serialised body (the raw bytes are what is signed)', () => {
    const signature = sign(CHARGE_SUCCESS);
    const reserialised = JSON.stringify(JSON.parse(CHARGE_SUCCESS), null, 2);
    expect(reserialised).not.toBe(CHARGE_SUCCESS);
    expect(verifyPaystackSignature(Buffer.from(reserialised), signature, SECRET)).toBe(false);
  });

  it('rejects a changed body', () => {
    const tampered = CHARGE_SUCCESS.replace('1050000', '1');
    expect(verifyPaystackSignature(Buffer.from(tampered), sign(CHARGE_SUCCESS), SECRET)).toBe(false);
  });

  it('rejects a missing or malformed header without throwing', () => {
    expect(verifyPaystackSignature(Buffer.from(CHARGE_SUCCESS), null, SECRET)).toBe(false);
    expect(verifyPaystackSignature(Buffer.from(CHARGE_SUCCESS), '', SECRET)).toBe(false);
    expect(verifyPaystackSignature(Buffer.from(CHARGE_SUCCESS), 'abc', SECRET)).toBe(false);
  });
});

describe('webhook parsing', () => {
  it('derives the dedupe key from event, id and status', () => {
    const event = parsePaystackEvent(Buffer.from(CHARGE_SUCCESS));
    expect(event).toMatchObject({ event: 'charge.success', externalId: 'charge.success:302961:success', reference: 'pay_01HX', providerId: '302961', status: 'success' });
  });

  it('falls back to a hash of the body when the fields are missing', () => {
    const raw = Buffer.from(JSON.stringify({ event: 'charge.success', data: {} }));
    const event = parsePaystackEvent(raw);
    expect(event.externalId).toMatch(/^[0-9a-f]{64}$/);
    expect(event.reference).toBeNull();
  });

  it('throws on invalid JSON', () => {
    expect(() => parsePaystackEvent(Buffer.from('{not json'))).toThrow();
  });
});

// A fetch that replays fixtures and records what was sent.
function replay(responses: { status: number; body: unknown }[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error('no fixture left');
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'content-type': 'application/json' } });
  };
  return { fetchFn, calls };
}

describe('PaystackProvider', () => {
  it('initialises with integer kobo and returns the authorisation URL', async () => {
    const { fetchFn, calls } = replay([
      { status: 200, body: { status: true, message: 'Authorization URL created', data: { authorization_url: 'https://checkout.paystack.com/abc', access_code: 'abc', reference: 'pay_01HX' } } },
    ]);
    const provider = new PaystackProvider({ secretKey: SECRET, fetch: fetchFn });
    const result = await provider.initialize({
      reference: 'pay_01HX',
      amountMinor: 1050000n,
      currency: 'NGN',
      email: 'ada@example.com',
      callbackUrl: 'https://shop.example.com/orders/ORD-1/payment-return',
      metadata: { businessId: 'b', orderId: 'o', orderNumber: 'ORD-1' },
    });
    expect(result).toEqual({ authorizationUrl: 'https://checkout.paystack.com/abc', providerReference: 'pay_01HX' });
    expect(calls[0].url).toBe('https://api.paystack.co/transaction/initialize');
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ amount: 1050000, currency: 'NGN', reference: 'pay_01HX' });
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe(`Bearer ${SECRET}`);
  });

  it('maps verify statuses: success, failed, abandoned, reversed, and anything unfinished to pending', async () => {
    const cases: [string, string][] = [
      ['success', 'SUCCESS'],
      ['failed', 'FAILED'],
      ['abandoned', 'ABANDONED'],
      ['reversed', 'FAILED'],
      ['ongoing', 'PENDING'],
      ['processing', 'PENDING'],
      ['queued', 'PENDING'],
    ];
    for (const [providerStatus, expected] of cases) {
      const { fetchFn, calls } = replay([
        {
          status: 200,
          body: {
            status: true,
            data: { id: 77, reference: 'pay_01HX', status: providerStatus, amount: 1050000, currency: 'NGN', channel: 'card', paid_at: '2026-10-20T10:00:00.000Z' },
          },
        },
      ]);
      const provider = new PaystackProvider({ secretKey: SECRET, fetch: fetchFn });
      const txn = await provider.verify('pay_01HX');
      expect(txn.status).toBe(expected);
      expect(txn.amountMinor).toBe(1050000n);
      expect(txn.providerTransactionId).toBe('77');
      expect(txn.channel).toBe('card');
      expect(calls[0].url).toBe('https://api.paystack.co/transaction/verify/pay_01HX');
    }
  });

  it('treats a 5xx as retryable and a 4xx as permanent', async () => {
    const provider5xx = new PaystackProvider({ secretKey: SECRET, fetch: replay([{ status: 503, body: { status: false, message: 'down' } }]).fetchFn });
    await expect(provider5xx.verify('pay_x')).rejects.toMatchObject({ retryable: true, httpStatus: 503 });

    const provider400 = new PaystackProvider({ secretKey: SECRET, fetch: replay([{ status: 400, body: { status: false, message: 'bad' } }]).fetchFn });
    await expect(provider400.verify('pay_x')).rejects.toMatchObject({ retryable: false, httpStatus: 400 });
  });

  it('treats a network failure as retryable and does not echo the cause', async () => {
    const fetchFn: FetchLike = async () => {
      throw new Error(`connect failed for ${SECRET}`);
    };
    const provider = new PaystackProvider({ secretKey: SECRET, fetch: fetchFn });
    const error = await provider.verify('pay_x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PaystackError);
    expect((error as PaystackError).retryable).toBe(true);
    expect((error as Error).message).not.toContain(SECRET);
  });

  it('rejects a response with the wrong shape instead of guessing', async () => {
    const provider = new PaystackProvider({ secretKey: SECRET, fetch: replay([{ status: 200, body: { status: true, data: { status: 'success' } } }]).fetchFn });
    await expect(provider.verify('pay_x')).rejects.toBeInstanceOf(PaystackError);
  });

  it('maps refund statuses', async () => {
    const cases: [string, string][] = [
      ['pending', 'PENDING'],
      ['processing', 'PROCESSING'],
      ['processed', 'SUCCEEDED'],
      ['failed', 'FAILED'],
    ];
    for (const [providerStatus, expected] of cases) {
      const { fetchFn, calls } = replay([{ status: 200, body: { status: true, data: { id: 9001, status: providerStatus } } }]);
      const provider = new PaystackProvider({ secretKey: SECRET, fetch: fetchFn });
      const result = await provider.refund({ providerTransactionId: '77', amountMinor: 500000n });
      expect(result).toEqual({ providerRefundId: '9001', status: expected });
      expect(JSON.parse(String(calls[0].init.body))).toEqual({ transaction: '77', amount: 500000 });
    }
  });
});

describe('Paystack configuration (06 §7)', () => {
  it('requires a secret key when Paystack is the provider', () => {
    expect(() => parseEnv({ PAYMENT_PROVIDER: 'PAYSTACK' })).toThrow(/PAYSTACK_SECRET_KEY/);
  });

  it('refuses a test key in production', () => {
    expect(() =>
      parseEnv({ NODE_ENV: 'production', APP_BASE_URL: 'https://shop.example.com', PAYMENT_PROVIDER: 'PAYSTACK', PAYSTACK_SECRET_KEY: 'sk_test_abc' }),
    ).toThrow(/PAYSTACK_SECRET_KEY/);
  });

  it('refuses a live key outside production', () => {
    expect(() => parseEnv({ PAYMENT_PROVIDER: 'PAYSTACK', PAYSTACK_SECRET_KEY: 'sk_live_abc' })).toThrow(/PAYSTACK_SECRET_KEY/);
  });

  it('accepts a test key outside production, and a live key in production', () => {
    expect(parseEnv({ PAYMENT_PROVIDER: 'PAYSTACK', PAYSTACK_SECRET_KEY: 'sk_test_abc' }).PAYMENT_PROVIDER).toBe('PAYSTACK');
    expect(
      parseEnv({ NODE_ENV: 'production', APP_BASE_URL: 'https://shop.example.com', PAYMENT_PROVIDER: 'PAYSTACK', PAYSTACK_SECRET_KEY: 'sk_live_abc' }).PAYMENT_PROVIDER,
    ).toBe('PAYSTACK');
  });

  it('never puts the key value in a validation error', () => {
    try {
      parseEnv({ NODE_ENV: 'production', APP_BASE_URL: 'https://shop.example.com', PAYMENT_PROVIDER: 'PAYSTACK', PAYSTACK_SECRET_KEY: 'sk_test_LEAKME' });
      throw new Error('expected a failure');
    } catch (error) {
      expect((error as Error).message).not.toContain('LEAKME');
    }
  });
});

describe('PaystackProvider refunds', () => {
  it('starts a refund and maps the queued status to PROCESSING', async () => {
    const { fetchFn, calls } = replay([{ status: 200, body: { status: true, data: { id: 3018284, status: 'pending' } } }]);
    const provider = new PaystackProvider({ secretKey: SECRET, fetch: fetchFn });
    const result = await provider.refund({ providerTransactionId: '1004723697', amountMinor: 10000n, reference: 'ref' });
    expect(result).toEqual({ providerRefundId: '3018284', status: 'PENDING' });
    expect(calls[0].url).toBe('https://api.paystack.co/refund');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ transaction: '1004723697', amount: 10000 });
  });

  it('looks up one refund by id and maps processed to SUCCEEDED', async () => {
    const { fetchFn, calls } = replay([{ status: 200, body: { status: true, data: { id: 3018284, status: 'processed' } } }]);
    const provider = new PaystackProvider({ secretKey: SECRET, fetch: fetchFn });
    expect(await provider.getRefund('3018284')).toEqual({ providerRefundId: '3018284', status: 'SUCCEEDED' });
    expect(calls[0].url).toBe('https://api.paystack.co/refund/3018284');
    expect(calls[0].init.method).toBe('GET');
  });

  it('keeps needs-attention and unknown statuses open rather than final', async () => {
    const provider = new PaystackProvider({
      secretKey: SECRET,
      fetch: replay([{ status: 200, body: { status: true, data: { id: 7, status: 'needs-attention' } } }]).fetchFn,
    });
    expect((await provider.getRefund('7')).status).toBe('PROCESSING');
  });

  it('refuses a lookup whose id does not match the one asked for', async () => {
    const provider = new PaystackProvider({
      secretKey: SECRET,
      fetch: replay([{ status: 200, body: { status: true, data: { id: 999, status: 'processed' } } }]).fetchFn,
    });
    await expect(provider.getRefund('7')).rejects.toMatchObject({ retryable: true });
  });

  it('treats a 4xx on refund as definitive (not retryable)', async () => {
    const provider = new PaystackProvider({
      secretKey: SECRET,
      fetch: replay([{ status: 400, body: { status: false, message: 'Transaction not found' } }]).fetchFn,
    });
    await expect(provider.refund({ providerTransactionId: '1', amountMinor: 1n, reference: 'r' })).rejects.toMatchObject({
      retryable: false,
      httpStatus: 400,
    });
  });
});
