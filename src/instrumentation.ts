// Runs once when the Node.js server starts. A missing or invalid setting stops the process here,
// before it accepts any request. The error lists variable names only, never their values.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { getEnv } = await import('@/lib/env');
  let env: ReturnType<typeof getEnv>;
  try {
    env = getEnv();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Invalid environment configuration');
    globalThis.process.exit(1); // Node-only; reached only when NEXT_RUNTIME is nodejs
  }

  const { logger } = await import('@/lib/logger');
  logger.info({ nodeEnv: env.NODE_ENV }, 'web server configuration validated');
}
