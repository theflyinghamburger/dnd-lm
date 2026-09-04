import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.module';
import { DATABASE_URL, createTestApp, truncateAll } from './app.harness';

/**
 * M1 acceptance: a non-member receives 403 on every campaign route, and
 * authorization is re-read from the database rather than trusted from the
 * session (M1.3, FR-105).
 */
describe.skipIf(!DATABASE_URL)('identity, campaigns and memberships', () => {
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

  /** Returns the session cookie for a freshly registered user. */
  async function signUp(email: string): Promise<string> {
    const res = await api()
      .post('/api/auth/register')
      .send({ email, displayName: email.split('@')[0], password: 'a-long-enough-password' })
      .expect(201);
    const cookie = res.headers['set-cookie'];
    if (!cookie) throw new Error('register did not set a session cookie');
    return Array.isArray(cookie) ? cookie[0]! : cookie;
  }

  async function createCampaign(cookie: string, name: string): Promise<string> {
    const res = await api().post('/api/campaigns').set('Cookie', cookie).send({ name }).expect(201);
    return res.body.id as string;
  }

  describe('auth', () => {
    it('registers, sets an httpOnly cookie, and never returns the password', async () => {
      const res = await api()
        .post('/api/auth/register')
        .send({
          email: 'aria@example.com',
          displayName: 'Aria',
          password: 'a-long-enough-password',
        })
        .expect(201);

      expect(res.body).toEqual({
        id: expect.any(String),
        email: 'aria@example.com',
        displayName: 'Aria',
      });
      expect(JSON.stringify(res.body)).not.toContain('password');

      const cookie = res.headers['set-cookie']![0]!;
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Lax');
    });

    it('rejects a duplicate email', async () => {
      await signUp('aria@example.com');
      await api()
        .post('/api/auth/register')
        .send({ email: 'aria@example.com', displayName: 'Impostor', password: 'another-password' })
        .expect(409);
    });

    it('rejects a wrong password with 401 and no cookie', async () => {
      await signUp('aria@example.com');
      const res = await api()
        .post('/api/auth/login')
        .send({ email: 'aria@example.com', password: 'wrong-password-here' })
        .expect(401);
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('refuses every authenticated route without a session', async () => {
      await api().get('/api/auth/me').expect(401);
      await api().get('/api/campaigns').expect(401);
      await api().post('/api/campaigns').send({ name: 'Nope' }).expect(401);
    });

    it('logs out so the cookie stops working', async () => {
      const cookie = await signUp('aria@example.com');
      await api().post('/api/auth/logout').set('Cookie', cookie).expect(204);
      await api().get('/api/auth/me').set('Cookie', cookie).expect(401);
    });
  });

  describe('campaign authorization', () => {
    it('makes the creator a host and lists the campaign for them', async () => {
      const cookie = await signUp('host@example.com');
      const id = await createCampaign(cookie, 'Lost Mine');

      const list = await api().get('/api/campaigns').set('Cookie', cookie).expect(200);
      expect(list.body).toEqual([expect.objectContaining({ id, name: 'Lost Mine', role: 'host' })]);
    });

    it('gives a non-member 403 on every campaign route', async () => {
      const host = await signUp('host@example.com');
      const stranger = await signUp('stranger@example.com');
      const id = await createCampaign(host, 'Lost Mine');

      await api().get(`/api/campaigns/${id}`).set('Cookie', stranger).expect(403);
      await api().post(`/api/campaigns/${id}/invites`).set('Cookie', stranger).send({}).expect(403);
      expect((await api().get('/api/campaigns').set('Cookie', stranger)).body).toEqual([]);
    });

    it('answers a malformed campaign id with 403, not a 500', async () => {
      const cookie = await signUp('host@example.com');
      await api().get('/api/campaigns/not-a-uuid').set('Cookie', cookie).expect(403);
    });

    it('refuses a player the host-only invite route', async () => {
      const host = await signUp('host@example.com');
      const player = await signUp('player@example.com');
      const id = await createCampaign(host, 'Lost Mine');

      const invite = await api()
        .post(`/api/campaigns/${id}/invites`)
        .set('Cookie', host)
        .send({ role: 'player' })
        .expect(201);
      await api()
        .post(`/api/invites/${invite.body.token}/accept`)
        .set('Cookie', player)
        .expect(201);

      await api().get(`/api/campaigns/${id}`).set('Cookie', player).expect(200);
      await api().post(`/api/campaigns/${id}/invites`).set('Cookie', player).send({}).expect(403);
    });
  });

  describe('invites', () => {
    it('is single-use', async () => {
      const host = await signUp('host@example.com');
      const player = await signUp('player@example.com');
      const other = await signUp('other@example.com');
      const id = await createCampaign(host, 'Lost Mine');

      const invite = await api()
        .post(`/api/campaigns/${id}/invites`)
        .set('Cookie', host)
        .send({})
        .expect(201);

      await api()
        .post(`/api/invites/${invite.body.token}/accept`)
        .set('Cookie', player)
        .expect(201);
      await api().post(`/api/invites/${invite.body.token}/accept`).set('Cookie', other).expect(404);
      await api().get(`/api/campaigns/${id}`).set('Cookie', other).expect(403);
    });

    it('rejects an unknown token', async () => {
      const cookie = await signUp('player@example.com');
      await api().post('/api/invites/nope/accept').set('Cookie', cookie).expect(404);
    });

    it('rejects an expired invite', async () => {
      const host = await signUp('host@example.com');
      const player = await signUp('player@example.com');
      const id = await createCampaign(host, 'Lost Mine');

      const invite = await api()
        .post(`/api/campaigns/${id}/invites`)
        .set('Cookie', host)
        .send({})
        .expect(201);

      const { invites } = await import('../src/db/schema');
      const { eq } = await import('drizzle-orm');
      await db
        .update(invites)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(invites.token, invite.body.token as string));

      await api()
        .post(`/api/invites/${invite.body.token}/accept`)
        .set('Cookie', player)
        .expect(400);
    });
  });
});
