import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { campaigns, memberships, providerConnectionAudit, users } from '../src/db/schema';
import type { Db } from '../src/db/db.module';
import { DATABASE_URL, createTestApp, truncateAll } from './app.harness';

/**
 * M7.8 — who changed which provider setting. One row per successful mutation,
 * written in that mutation's own transaction, holding field *names* only: a
 * value in this table would be a second copy of a secret with none of the
 * first one's protections (FR-805, NFR-305, NFR-502).
 */
describe.skipIf(!DATABASE_URL)('provider connection audit (M7.8)', () => {
  let app: INestApplication;
  let db: Db;
  let admin: string;
  let adminId: string;

  // A public literal IP: no DNS, so the M7.3 wall sees a plain allow offline.
  const PUBLIC_URL = 'https://93.184.216.34/v1';
  const API_KEY = 'sk-test-audit-6789';

  beforeAll(async () => {
    ({ app, db } = await createTestApp());
  });
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(async () => {
    await truncateAll(db);
    admin = await signUp('admin@example.com');
    adminId = await userId('admin@example.com');
    const [c] = await db
      .insert(campaigns)
      .values({ ownerUserId: adminId, name: 'Admin Home' })
      .returning({ id: campaigns.id });
    await db.insert(memberships).values({ campaignId: c!.id, userId: adminId, role: 'admin' });
  });

  const api = () => request(app.getHttpServer());

  async function signUp(email: string): Promise<string> {
    const res = await api()
      .post('/api/auth/register')
      .send({ email, displayName: email.split('@')[0], password: 'a-long-enough-password' })
      .expect(201);
    const cookie = res.headers['set-cookie'];
    return Array.isArray(cookie) ? cookie[0]! : (cookie as unknown as string);
  }

  async function userId(email: string): Promise<string> {
    const [u] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    return u!.id;
  }

  async function create(over: Record<string, unknown> = {}): Promise<string> {
    const res = await api()
      .post('/api/admin/providers')
      .set('Cookie', admin)
      .send({
        label: 'Main',
        kind: 'anthropic',
        baseUrl: PUBLIC_URL,
        apiKey: API_KEY,
        modelId: 'opus',
        ...over,
      })
      .expect(201);
    return res.body.id as string;
  }

  const trail = (connectionId?: string) => {
    const query = db.select().from(providerConnectionAudit);
    return (
      connectionId ? query.where(eq(providerConnectionAudit.connectionId, connectionId)) : query
    ).orderBy(asc(providerConnectionAudit.at));
  };

  it('records the creation with the acting user and the fields that were set', async () => {
    const id = await create();

    const rows = await trail(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      connectionId: id,
      actorUserId: adminId,
      action: 'created',
    });
    expect(rows[0]!.changedFields).toEqual(['label', 'kind', 'base_url', 'model_id', 'api_key']);
    expect(rows[0]!.at).toBeInstanceOf(Date);
  });

  it('records an update as the fields that actually moved, diffed against the row', async () => {
    const id = await create();
    await api()
      .patch(`/api/admin/providers/${id}`)
      .set('Cookie', admin)
      // `label` is re-sent unchanged: a request key is not a change.
      .send({ label: 'Main', modelId: 'sonnet' })
      .expect(200);

    const rows = await trail(id);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ action: 'updated', actorUserId: adminId });
    expect(rows[1]!.changedFields).toEqual(['model_id']);
  });

  it('an enabled flip is its own action, in both directions', async () => {
    const id = await create();
    await api()
      .patch(`/api/admin/providers/${id}`)
      .set('Cookie', admin)
      .send({ enabled: false })
      .expect(200);
    await api()
      .patch(`/api/admin/providers/${id}`)
      .set('Cookie', admin)
      .send({ enabled: true, label: 'Renamed' })
      .expect(200);

    const rows = await trail(id);
    expect(rows.map((r) => r.action)).toEqual(['created', 'disabled', 'enabled']);
    // The action follows `enabled`; the fields still list everything that moved.
    expect(rows[2]!.changedFields).toEqual(['label', 'enabled']);
  });

  it('records a key replacement by name, never by value', async () => {
    const id = await create();
    await api()
      .post(`/api/admin/providers/${id}/key`)
      .set('Cookie', admin)
      .send({ apiKey: 'sk-test-rotated-0000' })
      .expect(200);

    const rows = await trail(id);
    expect(rows[1]).toMatchObject({ action: 'replaced_key' });
    expect(rows[1]!.changedFields).toEqual(['api_key']);
  });

  it('keeps the whole trail after the connection is deleted, delete row included', async () => {
    const id = await create();
    await api()
      .patch(`/api/admin/providers/${id}`)
      .set('Cookie', admin)
      .send({ enabled: false })
      .expect(200);
    await api().delete(`/api/admin/providers/${id}`).set('Cookie', admin).expect(204);

    const rows = await trail(id);
    expect(rows.map((r) => r.action)).toEqual(['created', 'disabled', 'deleted']);
    expect(rows[2]!.changedFields).toEqual([]);
    // The audited row is gone; its history is not.
    const remaining = await api().get('/api/admin/providers').set('Cookie', admin).expect(200);
    expect(remaining.body).toEqual([]);
  });

  it('writes nothing when the mutation itself fails', async () => {
    const id = await create();

    // M7.3 refuses a private-range URL: the update never happens, so neither
    // does its audit row (same transaction, and the check precedes it).
    await api()
      .patch(`/api/admin/providers/${id}`)
      .set('Cookie', admin)
      .send({ baseUrl: 'https://169.254.169.254/v1' })
      .expect(400);

    // An in-use delete is refused with the campaign named; nothing is recorded.
    const host = await signUp('host@example.com');
    const campaign = await api()
      .post('/api/campaigns')
      .set('Cookie', host)
      .send({ name: 'Lost Mine' })
      .expect(201);
    await api()
      .patch(`/api/campaigns/${campaign.body.id}/provider`)
      .set('Cookie', host)
      .send({ providerConnectionId: id })
      .expect(200);
    await api().delete(`/api/admin/providers/${id}`).set('Cookie', admin).expect(409);

    // A missing connection records nothing either.
    await api()
      .patch('/api/admin/providers/00000000-0000-0000-0000-000000000000')
      .set('Cookie', admin)
      .send({ label: 'ghost' })
      .expect(404);

    const rows = await trail();
    expect(rows.map((r) => r.action)).toEqual(['created']);
  });

  it('holds no value in any column — names only, on every action', async () => {
    const id = await create();
    await api()
      .patch(`/api/admin/providers/${id}`)
      .set('Cookie', admin)
      .send({ baseUrl: 'https://93.184.216.35/v1', label: 'Renamed' })
      .expect(200);
    await api()
      .post(`/api/admin/providers/${id}/key`)
      .set('Cookie', admin)
      .send({ apiKey: 'sk-test-rotated-0000' })
      .expect(200);
    await api().delete(`/api/admin/providers/${id}`).set('Cookie', admin).expect(204);

    const rows = await trail(id);
    const scanned = JSON.stringify(rows);
    for (const secret of [
      API_KEY,
      'sk-test-rotated-0000',
      '93.184.216.34',
      '93.184.216.35',
      'Renamed',
      'Main',
      'opus',
    ]) {
      expect(scanned).not.toContain(secret);
    }
    // What it does hold: names, and only names the schema knows.
    const names = new Set(rows.flatMap((r) => r.changedFields));
    expect([...names].sort()).toEqual(['api_key', 'base_url', 'kind', 'label', 'model_id'].sort());
  });
});
