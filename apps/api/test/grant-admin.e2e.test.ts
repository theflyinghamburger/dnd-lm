import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.module';
import { GrantError, grantAdmin } from '../src/scripts/grant-admin';
import { DATABASE_URL, createTestApp, truncateAll } from './app.harness';

/**
 * #60 — the platform admin bootstrap. The point of the script is that the row
 * it writes is the row `AdminGuard` already looks for, so the last assertion
 * here goes through the real guard rather than re-reading `memberships`.
 */
describe.skipIf(!DATABASE_URL)('admin:grant — platform admin bootstrap', () => {
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
    if (!cookie) throw new Error('register did not set a session cookie');
    return Array.isArray(cookie) ? cookie[0]! : cookie;
  }

  async function createCampaign(cookie: string, name: string): Promise<string> {
    const res = await api().post('/api/campaigns').set('Cookie', cookie).send({ name }).expect(201);
    return res.body.id as string;
  }

  /** Makes `guest` a `player` in `campaignId`, so the "left alone" case is real. */
  async function invite(hostCookie: string, campaignId: string, guestCookie: string) {
    const res = await api()
      .post(`/api/campaigns/${campaignId}/invites`)
      .set('Cookie', hostCookie)
      .send({ role: 'player' })
      .expect(201);
    await api()
      .post(`/api/invites/${res.body.token}/accept`)
      .set('Cookie', guestCookie)
      .expect(201);
  }

  it('promotes the campaigns the user owns and leaves the others alone (AC-1, AC-2)', async () => {
    const host = await signUp('host@example.com');
    const other = await signUp('other@example.com');
    await createCampaign(host, 'Sunless Citadel');
    await createCampaign(host, 'Test Campaign');
    const theirs = await createCampaign(other, "Someone Else's Table");
    await invite(other, theirs, host);

    const result = await grantAdmin(db, 'host@example.com');

    expect(result.promoted.map((c) => c.name).sort()).toEqual(['Sunless Citadel', 'Test Campaign']);
    expect(result.alreadyAdmin).toEqual([]);
    expect(result.leftAlone).toBe(1);

    // The membership in the campaign they do not own keeps its role.
    const roster = await api()
      .get(`/api/campaigns/${theirs}/roster`)
      .set('Cookie', other)
      .expect(200);
    expect(
      roster.body.members.find(
        (m: { email?: string; displayName: string }) => m.displayName === 'host',
      )?.role,
    ).toBe('player');
  });

  it('is idempotent on a second run (AC-3)', async () => {
    const host = await signUp('host@example.com');
    await createCampaign(host, 'Sunless Citadel');

    await grantAdmin(db, 'host@example.com');
    const again = await grantAdmin(db, 'host@example.com');

    expect(again.promoted).toEqual([]);
    expect(again.alreadyAdmin.map((c) => c.name)).toEqual(['Sunless Citadel']);
  });

  it('refuses an unknown email, naming it (AC-4)', async () => {
    await expect(grantAdmin(db, 'nobody@example.com')).rejects.toThrow(
      /No account for nobody@example\.com/,
    );
    await expect(grantAdmin(db, 'nobody@example.com')).rejects.toBeInstanceOf(GrantError);
  });

  it('refuses a known user who owns no campaign (AC-4)', async () => {
    const host = await signUp('host@example.com');
    const guest = await signUp('guest@example.com');
    const campaignId = await createCampaign(host, 'Sunless Citadel');
    await invite(host, campaignId, guest);

    await expect(grantAdmin(db, 'guest@example.com')).rejects.toThrow(/owns no campaign/);
  });

  it('matches the email case-insensitively, as the store does', async () => {
    const host = await signUp('host@example.com');
    await createCampaign(host, 'Sunless Citadel');

    const result = await grantAdmin(db, '  HOST@Example.COM ');
    expect(result.promoted).toHaveLength(1);
  });

  it('flips GET /api/admin/providers from 403 to 200 through the real guard (AC-5)', async () => {
    const host = await signUp('host@example.com');
    await createCampaign(host, 'Sunless Citadel');

    await api().get('/api/admin/providers').set('Cookie', host).expect(403);
    await grantAdmin(db, 'host@example.com');
    await api().get('/api/admin/providers').set('Cookie', host).expect(200);
  });
});
