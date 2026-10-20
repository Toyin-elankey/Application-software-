import { timingSafeEqual } from 'node:crypto';
import { getEnv } from '@/lib/env';
import { getDb } from '@/server/db/client';
import { AppError, handle, jsonResponse } from '@/server/http/problem';
import { drainPaymentJobs } from '@/server/payments/drain';

export const dynamic = 'force-dynamic';

function bearerMatches(header: string | null, secret: string): boolean {
  const expected = Buffer.from(`Bearer ${secret}`, 'utf8');
  const given = Buffer.from(header ?? '', 'utf8');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// POST /api/internal/jobs/run. Runs due payment jobs (retries with backoff). Called by a scheduler
// with Authorization: Bearer <JOB_RUNNER_SECRET>. Without the secret configured the route does not exist.
export function POST(request: Request) {
  return handle(async () => {
    const secret = getEnv().JOB_RUNNER_SECRET;
    if (!secret || !bearerMatches(request.headers.get('authorization'), secret)) {
      throw new AppError(404, 'not_found', 'Not found.');
    }
    const summary = await drainPaymentJobs(getDb(), { limit: 25 });
    return jsonResponse({ summary });
  });
}
