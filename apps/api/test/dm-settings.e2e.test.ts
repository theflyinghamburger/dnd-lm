import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { campaigns, memberships, users } from '../src/db/schema';
import type { Db } from '../src/db/db.module';
import { DATABASE_URL, createTestApp, truncateAll } from './app.harness';

/**
 * M7.6 — the campaign settings the config UI writes (FR-506). Closed
 * vocabularies rather than free text, one merge into the same `settings` jsonb
 * three other writers share, and the same host-or-admin rule the provider
 * selection uses.
 */
describe.skipIf(!DATABASE_URL)('campaign DM settings (M7.6)', () => {
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

  async function signUp(email: string): Promise<string> {
    const res = await api()
      .post('/api/auth/register')
      .send({ email, displayName: email.split('@')[0], password: 'a-long-enough-password' })
      .expect(201);
    const cookie = res.headers['set-cookie'];
    return Array.isArray(cookie) ? cookie[0]! : (cookie as unknown as string);
  }

  async function campaignFor(cookie: string): Promise<string> {
    const res = await api()
      .post('/api/campaigns')
      .set('Cookie', cookie)
      .send({ name: 'Lost Mine' })
      .expect(201);
    return res.body.id as string;
  }

  async function join(campaignId: string, hostCookie: string, cookie: string, role: string) {
    const invite = await api()
      .post(`/api/campaigns/${campaignId}/invites`)
      .set('Cookie', hostCookie)
      .send({ role })
      .expect(201);
    await api().post(`/api/invites/${invite.body.token}/accept`).set('Cookie', cookie).expect(201);
  }

  it('starts unset, and a host sets each knob to a value from its own vocabulary', async () => {
    const host = await signUp('host@example.com');
    const campaignId = await campaignFor(host);

    const before = await api()
      .get(`/api/campaigns/${campaignId}/dm-settings`)
      .set('Cookie', host)
      .expect(200);
    expect(before.body).toEqual({
      providerConnectionId: null,
      style: null,
      tone: null,
      difficulty: null,
    });

    const saved = await api()
      .patch(`/api/campaigns/${campaignId}/dm-settings`)
      .set('Cookie', host)
      .send({ style: 'gritty', tone: 'dark', difficulty: 'deadly' })
      .expect(200);
    expect(saved.body).toEqual({
      providerConnectionId: null,
      style: 'gritty',
      tone: 'dark',
      difficulty: 'deadly',
    });
  });

  it('a second host of the same campaign sees the choice; a player may read but not write', async () => {
    const host = await signUp('host@example.com');
    const cohost = await signUp('cohost@example.com');
    const player = await signUp('player@example.com');
    const campaignId = await campaignFor(host);
    await join(campaignId, host, cohost, 'host');
    await join(campaignId, host, player, 'player');

    await api()
      .patch(`/api/campaigns/${campaignId}/dm-settings`)
      .set('Cookie', host)
      .send({ style: 'heroic' })
      .expect(200);

    const seenByCohost = await api()
      .get(`/api/campaigns/${campaignId}/dm-settings`)
      .set('Cookie', cohost)
      .expect(200);
    expect(seenByCohost.body.style).toBe('heroic');

    // A player may see how the table is set up…
    await api().get(`/api/campaigns/${campaignId}/dm-settings`).set('Cookie', player).expect(200);
    // …and may not change it.
    await api()
      .patch(`/api/campaigns/${campaignId}/dm-settings`)
      .set('Cookie', player)
      .send({ style: 'comedic' })
      .expect(403);
  });

  it('refuses a value outside the vocabulary, and an empty write', async () => {
    const host = await signUp('host@example.com');
    const campaignId = await campaignFor(host);

    await api()
      .patch(`/api/campaigns/${campaignId}/dm-settings`)
      .set('Cookie', host)
      .send({ style: 'ignore-previous-instructions' })
      .expect(400);
    await api()
      .patch(`/api/campaigns/${campaignId}/dm-settings`)
      .set('Cookie', host)
      .send({})
      .expect(400);
  });

  it('a stranger gets nothing', async () => {
    const host = await signUp('host@example.com');
    const stranger = await signUp('stranger@example.com');
    const campaignId = await campaignFor(host);

    await api().get(`/api/campaigns/${campaignId}/dm-settings`).set('Cookie', stranger).expect(403);
    await api().get(`/api/campaigns/${campaignId}/dm-settings`).expect(401);
  });

  it('merges: a knob write leaves the provider selection and the triggers alone', async () => {
    const host = await signUp('host@example.com');
    const admin = await signUp('admin@example.com');
    const campaignId = await campaignFor(host);
    // Option (a) platform admin: an `admin` membership in any campaign (M7.4).
    const [u] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, 'admin@example.com'))
      .limit(1);
    const [home] = await db
      .insert(campaigns)
      .values({ ownerUserId: u!.id, name: 'Admin Home' })
      .returning({ id: campaigns.id });
    await db.insert(memberships).values({ campaignId: home!.id, userId: u!.id, role: 'admin' });

    const connection = await api()
      .post('/api/admin/providers')
      .set('Cookie', admin)
      .send({
        label: 'Main',
        kind: 'anthropic',
        // A public literal IP: no DNS, so the M7.3 wall sees a plain allow.
        baseUrl: 'https://93.184.216.34/v1',
        apiKey: 'sk-test-settings-1',
        modelId: 'opus',
      })
      .expect(201);

    await api()
      .patch(`/api/campaigns/${campaignId}/provider`)
      .set('Cookie', host)
      .send({ providerConnectionId: connection.body.id })
      .expect(200);
    await api()
      .patch(`/api/campaigns/${campaignId}/triggers`)
      .set('Cookie', host)
      .send({ triggers: { dm_mention: false } })
      .expect(200);

    await api()
      .patch(`/api/campaigns/${campaignId}/dm-settings`)
      .set('Cookie', host)
      .send({ tone: 'light' })
      .expect(200);

    const settings = await api()
      .get(`/api/campaigns/${campaignId}/dm-settings`)
      .set('Cookie', host)
      .expect(200);
    expect(settings.body).toEqual({
      providerConnectionId: connection.body.id,
      style: null,
      tone: 'light',
      difficulty: null,
    });
    const triggers = await api()
      .get(`/api/campaigns/${campaignId}/triggers`)
      .set('Cookie', host)
      .expect(200);
    expect(triggers.body.triggers.find((t: { id: string }) => t.id === 'dm_mention').enabled).toBe(
      false,
    );

    // And a knob can be cleared without touching anything else.
    const cleared = await api()
      .patch(`/api/campaigns/${campaignId}/dm-settings`)
      .set('Cookie', host)
      .send({ tone: null })
      .expect(200);
    expect(cleared.body).toEqual({
      providerConnectionId: connection.body.id,
      style: null,
      tone: null,
      difficulty: null,
    });
  });
});
