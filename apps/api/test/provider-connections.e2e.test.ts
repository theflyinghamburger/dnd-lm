import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { providerConnections, users } from '../src/db/schema';
import type { Db } from '../src/db/db.module';
import { ProviderSecrets } from '../src/providers/provider-secrets.service';
import { DATABASE_URL } from './app.harness';

describe.skipIf(!DATABASE_URL)('provider_connections (M7.1)', () => {
  it('stores and reads the AES key material as bytea Buffers', async () => {
    const client = postgres(DATABASE_URL!, { max: 1 });
    const db = drizzle(client, { schema: { providerConnections, users } });
    const [u] = await db
      .insert(users)
      .values({ email: `m71-${Date.now()}@x.co`, displayName: 'm', passwordHash: 'x' })
      .returning({ id: users.id });
    const ciphertext = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');
    const nonce = Buffer.from('fedcba9876543210', 'hex');
    const [row] = await db
      .insert(providerConnections)
      .values({
        label: 'x',
        kind: 'anthropic',
        baseUrl: 'https://x',
        modelId: 'm',
        apiKeyCiphertext: ciphertext,
        apiKeyNonce: nonce,
        apiKeyLast4: 'cdef',
        createdBy: u!.id,
      })
      .returning();
    expect(row!.maxTokens).toBe(1024);
    expect(row!.enabled).toBe(true);
    expect(row!.apiKeyCiphertext?.equals(ciphertext)).toBe(true);
    const [fetched] = await db
      .select()
      .from(providerConnections)
      .where(eq(providerConnections.id, row!.id));
    expect(fetched!.apiKeyCiphertext?.equals(ciphertext)).toBe(true);
    expect(fetched!.apiKeyNonce?.equals(nonce)).toBe(true);
    await db.delete(providerConnections).where(eq(providerConnections.id, row!.id));
    await db.delete(users).where(eq(users.id, u!.id));
    await client.end();
  });

  it('encrypts with a fresh nonce per write, and Replace key touches only the key columns (M7.2)', async () => {
    const client = postgres(DATABASE_URL!, { max: 1 });
    const db = drizzle(client, { schema: { providerConnections, users } });
    const [u] = await db
      .insert(users)
      .values({ email: `m72-${Date.now()}@x.co`, displayName: 'm', passwordHash: 'x' })
      .returning({ id: users.id });
    const [row] = await db
      .insert(providerConnections)
      .values({
        label: 'lab',
        kind: 'openai_compatible',
        baseUrl: 'https://lab.example/v1',
        modelId: 'lab-model',
        maxTokens: 777,
        createdBy: u!.id,
      })
      .returning();

    const secrets = new ProviderSecrets(db as unknown as Db);
    const first = 'sk-live-aaaa';
    await secrets.replaceKey(row!.id, first);
    const [afterFirst] = await db
      .select()
      .from(providerConnections)
      .where(eq(providerConnections.id, row!.id));
    expect(afterFirst!.apiKeyLast4).toBe('aaaa');
    expect(secrets.decrypt(afterFirst!)).toBe(first);

    const second = 'sk-live-bbbb';
    await secrets.replaceKey(row!.id, second);
    const [afterSecond] = await db
      .select()
      .from(providerConnections)
      .where(eq(providerConnections.id, row!.id));
    expect(afterSecond!.apiKeyLast4).toBe('bbbb');
    expect(afterSecond!.apiKeyCiphertext?.equals(afterFirst!.apiKeyCiphertext!)).toBe(false);
    expect(secrets.decrypt(afterSecond!)).toBe(second);
    // Everything that is not key material stays exactly as it was.
    expect(afterSecond!.label).toBe('lab');
    expect(afterSecond!.baseUrl).toBe('https://lab.example/v1');
    expect(afterSecond!.modelId).toBe('lab-model');
    expect(afterSecond!.maxTokens).toBe(777);
    expect(afterSecond!.enabled).toBe(true);
    expect(afterSecond!.createdBy).toBe(u!.id);
    expect(afterSecond!.createdAt).toEqual(afterFirst!.createdAt);

    await db.delete(providerConnections).where(eq(providerConnections.id, row!.id));
    await db.delete(users).where(eq(users.id, u!.id));
    await client.end();
  });
});
