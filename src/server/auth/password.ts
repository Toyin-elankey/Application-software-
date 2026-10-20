import { hash, verify } from '@node-rs/argon2';

// Staff passwords are hashed with Argon2id (A-15). Parameters follow the OWASP minimum for Argon2id
// (19 MiB memory, 2 passes, 1 lane). Hashes are never returned by any API.

const PARAMS = { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const; // algorithm 2 = Argon2id

export const MIN_PASSWORD_LENGTH = 12;

export async function hashPassword(password: string): Promise<string> {
  if (password.length < MIN_PASSWORD_LENGTH) throw new RangeError(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
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
