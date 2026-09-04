import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { AdminConnection } from '@dnd-lm/contracts';
import { campaigns, memberships, users } from '../src/db/schema';
import type { Db } from '../src/db/db.module';
import { DATABASE_URL, createTestApp, truncateAll } from './app.harness';

/**
 * M7.4 — who may do what. Platform admin = an `admin` membership in any
 * campaign (option (a), decided in the issue thread). The exit criteria are
 * the acceptance bullets: a non-admin gets 403 on every admin connection
 * endpoint; a host gets the redacted enabled list only; the settings write is
 * campaign-scoped; private-range URLs are refused; in-use deletes are refused
 * with the campaign names.
 */
describe.skipIf(!DATABASE_URL)('provider connections authorization (M7.4)', () => {
  let app: INestApplication;
  let db: Db;

  beforeAll(async () => {
    ({ app, db } = await createTestApp());
  });
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(async () => {
    await truncateAll(db);
  });

  const api = () => request(app.getHttpServer());
  const UUID = '00000000-0000-0000-0000-000000000000';
  // A public literal IP: no DNS, so the suite is deterministic offline and the
  // M7.3 wall sees a plain allow.
  const PUBLIC_URL = 'https://93.184.216.34/v1';

  async function signUp(email: string): Promise<string> {
    const res = await api()
      .post('/api/auth/register')
      .send({ email, displayName: email.split('@')[0], password: 'a-long-enough-password' })
      .expect(201);
    const cookie = res.headers['set-cookie'];
    if (!cookie) throw new Error('register did not set a session cookie');
    return Array.isArray(cookie) ? cookie[0]! : cookie;
  }

  async function userId(email: string): Promise<string> {
    const [u] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (!u) throw new Error(`no user for ${email}`);
    return u.id;
  }

  /** Option (a): an `admin` membership in one campaign makes the user a platform admin. */
  async function makePlatformAdmin(email: string): Promise<void> {
    const uid = await userId(email);
    const [c] = await db
      .insert(campaigns)
      .values({ ownerUserId: uid, name: 'Admin Home' })
      .returning({ id: campaigns.id });
    await db.insert(memberships).values({ campaignId: c!.id, userId: uid, role: 'admin' });
  }

  async function createHostCampaign(cookie: string, name: string): Promise<string> {
    const res = await api().post('/api/campaigns').set('Cookie', cookie).send({ name }).expect(201);
    return res.body.id as string;
  }

  async function createConnection(
    cookie: string,
    body: Record<string, unknown>,
  ): Promise<AdminConnection> {
    const res = await api()
      .post('/api/admin/providers')
      .set('Cookie', cookie)
      .send(body)
      .expect(201);
    return res.body;
  }

  const connectionBody = (over: Record<string, unknown> = {}) => ({
    label: 'Main',
    kind: 'anthropic',
    baseUrl: PUBLIC_URL,
    apiKey: 'sk-test-wxyz',
    modelId: 'opus',
    ...over,
  });

  describe('admin surface — 403 for every non-admin, every method (M7 acceptance bullet)', () => {
    it('refuses a plain host on all seven admin endpoints', async () => {
      const host = await signUp('host@example.com');
      await createHostCampaign(host, 'Lost Mine');

      await api().get('/api/admin/providers').set('Cookie', host).expect(403);
      await api().get(`/api/admin/providers/${UUID}`).set('Cookie', host).expect(403);
      await api()
        .post('/api/admin/providers')
        .set('Cookie', host)
        .send(connectionBody())
        .expect(403);
      await api()
        .patch(`/api/admin/providers/${UUID}`)
        .set('Cookie', host)
        .send({ label: 'x' })
        .expect(403);
      await api().delete(`/api/admin/providers/${UUID}`).set('Cookie', host).expect(403);
      await api()
        .post(`/api/admin/providers/${UUID}/key`)
        .set('Cookie', host)
        .send({ apiKey: 'sk-test-aaaa' })
        .expect(403);
    });

    it('a player is refused too, and the unauthenticated get 401, not 403', async () => {
      const host = await signUp('host@example.com');
      const player = await signUp('player@example.com');
      await createHostCampaign(host, 'Lost Mine');
      const invite = await api()
        .post(`/api/campaigns/${await createHostCampaign(host, 'Mine 2')}/invites`)
        .set('Cookie', host)
        .send({ role: 'player' })
        .expect(201);
      await api()
        .post(`/api/invites/${invite.body.token}/accept`)
        .set('Cookie', player)
        .expect(201);

      await api().get('/api/admin/providers').set('Cookie', player).expect(403);
      await api()
        .post('/api/admin/providers')
        .set('Cookie', player)
        .send(connectionBody())
        .expect(403);

      await api().get('/api/admin/providers').expect(401);
      await api().post('/api/admin/providers').send(connectionBody()).expect(401);
      await api().get('/api/providers').expect(401);
    });
  });

  describe('admin surface — platform admin CRUD', () => {
    it('creates, lists, gets, patches, replaces the key, and deletes', async () => {
      const admin = await signUp('admin@example.com');
      await makePlatformAdmin('admin@example.com');

      const created = await createConnection(admin, connectionBody());
      expect(created).toEqual({
        id: expect.any(String),
        label: 'Main',
        kind: 'anthropic',
        baseUrl: PUBLIC_URL,
        apiKeyLast4: 'wxyz',
        modelId: 'opus',
        maxTokens: 1024,
        enabled: true,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      });
      // Write-only across the board (M7.2): the write response has last4, never the key.
      expect(JSON.stringify(created)).not.toContain('sk-test-wxyz');

      const list = await api().get('/api/admin/providers').set('Cookie', admin).expect(200);
      expect(list.body).toEqual([created]);
      const fetched = await api()
        .get(`/api/admin/providers/${created.id}`)
        .set('Cookie', admin)
        .expect(200);
      expect(fetched.body).toEqual(created);

      const updated = await api()
        .patch(`/api/admin/providers/${created.id}`)
        .set('Cookie', admin)
        .send({ enabled: false, label: 'Main 2' })
        .expect(200);
      expect(updated.body.label).toBe('Main 2');
      expect(updated.body.enabled).toBe(false);

      const rekeyed = await api()
        .post(`/api/admin/providers/${created.id}/key`)
        .set('Cookie', admin)
        .send({ apiKey: 'sk-test-abcd' })
        .expect(200);
      expect(rekeyed.body.apiKeyLast4).toBe('abcd');
      expect(rekeyed.body.baseUrl).toBe(PUBLIC_URL);
      expect(JSON.stringify(rekeyed.body)).not.toContain('sk-test-abcd');

      await api().delete(`/api/admin/providers/${created.id}`).set('Cookie', admin).expect(204);
      await api().get(`/api/admin/providers/${created.id}`).set('Cookie', admin).expect(404);
    });

    it('refuses to create or point a connection at a private-range URL (M7.3 save-time check)', async () => {
      const admin = await signUp('admin@example.com');
      await makePlatformAdmin('admin@example.com');

      const metadata = await api()
        .post('/api/admin/providers')
        .set('Cookie', admin)
        .send(connectionBody({ baseUrl: 'https://169.254.169.254/latest/meta-data/' }));
      expect(metadata.status).toBe(400);
      expect(metadata.body.code).toBe('BASE_URL_REJECTED');
      expect(metadata.body.reason).toContain('169.254.0.0/16');

      await api()
        .post('/api/admin/providers')
        .set('Cookie', admin)
        .send(connectionBody({ baseUrl: 'https://10.0.0.1/v1' }))
        .expect(400);

      const ok = await createConnection(admin, connectionBody());
      await api()
        .patch(`/api/admin/providers/${ok.id}`)
        .set('Cookie', admin)
        .send({ baseUrl: 'http://192.168.1.10/v1' })
        .expect(400);
    });

    it('refuses to delete a connection a campaign still references, naming the campaign', async () => {
      const admin = await signUp('admin@example.com');
      const host = await signUp('host@example.com');
      await makePlatformAdmin('admin@example.com');
      const campaign = await createHostCampaign(host, 'The Reference');

      const conn = await createConnection(admin, connectionBody());
      await api()
        .patch(`/api/campaigns/${campaign}/provider`)
        .set('Cookie', host)
        .send({ providerConnectionId: conn.id })
        .expect(200);

      const refused = await api()
        .delete(`/api/admin/providers/${conn.id}`)
        .set('Cookie', admin)
        .expect(409);
      expect(refused.body.code).toBe('CONNECTION_IN_USE');
      expect(refused.body.campaigns).toEqual([{ id: campaign, name: 'The Reference' }]);

      await api()
        .patch(`/api/campaigns/${campaign}/provider`)
        .set('Cookie', host)
        .send({ providerConnectionId: null })
        .expect(200);
      await api().delete(`/api/admin/providers/${conn.id}`).set('Cookie', admin).expect(204);
    });
  });

  describe('host surface — redacted enabled list and the settings write', () => {
    it('lists only enabled connections, in the shape that cannot carry a URL or a key', async () => {
      const admin = await signUp('admin@example.com');
      const host = await signUp('host@example.com');
      await makePlatformAdmin('admin@example.com');
      await createHostCampaign(host, 'Lost Mine');

      const on = await createConnection(admin, connectionBody({ label: 'On' }));
      const off = await createConnection(
        admin,
        connectionBody({ label: 'Off', kind: 'openai_compatible' }),
      );
      await api()
        .patch(`/api/admin/providers/${off.id}`)
        .set('Cookie', admin)
        .send({ enabled: false })
        .expect(200);

      const res = await api().get('/api/providers').set('Cookie', host).expect(200);
      // Deep equality: exactly these five fields, nothing else on the wire.
      expect(res.body).toEqual([
        { id: on.id, label: 'On', kind: 'anthropic', modelId: 'opus', enabled: true },
      ]);
    });

    it('a host sets the provider on their own campaign, is refused elsewhere and for players (M7 acceptance)', async () => {
      const aAdmin = await signUp('a-admin@example.com');
      const hostA = await signUp('host-a@example.com');
      const hostB = await signUp('host-b@example.com');
      const player = await signUp('player@example.com');
      await makePlatformAdmin('a-admin@example.com');

      const campaignA = await createHostCampaign(hostA, 'Campaign A');
      const campaignB = await createHostCampaign(hostB, 'Campaign B');
      const invite = await api()
        .post(`/api/campaigns/${campaignA}/invites`)
        .set('Cookie', hostA)
        .send({ role: 'player' })
        .expect(201);
      await api()
        .post(`/api/invites/${invite.body.token}/accept`)
        .set('Cookie', player)
        .expect(201);

      const conn = await createConnection(aAdmin, connectionBody());

      const ok = await api()
        .patch(`/api/campaigns/${campaignA}/provider`)
        .set('Cookie', hostA)
        .send({ providerConnectionId: conn.id })
        .expect(200);
      expect(ok.body).toEqual({ providerConnectionId: conn.id });

      await api()
        .patch(`/api/campaigns/${campaignB}/provider`)
        .set('Cookie', hostA)
        .send({ providerConnectionId: conn.id })
        .expect(403);
      await api()
        .patch(`/api/campaigns/${campaignA}/provider`)
        .set('Cookie', player)
        .send({ providerConnectionId: conn.id })
        .expect(403);

      // A disabled connection is never selectable, an unknown one 404s, null clears.
      await api()
        .patch(`/api/admin/providers/${conn.id}`)
        .set('Cookie', aAdmin)
        .send({ enabled: false })
        .expect(200);
      const disabled = await api()
        .patch(`/api/campaigns/${campaignA}/provider`)
        .set('Cookie', hostA)
        .send({ providerConnectionId: conn.id });
      expect(disabled.status).toBe(400);
      expect(disabled.body.code).toBe('CONNECTION_NOT_ENABLED');

      await api()
        .patch(`/api/campaigns/${campaignA}/provider`)
        .set('Cookie', hostA)
        .send({ providerConnectionId: UUID })
        .expect(404);

      const cleared = await api()
        .patch(`/api/campaigns/${campaignA}/provider`)
        .set('Cookie', hostA)
        .send({ providerConnectionId: null })
        .expect(200);
      expect(cleared.body).toEqual({ providerConnectionId: null });
    });
  });
});
