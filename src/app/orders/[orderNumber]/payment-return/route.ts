import { getDb } from '@/server/db/client';
import { getPaymentProvider } from '@/server/payments/resolve';
import { renderReturnPage, resolvePaymentReturn, type ReturnView } from '@/server/payments/returnPage';
import type { PaymentProvider } from '@/server/payments/provider';

export const dynamic = 'force-dynamic';

// GET /orders/{orderNumber}/payment-return?reference=... (Paystack appends reference and trxref).
// HTML for the browser. Changes an order only through the verified-payment rules.

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' },
  });
}

function activeProvider(): PaymentProvider | null {
  try {
    return getPaymentProvider();
  } catch {
    return null;
  }
}

export async function GET(request: Request, context: { params: Promise<{ orderNumber: string }> }) {
  const { orderNumber } = await context.params;
  const url = new URL(request.url);
  const reference = url.searchParams.get('reference') ?? url.searchParams.get('trxref');
  if (!reference || reference.length > 100) {
    return htmlResponse(renderReturnPage({ kind: 'not_found' }), 404);
  }
  const view: ReturnView = await resolvePaymentReturn(getDb(), activeProvider(), orderNumber, reference);
  return htmlResponse(renderReturnPage(view), view.kind === 'not_found' ? 404 : 200);
}
