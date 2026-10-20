import { getDb } from '@/server/db/client';
import { AppError } from '@/server/http/problem';
import {
  completeMockPayment,
  loadMockPayment,
  MOCK_OUTCOMES,
  renderMockErrorPage,
  renderMockPayPage,
  renderMockResultPage,
  type MockOutcome,
} from '@/server/payments/mockPay';

export const dynamic = 'force-dynamic';

// Mock checkout pages are HTML for a browser, so errors are HTML too (not problem+json).

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

async function htmlHandle(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof AppError) return htmlResponse(renderMockErrorPage(error.message), error.status);
    throw error;
  }
}

// GET /mock-pay/{reference}: shows the mock payment choices. Changes nothing.
export function GET(_request: Request, context: { params: Promise<{ reference: string }> }) {
  return htmlHandle(async () => {
    const { reference } = await context.params;
    const payment = await loadMockPayment(getDb(), reference);
    return htmlResponse(renderMockPayPage({ reference: payment.reference, amountMinor: payment.amountMinor, order: payment.order }));
  });
}

// POST /mock-pay/{reference} with form field outcome=SUCCESS|FAILED|ABANDONED.
export function POST(request: Request, context: { params: Promise<{ reference: string }> }) {
  return htmlHandle(async () => {
    // Refuse cross-site form posts. Browsers send Origin on POST.
    const origin = request.headers.get('origin');
    if (origin && origin !== new URL(request.url).origin) {
      throw new AppError(403, 'forbidden_origin', 'Cross-site request refused.');
    }
    const { reference } = await context.params;
    const form = await request.formData();
    const outcome = String(form.get('outcome') ?? '');
    if (!(MOCK_OUTCOMES as readonly string[]).includes(outcome)) {
      throw new AppError(400, 'invalid_outcome', 'Choose an outcome.');
    }
    const result = await completeMockPayment(getDb(), reference, outcome as MockOutcome);
    return htmlResponse(renderMockResultPage(result));
  });
}
