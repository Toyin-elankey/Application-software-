import { after } from 'next/server';
import { getDb } from '@/server/db/client';
import { drainPaymentJobs } from '@/server/payments/drain';
import { paystackWebhookSecret, receivePaystackWebhook } from '@/server/payments/webhook';

export const dynamic = 'force-dynamic';

// POST /api/webhooks/paystack. Reads the raw bytes before any parsing, because the signature covers
// exactly those bytes (06 §4.3). Acknowledges quickly; the verify job runs after the response.
export async function POST(request: Request) {
  const db = getDb();
  const rawBody = Buffer.from(await request.arrayBuffer());
  const outcome = await receivePaystackWebhook(db, rawBody, request.headers.get('x-paystack-signature'), paystackWebhookSecret());

  if (outcome.result === 'accepted') {
    after(async () => {
      await drainPaymentJobs(db);
    });
  }
  return new Response(null, { status: outcome.status });
}
