import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password';

describe('password', () => {
  it('round-trips a password and rejects the wrong one', async () => {
    const digest = await hashPassword('correct horse battery staple');
    expect(digest.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(digest, 'correct horse battery staple')).toBe(true);
    expect(await verifyPassword(digest, 'Correct horse battery staple')).toBe(false);
  });

  it('salts, so the same password never produces the same digest', async () => {
    expect(await hashPassword('hunter2')).not.toBe(await hashPassword('hunter2'));
  });

  it('treats a malformed digest as a failed login, not an error', async () => {
    await expect(verifyPassword('not-a-hash', 'hunter2')).resolves.toBe(false);
  });
});
