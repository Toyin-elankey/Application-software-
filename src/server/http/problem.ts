import { z } from 'zod';
import { logger } from '@/lib/logger';
import { stringifyJson } from '@/lib/json';

// HTTP error model. Errors are returned as RFC 9457 problem details (application/problem+json).
// Each error has a stable machine-readable `code`; `detail` is safe to show to the customer.

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'AppError';
  }
}

export function problemResponse(status: number, code: string, detail: string, extra: Record<string, unknown> = {}) {
  const body = { type: 'about:blank', title: titleFor(status), status, code, detail, ...extra };
  return new Response(stringifyJson(body), {
    status,
    headers: { 'Content-Type': 'application/problem+json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(stringifyJson(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

/** Runs a route body and converts thrown errors into problem responses. Never leaks internals. */
export async function handle(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof AppError) {
      return problemResponse(error.status, error.code, error.message, error.extra);
    }
    if (error instanceof z.ZodError) {
      const issues = error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
      return problemResponse(400, 'validation_failed', 'Some fields are invalid.', { issues });
    }
    if (error instanceof RangeError) {
      return problemResponse(400, 'invalid_request', error.message);
    }
    logger.error({ err: error }, 'unhandled error in API route');
    return problemResponse(500, 'internal_error', 'Something went wrong. Please try again.');
  }
}

function titleFor(status: number): string {
  const titles: Record<number, string> = {
    400: 'Invalid request',
    404: 'Not found',
    409: 'Conflict',
    422: 'Cannot process this request',
    429: 'Too many requests',
    500: 'Internal error',
    503: 'Temporarily unavailable',
  };
  return titles[status] ?? 'Error';
}
