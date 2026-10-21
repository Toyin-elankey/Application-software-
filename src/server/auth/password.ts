import { hash, verify } from '@node-rs/argon2';

// Staff passwords are hashed with Argon2id (A-15). Parameters follow the OWASP minimum for Argon2id
// (19 MiB memory, 2 passes, 1 lane). Hashes are never returned by any API.

const PARAMS = { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const; // algorithm 2 = Argon2id

export const MIN_PASSWORD_LENGTH = 12;
/** Capped so a very long input cannot be used to make the hashing expensive. */
export const MAX_PASSWORD_LENGTH = 256;

/** Returns why a new password is not allowed, or null when it is acceptable. Length is the only rule (NIST SP 800-63B). */
export function passwordProblem(password: string): 'too_short' | 'too_long' | null {
  if (password.length < MIN_PASSWORD_LENGTH) return 'too_short';
  if (password.length > MAX_PASSWORD_LENGTH) return 'too_long';
  return null;
}

export async function hashPassword(password: string): Promise<string> {
  if (passwordProblem(password) !== null) throw new RangeError(`password must be ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters`);
  return hash(password, PARAMS);
}

export async function verifyPassword(hashValue: string, password: string): Promise<boolean> {
  try {
    return await verify(hashValue, password);
  } catch {
    // A malformed stored hash is treated as a failed check, never as a success.
    return false;
  }
}

/** A real Argon2id hash of a value nobody knows. Verifying against it costs the same time as a real check. */
export const DUMMY_HASH = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$b5OnXmzU9/Mo20b8YXyf4W8o1DS/rwO6LF3DgXZ2DSA';
