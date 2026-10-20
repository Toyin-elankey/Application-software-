import pino from 'pino';
import { getEnv } from './env';

// Structured JSON logs. Field names that commonly carry secrets are redacted.
export const logger = pino({
  level: getEnv().LOG_LEVEL,
  redact: {
    paths: [
      'password',
      '*.password',
      'authorization',
      'headers.authorization',
      'token',
      '*.token',
      'secret',
      '*.secret',
      'DATABASE_URL',
    ],
    censor: '[REDACTED]',
  },
});
