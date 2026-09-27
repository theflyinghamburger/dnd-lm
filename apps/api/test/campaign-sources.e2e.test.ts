import { createHash } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { CampaignSource } from '@dnd-lm/contracts';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.module';
import { campaignNotes, campaignSources, campaigns, memberships, users } from '../src/db/schema';
import { DATABASE_URL, createTestApp, truncateAll } from './app.harness';

/** Not a valid document — nothing in P4.1.1 parses past the magic bytes. */
const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
const pdfPart = { filename: 'lost-mine.pdf', contentType: 'application/pdf' };

/** Every body, on every status, is scanned for the bytes' column name. */
const noContent = (body: unknown) => expect(JSON.stringify(body ?? null)).not.toMatch(/content/i);

describe.skipIf(!DATABASE_URL)('campaign source upload (P4.1.1)', () => {
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

  const upload = (campaignId: string, cookie: string, bytes = PDF, part = pdfPart) =>
    api()
      .post(`/api/campaigns/${campaignId}/sources`)
      .set('Cookie', cookie)
      .attach('file', bytes, part);

  it('stores an uploaded PDF as pending, with the file’s size and hash', async () => {
    const host = await signUp('host@example.com');
    const campaignId = await campaignFor(host);

    const res = await upload(campaignId, host).expect(201);
    // `.strict()`: an unknown key — `content` above all — fails the parse.
    const source = CampaignSource.strict().parse(res.body);
    expect(source).toMatchObject({
      campaignId,
      filename: 'lost-mine.pdf',
      status: 'pending',
      byteSize: PDF.length,
      sha256: createHash('sha256').update(PDF).digest('hex'),
      pagesTotal: null,
      pagesDone: 0,
      notesExtracted: 0,
      finishedAt: null,
    });
    const [hostUser] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, 'host@example.com'));
    expect(source.uploadedBy).toBe(hostUser!.id);

    const [row] = await db
      .select({ content: campaignSources.content })
      .from(campaignSources)
      .where(eq(campaignSources.id, source.id));
    expect(Buffer.compare(row!.content, PDF)).toBe(0);

    const list = await api().get(`/api/campaigns/${campaignId}/sources`).set('Cookie', host);
    expect(list.status).toBe(200);
    expect(list.body.map((s: unknown) => CampaignSource.strict().parse(s).id)).toEqual([source.id]);

    const one = await api()
      .get(`/api/campaigns/${campaignId}/sources/${source.id}`)
      .set('Cookie', host)
      .expect(200);
    expect(CampaignSource.strict().parse(one.body)).toEqual(source);
  });

  it('lets a campaign admin who is not the owner use every route', async () => {
    const host = await signUp('host@example.com');
    const admin = await signUp('admin@example.com');
    const campaignId = await campaignFor(host);
    // No route grants the admin role yet; it is a membership row (M1.3).
    const [adminUser] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, 'admin@example.com'));
    await db.insert(memberships).values({ campaignId, userId: adminUser!.id, role: 'admin' });
    const base = `/api/campaigns/${campaignId}/sources`;

    const uploaded = await upload(campaignId, admin).expect(201);
    expect(uploaded.body.uploadedBy).toBe(adminUser!.id);
    const sourceId = uploaded.body.id as string;
    await api().get(base).set('Cookie', admin).expect(200);
    await api().get(`${base}/${sourceId}`).set('Cookie', admin).expect(200);
    await api().delete(`${base}/${sourceId}`).set('Cookie', admin).expect(204);
  });

  it('refuses a non-host member on every route (NFR-302)', async () => {
    const host = await signUp('host@example.com');
    const player = await signUp('player@example.com');
    const campaignId = await campaignFor(host);
    const invite = await api()
      .post(`/api/campaigns/${campaignId}/invites`)
      .set('Cookie', host)
      .send({})
      .expect(201);
    await api().post(`/api/invites/${invite.body.token}/accept`).set('Cookie', player).expect(201);
    const sourceId = (await upload(campaignId, host).expect(201)).body.id as string;
    const base = `/api/campaigns/${campaignId}/sources`;

    for (const res of [
      await upload(campaignId, player),
      await api().get(base).set('Cookie', player),
      await api().get(`${base}/${sourceId}`).set('Cookie', player),
      await api().delete(`${base}/${sourceId}`).set('Cookie', player),
    ]) {
      expect(res.status).toBe(403);
      noContent(res.body);
    }
    const [row] = await db.select({ id: campaignSources.id }).from(campaignSources);
    expect(row?.id).toBe(sourceId);
  });

  it('refuses a text file renamed to .pdf on its bytes', async () => {
    const host = await signUp('host@example.com');
    const campaignId = await campaignFor(host);

    const res = await upload(campaignId, host, Buffer.from('just some notes\n'), {
      filename: 'notes.pdf',
      contentType: 'text/plain',
    }).expect(422);
    expect(res.body.code).toBe('NOT_A_PDF');
    noContent(res.body);
  });

  it('refuses non-PDF bytes even when the request declares application/pdf', async () => {
    const host = await signUp('host@example.com');
    const campaignId = await campaignFor(host);

    const res = await upload(campaignId, host, Buffer.from('<html>hi</html>')).expect(422);
    expect(res.body.code).toBe('NOT_A_PDF');
    noContent(res.body);
  });

  it('refuses PDF bytes declared as another type — the MIME is checked too', async () => {
    const host = await signUp('host@example.com');
    const campaignId = await campaignFor(host);

    const res = await upload(campaignId, host, PDF, {
      filename: 'book.pdf',
      contentType: 'text/html',
    }).expect(422);
    expect(res.body.code).toBe('NOT_A_PDF');
    noContent(res.body);
  });

  it('refuses a 40 MB file with 413 and stores nothing', async () => {
    const host = await signUp('host@example.com');
    const campaignId = await campaignFor(host);
    const big = Buffer.concat([PDF, Buffer.alloc(40 * 1024 * 1024, 0x20)]);

    const res = await upload(campaignId, host, big);
    expect(res.status).toBe(413);
    noContent(res.body);
    expect(await db.select({ id: campaignSources.id }).from(campaignSources)).toHaveLength(0);
  });

  it('refuses a second upload while one is in flight, naming it', async () => {
    const host = await signUp('host@example.com');
    const campaignId = await campaignFor(host);
    const first = (await upload(campaignId, host).expect(201)).body.id as string;

    const res = await upload(campaignId, host).expect(409);
    expect(res.body.code).toBe('SOURCE_IN_FLIGHT');
    expect(CampaignSource.strict().parse(res.body.source).id).toBe(first);
    noContent(res.body);

    // Once it is out of flight, the campaign may upload again.
    await db.update(campaignSources).set({ status: 'review' }).where(eq(campaignSources.id, first));
    await upload(campaignId, host).expect(201);
  });

  it('refuses two racing uploads at the index, not only at a check', async () => {
    const host = await signUp('host@example.com');
    const campaignId = await campaignFor(host);

    const results = await Promise.all([upload(campaignId, host), upload(campaignId, host)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
  });

  it('keeps sources per campaign: another campaign’s id is a 404', async () => {
    const hostA = await signUp('a@example.com');
    const hostB = await signUp('b@example.com');
    const campaignA = await campaignFor(hostA);
    const campaignB = await campaignFor(hostB);
    const sourceA = (await upload(campaignA, hostA).expect(201)).body.id as string;

    for (const res of [
      await api().get(`/api/campaigns/${campaignB}/sources/${sourceA}`).set('Cookie', hostB),
      await api().delete(`/api/campaigns/${campaignB}/sources/${sourceA}`).set('Cookie', hostB),
    ]) {
      expect(res.status).toBe(404);
      noContent(res.body);
    }
    const list = await api().get(`/api/campaigns/${campaignB}/sources`).set('Cookie', hostB);
    expect(list.body).toEqual([]);
    // A malformed id is a 400 from the pipe, not a Postgres cast error.
    const bad = await api()
      .get(`/api/campaigns/${campaignA}/sources/nope`)
      .set('Cookie', hostA)
      .expect(400);
    noContent(bad.body);
  });

  it('refuses a multipart request with no file part', async () => {
    const host = await signUp('host@example.com');
    const campaignId = await campaignFor(host);

    const res = await api()
      .post(`/api/campaigns/${campaignId}/sources`)
      .set('Cookie', host)
      .field('note', 'forgot the file')
      .expect(400);
    expect(res.body.code).toBe('NO_FILE');
    noContent(res.body);
  });

  it('deleting a source keeps its notes and clears their source_id', async () => {
    const host = await signUp('host@example.com');
    const campaignId = await campaignFor(host);
    const sourceId = (await upload(campaignId, host).expect(201)).body.id as string;
    await db
      .insert(campaignNotes)
      .values({ campaignId, slug: 'klarg', type: 'npc', title: 'Klarg', sourceId });

    const res = await api()
      .delete(`/api/campaigns/${campaignId}/sources/${sourceId}`)
      .set('Cookie', host)
      .expect(204);
    noContent(res.body);

    const notes = await db
      .select({ slug: campaignNotes.slug, sourceId: campaignNotes.sourceId })
      .from(campaignNotes);
    expect(notes).toEqual([{ slug: 'klarg', sourceId: null }]);
    await api()
      .get(`/api/campaigns/${campaignId}/sources/${sourceId}`)
      .set('Cookie', host)
      .expect(404);
  });

  it('deleting a campaign deletes its sources and only its sources', async () => {
    const hostA = await signUp('a@example.com');
    const hostB = await signUp('b@example.com');
    const campaignA = await campaignFor(hostA);
    const campaignB = await campaignFor(hostB);
    await upload(campaignA, hostA).expect(201);
    const kept = (await upload(campaignB, hostB).expect(201)).body.id as string;

    await db.delete(campaigns).where(eq(campaigns.id, campaignA));

    const rows = await db.select({ id: campaignSources.id }).from(campaignSources);
    expect(rows).toEqual([{ id: kept }]);
  });
});
