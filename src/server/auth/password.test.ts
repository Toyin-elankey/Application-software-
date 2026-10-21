import { describe, expect, it } from 'vitest';
import { hashPassword, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, passwordProblem, verifyPassword } from './password';

describe('passwordProblem', () => {
  it('accepts a password at the minimum and the maximum length', () => {
    expect(passwordProblem('a'.repeat(MIN_PASSWORD_LENGTH))).toBeNull();
    expect(passwordProblem('a'.repeat(MAX_PASSWORD_LENGTH))).toBeNull();
  });

  it('refuses one character under the minimum', () => {
    expect(passwordProblem('a'.repeat(MIN_PASSWORD_LENGTH - 1))).toBe('too_short');
  });

  it('refuses one character over the maximum', () => {
    expect(passwordProblem('a'.repeat(MAX_PASSWORD_LENGTH + 1))).toBe('too_long');
  });
});

describe('hashPassword and verifyPassword', () => {
  it('verifies the right password and refuses a wrong one', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(await verifyPassword(stored, 'correct horse battery staple')).toBe(true);
    expect(await verifyPassword(stored, 'correct horse battery stapl')).toBe(false);
  });

  it('refuses to hash a password outside the allowed length', async () => {
    await expect(hashPassword('short')).rejects.toBeInstanceOf(RangeError);
  });
});
