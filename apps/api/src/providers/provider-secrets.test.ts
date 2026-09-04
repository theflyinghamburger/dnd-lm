import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../db/db.module';
import { MASTER_KEY_ENV, ProviderSecrets, redactSecrets } from './provider-secrets.service';

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
// ponytail: the service only needs the DB for replaceKey, which the e2e
// suite covers against real Postgres; a stub keeps this file database-free.
const db = {} as Db;

describe('ProviderSecrets (M7.2, NFR-305/301)', () => {
  beforeEach(() => {
    process.env[MASTER_KEY_ENV] = KEY_A;
  });
  afterEach(() => {
    delete process.env[MASTER_KEY_ENV];
    delete process.env.DM_PROVIDER_API_KEY;
  });

  it('refuses to boot without the master key, with a clear message', () => {
    delete process.env[MASTER_KEY_ENV];
    expect(() => new ProviderSecrets(db)).toThrow(
      /PROVIDER_KEY_ENCRYPTION_KEY is not set. Generate one with: openssl rand -hex 32/,
    );
  });

  it('refuses to boot on a malformed master key', () => {
    process.env[MASTER_KEY_ENV] = 'too short';
    expect(() => new ProviderSecrets(db)).toThrow(/must be 64 hex characters/);
    process.env[MASTER_KEY_ENV] = 'z'.repeat(64);
    expect(() => new ProviderSecrets(db)).toThrow(/must be 64 hex characters/);
  });

  it('round-trips a key, and derives last4 from the plaintext', () => {
    const secrets = new ProviderSecrets(db);
    const key = 'sk-ant-plain-4242';
    const enc = secrets.encrypt(key);
    expect(enc.apiKeyLast4).toBe('4242');
    expect(secrets.decrypt(enc)).toBe(key);
  });

  it('uses a fresh nonce per encryption, so the ciphertexts differ', () => {
    const secrets = new ProviderSecrets(db);
    const a = secrets.encrypt('same-key');
    const b = secrets.encrypt('same-key');
    expect(a.apiKeyNonce.equals(b.apiKeyNonce)).toBe(false);
    expect(a.apiKeyCiphertext.equals(b.apiKeyCiphertext)).toBe(false);
    expect(secrets.decrypt(a)).toBe('same-key');
    expect(secrets.decrypt(b)).toBe('same-key');
  });

  it('refuses to decrypt under the wrong master key', () => {
    const withA = new ProviderSecrets(db);
    const enc = withA.encrypt('sk-under-a');
    process.env[MASTER_KEY_ENV] = KEY_B;
    const withC = new ProviderSecrets(db);
    expect(() => withC.decrypt(enc)).toThrow();
  });

  it('refuses to decrypt tampered ciphertext', () => {
    const secrets = new ProviderSecrets(db);
    const enc = secrets.encrypt('sk-tamper-me');
    const tampered = Buffer.from(enc.apiKeyCiphertext);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    expect(() =>
      secrets.decrypt({ apiKeyCiphertext: tampered, apiKeyNonce: enc.apiKeyNonce }),
    ).toThrow();
  });

  it('returns null for a row with no key material (keyless endpoint)', () => {
    const secrets = new ProviderSecrets(db);
    expect(secrets.decrypt({ apiKeyCiphertext: null, apiKeyNonce: null })).toBeNull();
    expect(secrets.decrypt({})).toBeNull();
  });

  it('redacts every secret, longest first', () => {
    const short = 'sk-123';
    const long = 'sk-1234567890';
    const text = `header x-api-key: ${short}; retry with ${long} and ${short} again`;
    expect(redactSecrets(text, [short, long])).toBe(
      'header x-api-key: [REDACTED]; retry with [REDACTED] and [REDACTED] again',
    );
    expect(redactSecrets('nothing here', [])).toBe('nothing here');
  });

  it('redacts the configured env key from provider error text', () => {
    process.env.DM_PROVIDER_API_KEY = 'sk-env-leak-0000';
    const secrets = new ProviderSecrets(db);
    const error = '401 authentication_error: request key sk-env-leak-0000 rejected';
    expect(secrets.redact(error)).toBe('401 authentication_error: request key [REDACTED] rejected');
  });

  it('redacts nothing when no key is configured', () => {
    const secrets = new ProviderSecrets(db);
    expect(secrets.redact('plain error')).toBe('plain error');
  });
});
