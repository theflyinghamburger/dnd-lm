import { hash, verify } from '@node-rs/argon2';

/** OWASP argon2id baseline: 19 MiB, 2 iterations, 1 lane. */
const OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, OPTIONS);
}

export async function verifyPassword(digest: string, plain: string): Promise<boolean> {
  try {
    return await verify(digest, plain, OPTIONS);
  } catch {
    // A malformed or truncated digest is a failed login, not a 500.
    return false;
  }
}
