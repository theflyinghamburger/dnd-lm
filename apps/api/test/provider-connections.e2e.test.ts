import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { providerConnections, users } from '../src/db/schema';
import { DATABASE_URL } from './app.harness';

describe('provider_connections (M7.1)', () => {
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
});
