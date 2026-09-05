/**
 * Provider API key handling (M7.2, NFR-305/301).
 *
 * AES-256-GCM over the node:crypto stdlib. The master key comes from the
 * deployment (`PROVIDER_KEY_ENCRYPTION_KEY`) and is never persisted; a row
 * stores only ciphertext, nonce (not a secret), and `last4`. A provider SDK
 * error can echo request headers, so `redact` is the choke point every
 * provider-facing string passes through before it reaches a log or a client.
 */
import { Inject, Injectable } from '@nestjs/common';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { DB, type Db } from '../db/db.module';
import { providerConnections } from '../db/schema';
import type { Tx } from '../session/session.service';

export const MASTER_KEY_ENV = 'PROVIDER_KEY_ENCRYPTION_KEY';
/** The GCM auth tag is appended to the ciphertext; the schema has no slot for it. */
const AUTH_TAG_BYTES = 16;

/** Named as the row's columns, so the result feeds both the insert and a re-encryption. */
export type EncryptedKey = {
  apiKeyCiphertext: Buffer;
  apiKeyNonce: Buffer;
  apiKeyLast4: string;
};

/**
 * Strips every occurrence of each secret, longest first so one secret that is
 * a prefix of another cannot leave a residue behind.
 */
export function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of [...new Set(secrets)].sort((a, b) => b.length - a.length)) {
    if (secret) out = out.split(secret).join('[REDACTED]');
  }
  return out;
}

@Injectable()
export class ProviderSecrets {
  private readonly masterKey: Buffer;

  /**
   * The master key is validated here, in the constructor: a missing or
   * malformed key is a startup failure, not a silent fallback to plaintext.
   */
  constructor(@Inject(DB) private readonly db: Db) {
    const raw = process.env[MASTER_KEY_ENV];
    if (!raw) {
      throw new Error(`${MASTER_KEY_ENV} is not set. Generate one with: openssl rand -hex 32`);
    }
    if (raw.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(raw)) {
      throw new Error(
        `${MASTER_KEY_ENV} must be 64 hex characters (32 bytes); got ${raw.length} characters`,
      );
    }
    this.masterKey = Buffer.from(raw, 'hex');
  }

  /** Fresh 12-byte nonce per key; the nonce is stored beside the ciphertext. */
  encrypt(plaintext: string): EncryptedKey {
    const apiKeyNonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.masterKey, apiKeyNonce);
    const apiKeyCiphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    return { apiKeyCiphertext, apiKeyNonce, apiKeyLast4: plaintext.slice(-4) };
  }

  /** A row without key material is a keyless endpoint (M7.3 local inference). */
  decrypt(row: { apiKeyCiphertext?: Buffer | null; apiKeyNonce?: Buffer | null }): string | null {
    const { apiKeyCiphertext: ciphertext, apiKeyNonce: nonce } = row;
    if (!ciphertext || !nonce) return null;
    const data = ciphertext.subarray(0, ciphertext.length - AUTH_TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', this.masterKey, nonce);
    decipher.setAuthTag(ciphertext.subarray(ciphertext.length - AUTH_TAG_BYTES));
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  }

  /**
   * Replace key: re-encrypt under a fresh nonce and refresh `last4`; everything
   * else on the row is untouched. A fresh nonce means even the same key yields
   * different ciphertext, so old captures stay useless.
   *
   * `executor` lets the caller pass its own transaction, so the key change and
   * the audit row that records it commit together or not at all (M7.8).
   */
  async replaceKey(
    connectionId: string,
    newKey: string,
    executor: Db | Tx = this.db,
  ): Promise<void> {
    const next = this.encrypt(newKey);
    await executor
      .update(providerConnections)
      .set({
        apiKeyCiphertext: next.apiKeyCiphertext,
        apiKeyNonce: next.apiKeyNonce,
        apiKeyLast4: next.apiKeyLast4,
        updatedAt: new Date(),
      })
      .where(eq(providerConnections.id, connectionId));
  }

  /**
   * The choke point (NFR-305): scrub every provider key in play before a
   * provider-facing string is logged or sent anywhere. M7.7: there is no
   * env key anymore — the resolved connection's key is passed by the caller,
   * the only place that knows which one was in play.
   */
  redact(text: string, extraSecrets: string[] = []): string {
    return redactSecrets(text, extraSecrets);
  }
}
