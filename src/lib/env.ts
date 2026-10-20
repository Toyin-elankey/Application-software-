import { z } from 'zod';

// Server-side configuration. Values are validated once, at boot (see src/instrumentation.ts).
// Never import this module from client components: it must not reach the browser bundle.
const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    APP_BASE_URL: z.url({ error: 'must be an absolute URL' }).default('http://localhost:3000'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    // Read from Stage 2 onward. Optional until the data layer exists.
    DATABASE_URL: z.string().min(1, { error: 'must not be empty when set' }).optional(),
    // The single brand the storefront serves (MVP). Matched against Business.slug.
    STORE_BUSINESS_SLUG: z
      .string()
      .regex(/^[a-z0-9-]{1,64}$/, { error: 'must be lowercase letters, digits and hyphens' })
      .default('sample-brand'),
    // Payment provider adapter: MOCK for development and CI, PAYSTACK for test and live keys.
    // Unset means: the mock in development and test; in production it must be set to a real provider.
    PAYMENT_PROVIDER: z.enum(['MOCK', 'PAYSTACK']).optional(),
    // Paystack secret key (06 §8). Never sent to the browser, never logged. Test keys (sk_test_) are
    // refused in production; live keys (sk_live_) are refused everywhere else.
    PAYSTACK_SECRET_KEY: z.string().min(1, { error: 'must not be empty when set' }).optional(),
    // Bearer token for POST /api/internal/jobs/run, which a scheduler calls to retry payment jobs.
    // Unset means the endpoint does not exist.
    JOB_RUNNER_SECRET: z.string().min(32, { error: 'must be at least 32 characters when set' }).optional(),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && !isSecureOrLocal(env.APP_BASE_URL)) {
      ctx.addIssue({
        code: 'custom',
        path: ['APP_BASE_URL'],
        message: 'must use https in production (http is allowed only for localhost)',
      });
    }
    if (env.NODE_ENV === 'production' && env.PAYMENT_PROVIDER === 'MOCK') {
      ctx.addIssue({
        code: 'custom',
        path: ['PAYMENT_PROVIDER'],
        message: 'the mock payment provider is never allowed in production',
      });
    }
    if (env.PAYMENT_PROVIDER === 'PAYSTACK' && !env.PAYSTACK_SECRET_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['PAYSTACK_SECRET_KEY'],
        message: 'is required when PAYMENT_PROVIDER is PAYSTACK',
      });
    }
    if (env.PAYSTACK_SECRET_KEY) {
      const key = env.PAYSTACK_SECRET_KEY;
      if (env.NODE_ENV === 'production' && !key.startsWith('sk_live_')) {
        ctx.addIssue({ code: 'custom', path: ['PAYSTACK_SECRET_KEY'], message: 'must be a live key (sk_live_) in production' });
      }
      if (env.NODE_ENV !== 'production' && !key.startsWith('sk_test_')) {
        ctx.addIssue({ code: 'custom', path: ['PAYSTACK_SECRET_KEY'], message: 'must be a test key (sk_test_) outside production' });
      }
    }
  });

// https is required in production. Plain http is allowed only for localhost, so the production
// build can be run on a developer machine.
function isSecureOrLocal(value: string): boolean {
  const url = new URL(value);
  return url.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(url.hostname);
}

export type Env = z.infer<typeof EnvSchema>;

/**
 * Validates an environment object. The error lists variable names and reasons only,
 * never the values, so secrets cannot end up in logs.
 */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    throw new Error(`Invalid environment configuration:\n  ${lines.join('\n  ')}`);
  }
  return result.data;
}

let cached: Env | undefined;

export function getEnv(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}
