import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { getEnv } from '@/lib/env';
import type { InitializeInput, PaymentProvider, VerifiedTransaction } from './provider';

// Paystack adapter (06 §2, §4). Amounts are kobo, passed as integers. Field names follow Paystack's
// public API reference at the time of writing; each one is checked when the response is read, and
// the payload is mapped here so nothing else sees provider shapes. Raw responses are not stored.
//
// Secrets: the secret key is sent only as the Authorization header to api.paystack.co. It is never
// put in an error message, a log line, or a stored payload.

export const PAYSTACK_API_BASE = 'https://api.paystack.co';

export class PaystackError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number | null,
    /** True for network errors, timeouts, 429 and 5xx: the job runner should retry. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'PaystackError';
  }
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

// ---------- Webhook authentication and parsing (06 §4.3) ----------

/**
 * Checks x-paystack-signature: HMAC-SHA512 of the raw request bytes, keyed by the secret key, as
 * lowercase hex. Constant-time comparison. The body must be the exact bytes received, never a
 * re-serialised JSON object.
 */
export function verifyPaystackSignature(rawBody: Buffer, signature: string | null | undefined, secretKey: string): boolean {
  if (!signature) return false;
  const expected = createHmac('sha512', secretKey).update(rawBody).digest('hex');
  const given = Buffer.from(signature.trim().toLowerCase(), 'utf8');
  const want = Buffer.from(expected, 'utf8');
  return given.length === want.length && timingSafeEqual(given, want);
}

export type PaystackEvent = {
  event: string;
  /** Dedupe key: `${event}:${data.id}:${data.status}`, or a hash of the raw body when fields are missing. */
  externalId: string;
  reference: string | null;
  providerId: string | null;
  status: string | null;
};

/** Parses a verified body. Throws on invalid JSON. Use only after verifyPaystackSignature passes. */
export function parsePaystackEvent(rawBody: Buffer): PaystackEvent {
  const parsed: unknown = JSON.parse(rawBody.toString('utf8'));
  if (!parsed || typeof parsed !== 'object') throw new Error('webhook body is not an object');
  const body = parsed as { event?: unknown; data?: unknown };
  const event = typeof body.event === 'string' ? body.event : '';
  const data = body.data && typeof body.data === 'object' ? (body.data as Record<string, unknown>) : {};
  const providerId = data.id === undefined || data.id === null ? null : String(data.id);
  const status = typeof data.status === 'string' ? data.status : null;
  const reference = typeof data.reference === 'string' ? data.reference : null;
  const hash = createHash('sha256').update(rawBody).digest('hex');
  const derived = event && providerId && status ? `${event}:${providerId}:${status}` : '';
  const externalId = derived && derived.length <= 160 ? derived : hash;
  return { event, externalId, reference, providerId, status };
}

// ---------- API client ----------

export type PaystackOptions = {
  secretKey: string;
  baseUrl?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
};

const VERIFY_STATUS: Record<string, VerifiedTransaction['status']> = {
  success: 'SUCCESS',
  failed: 'FAILED',
  reversed: 'FAILED',
  abandoned: 'ABANDONED',
};

const REFUND_STATUS: Record<string, 'PENDING' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED'> = {
  pending: 'PENDING',
  processing: 'PROCESSING',
  processed: 'SUCCEEDED',
  failed: 'FAILED',
};

export class PaystackProvider implements PaymentProvider {
  readonly name = 'PAYSTACK' as const;
  private readonly fetchFn: FetchLike;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: PaystackOptions) {
    this.fetchFn = options.fetch ?? ((url, init) => fetch(url, init));
    this.baseUrl = (options.baseUrl ?? PAYSTACK_API_BASE).replace(/\/$/, '');
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async initialize(input: InitializeInput): Promise<{ authorizationUrl: string; providerReference: string }> {
    const amount = Number(input.amountMinor);
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new PaystackError('invalid amount', null, false);
    const data = (await this.call('POST', '/transaction/initialize', {
      reference: input.reference,
      amount,
      currency: input.currency,
      email: input.email,
      callback_url: input.callbackUrl,
      metadata: input.metadata,
    })) as { authorization_url?: unknown; reference?: unknown };
    if (typeof data.authorization_url !== 'string' || typeof data.reference !== 'string') {
      throw new PaystackError('initialize response had an unexpected shape', 200, true);
    }
    return { authorizationUrl: data.authorization_url, providerReference: data.reference };
  }

  async verify(reference: string): Promise<VerifiedTransaction> {
    const data = (await this.call('GET', `/transaction/verify/${encodeURIComponent(reference)}`)) as Record<string, unknown>;
    if (typeof data.status !== 'string' || typeof data.reference !== 'string' || typeof data.currency !== 'string') {
      throw new PaystackError('verify response had an unexpected shape', 200, true);
    }
    if (data.id === undefined || data.id === null || typeof data.amount !== 'number' || !Number.isSafeInteger(data.amount)) {
      throw new PaystackError('verify response had an unexpected shape', 200, true);
    }
    const paidAt = typeof data.paid_at === 'string' ? new Date(data.paid_at) : undefined;
    return {
      reference: data.reference,
      providerTransactionId: String(data.id),
      // Anything Paystack has not finished (ongoing, pending, queued, processing) is still pending.
      status: VERIFY_STATUS[data.status] ?? 'PENDING',
      amountMinor: BigInt(data.amount),
      currency: data.currency,
      channel: typeof data.channel === 'string' ? data.channel : undefined,
      paidAt: paidAt && !Number.isNaN(paidAt.getTime()) ? paidAt : undefined,
    };
  }

  /** Refund for a successful transaction. Final state arrives by webhook or a status check. */
  async refund(input: {
    providerTransactionId: string;
    amountMinor: bigint;
  }): Promise<{ providerRefundId: string; status: 'PENDING' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED' }> {
    const amount = Number(input.amountMinor);
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new PaystackError('invalid refund amount', null, false);
    const data = (await this.call('POST', '/refund', { transaction: input.providerTransactionId, amount })) as {
      id?: unknown;
      status?: unknown;
    };
    if ((typeof data.id !== 'number' && typeof data.id !== 'string') || typeof data.status !== 'string') {
      throw new PaystackError('refund response had an unexpected shape', 200, true);
    }
    return { providerRefundId: String(data.id), status: REFUND_STATUS[data.status] ?? 'PENDING' };
  }

  private async call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.options.secretKey}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      // Message carries no detail: network errors can echo request data.
      throw new PaystackError('Paystack request failed (network or timeout)', null, true);
    }
    let json: unknown = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    const envelope = json && typeof json === 'object' ? (json as { status?: unknown; data?: unknown }) : null;
    if (!response.ok || !envelope || envelope.status !== true) {
      const retryable = response.status >= 500 || response.status === 429 || response.status === 408;
      throw new PaystackError(`Paystack returned HTTP ${response.status}`, response.status, retryable);
    }
    return envelope.data;
  }
}

/** The configured Paystack provider. Throws if the secret key is not configured. */
export function paystackProviderFromEnv(fetchImpl?: FetchLike): PaystackProvider {
  const key = getEnv().PAYSTACK_SECRET_KEY;
  if (!key) throw new PaystackError('PAYSTACK_SECRET_KEY is not configured', null, false);
  return new PaystackProvider({ secretKey: key, fetch: fetchImpl });
}
