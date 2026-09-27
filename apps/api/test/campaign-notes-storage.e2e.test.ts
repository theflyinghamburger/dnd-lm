import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { campaignNotes, campaigns, users } from '../src/db/schema';
import type { Db } from '../src/db/db.module';
import { DATABASE_URL, createTestApp, truncateAll } from './app.harness';

/**
 * M8.1 — the `campaign_notes` table, asserted against live Postgres. Storage
 * only: the properties here are the ones the migration itself has to get
 * right, because M8.2 retrieval and Phase 4 ingestion build on them.
 */
describe.skipIf(!DATABASE_URL)('campaign notes storage (M8.1)', () => {
  let app: INestApplication;
  let db: Db;
  let campaignA: string;
  let campaignB: string;

  beforeAll(async () => {
    ({ app, db } = await createTestApp());
  });
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(async () => {
    await truncateAll(db);
    const [u] = await db
      .insert(users)
      .values({ email: 'host@example.com', displayName: 'Host', passwordHash: 'x' })
      .returning({ id: users.id });
    const rows = await db
      .insert(campaigns)
      .values([
        { ownerUserId: u!.id, name: 'A' },
        { ownerUserId: u!.id, name: 'B' },
      ])
      .returning({ id: campaigns.id });
    [campaignA, campaignB] = rows.map((r) => r.id) as [string, string];
  });

  const note = (
    campaignId: string,
    slug: string,
    extra: Partial<typeof campaignNotes.$inferInsert> = {},
  ) =>
    db
      .insert(campaignNotes)
      .values({ campaignId, slug, type: 'location', title: 'Cragmaw Hideout', ...extra })
      .returning({ id: campaignNotes.id });

  it('fills tsv on an INSERT that never mentions it, title weighted above body', async () => {
    const [n] = await note(campaignA, 'location.cragmaw_hideout', {
      bodyMd: 'A goblin cave guarded by Klarg.',
    });
    const [row] = await db.execute<{ tsv: string; hit: boolean }>(
      sql`SELECT tsv::text AS tsv, tsv @@ plainto_tsquery('english', 'klarg goblin') AS hit
          FROM campaign_notes WHERE id = ${n!.id}`,
    );
    expect(row!.hit).toBe(true);
    expect(row!.tsv).toMatch(/'cragmaw':1A/);
    expect(row!.tsv).toMatch(/'klarg':\d+B/);
  });

  it('can answer a tsv @@ plainto_tsquery predicate from the GIN index', async () => {
    await note(campaignA, 'location.cragmaw_hideout');
    // A two-row table always seq-scans; disabling that in one transaction
    // proves the index is usable for the predicate, which is the property.
    const explain = (query: ReturnType<typeof sql>) =>
      db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL enable_seqscan = off`);
        const plan = await tx.execute<{ 'QUERY PLAN': string }>(
          sql`EXPLAIN SELECT id FROM campaign_notes WHERE tsv @@ ${query}`,
        );
        return plan.map((r) => r['QUERY PLAN']).join('\n');
      });
    expect(await explain(sql`plainto_tsquery('english', 'cragmaw')`)).toContain(
      'campaign_notes_tsv_idx',
    );
    // M8.3's any-word shape, exactly as NotesService.retrieve writes it.
    const words = 'cragmaw hideout';
    expect(
      await explain(
        sql`replace(plainto_tsquery('english', ${words})::text, ' & ', ' | ')::tsquery`,
      ),
    ).toContain('campaign_notes_tsv_idx');
  });

  it('rejects a duplicate slug within one campaign and accepts it across two', async () => {
    await note(campaignA, 'npc.klarg');
    await expect(note(campaignA, 'npc.klarg')).rejects.toMatchObject({
      cause: { code: '23505', constraint_name: 'campaign_notes_campaign_slug_key' },
    });
    await expect(note(campaignB, 'npc.klarg')).resolves.toHaveLength(1);
  });

  it('deletes a campaign’s notes with the campaign (FR-611)', async () => {
    await note(campaignA, 'npc.klarg');
    await note(campaignB, 'npc.klarg');
    await db.delete(campaigns).where(eq(campaigns.id, campaignA));
    const left = await db.select({ campaignId: campaignNotes.campaignId }).from(campaignNotes);
    expect(left).toEqual([{ campaignId: campaignB }]);
  });

  it('orders spoiler levels player < dm, so `<=` is the spoiler filter', async () => {
    await note(campaignA, 'lore.public', { spoilerLevel: 'player' });
    await note(campaignA, 'lore.secret', { spoilerLevel: 'dm' });
    const visible = await db
      .select({ slug: campaignNotes.slug })
      .from(campaignNotes)
      .where(sql`${campaignNotes.spoilerLevel} <= 'player'`);
    expect(visible).toEqual([{ slug: 'lore.public' }]);
  });

  it('defaults an unlabelled note to dm-only, published, ungated, hand-authored', async () => {
    const [n] = await note(campaignA, 'item.spider_staff');
    const [row] = await db
      .select({
        spoilerLevel: campaignNotes.spoilerLevel,
        status: campaignNotes.status,
        chapter: campaignNotes.chapter,
        sourceId: campaignNotes.sourceId,
        frontmatter: campaignNotes.frontmatter,
      })
      .from(campaignNotes)
      .where(eq(campaignNotes.id, n!.id));
    expect(row).toEqual({
      spoilerLevel: 'dm',
      status: 'published',
      chapter: null,
      sourceId: null,
      frontmatter: {},
    });
  });

  it('an UPDATE that omits updated_at still moves it, and recomputes tsv', async () => {
    const [n] = await note(campaignA, 'npc.klarg');
    await db.execute(sql`UPDATE campaign_notes SET updated_at = '2000-01-01' WHERE id = ${n!.id}`);
    await db
      .update(campaignNotes)
      .set({ title: 'Klarg the Bugbear' })
      .where(eq(campaignNotes.id, n!.id));
    const [row] = await db.execute<{ moved: boolean; hit: boolean }>(
      sql`SELECT updated_at > '2000-01-01' AS moved, tsv @@ plainto_tsquery('english', 'bugbear') AS hit
          FROM campaign_notes WHERE id = ${n!.id}`,
    );
    expect(row).toEqual({ moved: true, hit: true });
  });
});
