import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { NoteSpoilerLevel, NoteStatus, NoteType } from '@dnd-lm/contracts';
import {
  campaigns,
  memberships,
  noteSpoilerLevel,
  noteStatus,
  noteType,
  users,
} from '../src/db/schema';
import type { Db } from '../src/db/db.module';
import { SessionContextService } from '../src/router/session-context.service';
import { DATABASE_URL, createTestApp, truncateAll } from './app.harness';

/** The contracts enums are the one definition both apps validate against; the DB must agree. */
describe('note enums (M8.5)', () => {
  it('match the database enums exactly, in order', () => {
    expect(NoteType.options).toEqual(noteType.enumValues);
    expect(NoteSpoilerLevel.options).toEqual(noteSpoilerLevel.enumValues);
    expect(NoteStatus.options).toEqual(noteStatus.enumValues);
  });
});

/**
 * M8.5 (#52) — host CRUD over campaign notes. A note carries `dm`-level
 * content, so this is a read-authorization surface first (FR-611, FR-105).
 */
describe.skipIf(!DATABASE_URL)('campaign notes API (M8.5)', () => {
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
    vi.restoreAllMocks();
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

  const klarg = {
    slug: 'klarg',
    type: 'npc',
    title: 'Klarg',
    bodyMd: 'A bugbear who leads the Cragmaw hideout.',
    spoilerLevel: 'dm',
    chapter: 1,
  };

  function seed(cookie: string, campaignId: string, body: object = klarg) {
    return api().post(`/api/campaigns/${campaignId}/notes`).set('Cookie', cookie).send(body);
  }

  /** Every route, read and write, with a body where one is needed. */
  const routes = (campaignId: string) =>
    [
      ['GET', `/api/campaigns/${campaignId}/notes`, undefined],
      ['POST', `/api/campaigns/${campaignId}/notes`, { ...klarg, slug: 'other' }],
      ['GET', `/api/campaigns/${campaignId}/notes/klarg`, undefined],
      ['PATCH', `/api/campaigns/${campaignId}/notes/klarg`, { title: 'Spoiled' }],
      ['DELETE', `/api/campaigns/${campaignId}/notes/klarg`, undefined],
    ] as const;

  function send(method: string, url: string, body: object | undefined, cookie?: string) {
    const verb = method.toLowerCase() as 'get' | 'post' | 'patch' | 'delete';
    let req = api()[verb](url);
    if (cookie) req = req.set('Cookie', cookie);
    return body ? req.send(body) : req;
  }

  it('a player member cannot READ notes: GET list and GET one are 403 and carry no note', async () => {
    const host = await signUp('host@example.com');
    const player = await signUp('player@example.com');
    const campaignId = await campaignFor(host);
    await join(campaignId, host, player, 'player');
    await seed(host, campaignId).expect(201);

    const list = await api()
      .get(`/api/campaigns/${campaignId}/notes`)
      .set('Cookie', player)
      .expect(403);
    const one = await api()
      .get(`/api/campaigns/${campaignId}/notes/klarg`)
      .set('Cookie', player)
      .expect(403);
    for (const res of [list, one]) {
      expect(JSON.stringify(res.body)).not.toContain('bugbear');
      expect(res.body.code).toBe('NOT_A_MEMBER');
    }
  });

  it('a player member gets 403 on every notes route, and nothing changes', async () => {
    const host = await signUp('host@example.com');
    const player = await signUp('player@example.com');
    const campaignId = await campaignFor(host);
    await join(campaignId, host, player, 'player');
    await seed(host, campaignId).expect(201);

    for (const [method, url, body] of routes(campaignId)) {
      const res = await send(method, url, body, player);
      expect({ method, url, status: res.status }).toEqual({ method, url, status: 403 });
    }
    const after = await api()
      .get(`/api/campaigns/${campaignId}/notes/klarg`)
      .set('Cookie', host)
      .expect(200);
    expect(after.body.title).toBe('Klarg');
  });

  it('a non-member gets 403 and an unauthenticated caller 401 on every route', async () => {
    const host = await signUp('host@example.com');
    const stranger = await signUp('stranger@example.com');
    const campaignId = await campaignFor(host);
    await seed(host, campaignId).expect(201);

    for (const [method, url, body] of routes(campaignId)) {
      const asStranger = await send(method, url, body, stranger);
      expect({ method, url, status: asStranger.status }).toEqual({ method, url, status: 403 });
      const anonymous = await send(method, url, body);
      expect({ method, url, status: anonymous.status }).toEqual({ method, url, status: 401 });
    }
  });

  it('a host creates, reads, lists, edits and deletes a note in their own campaign', async () => {
    const host = await signUp('host@example.com');
    const campaignId = await campaignFor(host);

    const created = await seed(host, campaignId).expect(201);
    expect(created.body).toMatchObject({
      ...klarg,
      frontmatter: {},
      status: 'published',
      sourceId: null,
    });

    const list = await api()
      .get(`/api/campaigns/${campaignId}/notes`)
      .set('Cookie', host)
      .expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].slug).toBe('klarg');
    expect(list.body[0]).not.toHaveProperty('bodyMd');

    const edited = await api()
      .patch(`/api/campaigns/${campaignId}/notes/klarg`)
      .set('Cookie', host)
      .send({ bodyMd: 'Klarg has a pet wolf, Ripper.', chapter: null, spoilerLevel: 'player' })
      .expect(200);
    expect(edited.body).toMatchObject({
      title: 'Klarg',
      bodyMd: 'Klarg has a pet wolf, Ripper.',
      chapter: null,
      spoilerLevel: 'player',
    });

    await api().delete(`/api/campaigns/${campaignId}/notes/klarg`).set('Cookie', host).expect(204);
    await api().get(`/api/campaigns/${campaignId}/notes/klarg`).set('Cookie', host).expect(404);
  });

  it('publishing a draft is a plain status update (the P4.1.5 review path)', async () => {
    const host = await signUp('host@example.com');
    const campaignId = await campaignFor(host);
    await seed(host, campaignId, { ...klarg, status: 'draft' }).expect(201);

    const published = await api()
      .patch(`/api/campaigns/${campaignId}/notes/klarg`)
      .set('Cookie', host)
      .send({ status: 'published' })
      .expect(200);
    expect(published.body.status).toBe('published');
  });

  it('a campaign admin member has the same access as the host', async () => {
    const host = await signUp('host@example.com');
    const admin = await signUp('admin@example.com');
    const campaignId = await campaignFor(host);
    const [u] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, 'admin@example.com'));
    await db.insert(memberships).values({ campaignId, userId: u!.id, role: 'admin' });

    await seed(admin, campaignId).expect(201);
    await api().get(`/api/campaigns/${campaignId}/notes/klarg`).set('Cookie', admin).expect(200);
  });

  it('a host is refused on another campaign, and never sees its notes', async () => {
    const hostA = await signUp('a@example.com');
    const hostB = await signUp('b@example.com');
    const campaignA = await campaignFor(hostA);
    const campaignB = await campaignFor(hostB);
    await seed(hostB, campaignB, { ...klarg, slug: 'b-secret', bodyMd: 'campaign B only' }).expect(
      201,
    );

    for (const [method, url, body] of routes(campaignB)) {
      const res = await send(method, url, body, hostA);
      expect({ method, url, status: res.status }).toEqual({ method, url, status: 403 });
    }
    // Campaign B's slug through campaign A's route: the query is keyed on both.
    const res = await api()
      .get(`/api/campaigns/${campaignA}/notes/b-secret`)
      .set('Cookie', hostA)
      .expect(404);
    expect(JSON.stringify(res.body)).not.toContain('campaign B only');
    await api()
      .patch(`/api/campaigns/${campaignA}/notes/b-secret`)
      .set('Cookie', hostA)
      .send({ title: 'x' })
      .expect(404);
    await api()
      .delete(`/api/campaigns/${campaignA}/notes/b-secret`)
      .set('Cookie', hostA)
      .expect(404);
    const listA = await api()
      .get(`/api/campaigns/${campaignA}/notes`)
      .set('Cookie', hostA)
      .expect(200);
    expect(listA.body).toEqual([]);
  });

  it('a duplicate slug in one campaign is a 409 naming it; another campaign may reuse it', async () => {
    const hostA = await signUp('a@example.com');
    const hostB = await signUp('b@example.com');
    const campaignA = await campaignFor(hostA);
    const campaignB = await campaignFor(hostB);
    await seed(hostA, campaignA).expect(201);

    const dup = await seed(hostA, campaignA).expect(409);
    expect(dup.body).toMatchObject({ code: 'NOTE_SLUG_TAKEN', slug: 'klarg' });

    await seed(hostB, campaignB).expect(201);
  });

  it('refuses a malformed note: non-kebab slug, unknown type, client-set sourceId, empty patch', async () => {
    const host = await signUp('host@example.com');
    const campaignId = await campaignFor(host);

    await seed(host, campaignId, { ...klarg, slug: 'Not Kebab' }).expect(400);
    await seed(host, campaignId, { ...klarg, type: 'monster' }).expect(400);
    await seed(host, campaignId, {
      ...klarg,
      sourceId: '00000000-0000-0000-0000-000000000000',
    }).expect(400);
    await seed(host, campaignId).expect(201);
    await api()
      .patch(`/api/campaigns/${campaignId}/notes/klarg`)
      .set('Cookie', host)
      .send({})
      .expect(400);
    await api()
      .patch(`/api/campaigns/${campaignId}/notes/klarg`)
      .set('Cookie', host)
      .send({ slug: 'renamed' })
      .expect(400);
  });

  it('every note write invalidates the campaign routing context; reads do not', async () => {
    const host = await signUp('host@example.com');
    const campaignId = await campaignFor(host);
    const invalidate = vi.spyOn(app.get(SessionContextService), 'invalidate');

    await seed(host, campaignId).expect(201);
    expect(invalidate).toHaveBeenLastCalledWith(campaignId);
    invalidate.mockClear();

    await api().get(`/api/campaigns/${campaignId}/notes`).set('Cookie', host).expect(200);
    await api().get(`/api/campaigns/${campaignId}/notes/klarg`).set('Cookie', host).expect(200);
    expect(invalidate).not.toHaveBeenCalled();

    await api()
      .patch(`/api/campaigns/${campaignId}/notes/klarg`)
      .set('Cookie', host)
      .send({ title: 'Klarg the Bugbear' })
      .expect(200);
    expect(invalidate).toHaveBeenLastCalledWith(campaignId);
    invalidate.mockClear();

    await api().delete(`/api/campaigns/${campaignId}/notes/klarg`).set('Cookie', host).expect(204);
    expect(invalidate).toHaveBeenLastCalledWith(campaignId);
  });

  it('progression.chapter is host-set through dm-settings, merged, cleared by null, and invalidates', async () => {
    const host = await signUp('host@example.com');
    const player = await signUp('player@example.com');
    const campaignId = await campaignFor(host);
    await join(campaignId, host, player, 'player');
    await db
      .update(campaigns)
      .set({ settings: { progression: { chapter: 1, arc: 'kept' }, dm_tone: 'dark' } })
      .where(eq(campaigns.id, campaignId));
    const invalidate = vi.spyOn(app.get(SessionContextService), 'invalidate');

    const saved = await api()
      .patch(`/api/campaigns/${campaignId}/dm-settings`)
      .set('Cookie', host)
      .send({ progressionChapter: 3 })
      .expect(200);
    expect(saved.body).toMatchObject({ progressionChapter: 3, tone: 'dark' });
    expect(invalidate).toHaveBeenCalledWith(campaignId);

    // The exact key M8.3's retrieval reads: settings.progression.chapter.
    const read = async () =>
      (await db.select().from(campaigns).where(eq(campaigns.id, campaignId)))[0]!.settings;
    expect(await read()).toMatchObject({ progression: { chapter: 3, arc: 'kept' } });

    const cleared = await api()
      .patch(`/api/campaigns/${campaignId}/dm-settings`)
      .set('Cookie', host)
      .send({ progressionChapter: null })
      .expect(200);
    expect(cleared.body.progressionChapter).toBeNull();
    expect(await read()).toEqual({ progression: { arc: 'kept' }, dm_tone: 'dark' });

    await api()
      .patch(`/api/campaigns/${campaignId}/dm-settings`)
      .set('Cookie', host)
      .send({ progressionChapter: -1 })
      .expect(400);
    await api()
      .patch(`/api/campaigns/${campaignId}/dm-settings`)
      .set('Cookie', player)
      .send({ progressionChapter: 9 })
      .expect(403);
  });
});
