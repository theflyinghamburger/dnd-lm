import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { campaignNotes, campaigns, users } from '../src/db/schema';
import type { Db } from '../src/db/db.module';
import { estimateTokens } from '../src/dm/context';
import { MAX_CANDIDATES, NotesService, type RetrieveInput } from '../src/notes/notes.service';
import { DATABASE_URL, createTestApp, truncateAll } from './app.harness';

/**
 * M8.2 — retrieval, asserted at the query layer against live Postgres
 * (FR-608/609, invariant 7). Every excluded note is a *stronger* text match
 * than the note that comes back, so ranking cannot be what hid it.
 */
describe.skipIf(!DATABASE_URL)('notes retrieval (M8.2)', () => {
  let app: INestApplication;
  let db: Db;
  let notes: NotesService;
  let campaignA: string;
  let campaignB: string;

  beforeAll(async () => {
    ({ app, db } = await createTestApp());
    notes = app.get(NotesService);
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

  // Title and body both say Klarg: the best possible match for "klarg".
  const BEST = { title: 'Klarg', bodyMd: 'Klarg the bugbear. Klarg rules the cave. Klarg.' };
  // Body mention only: a strictly weaker match.
  const WEAK = { title: 'Cragmaw Hideout', bodyMd: 'A cave; its boss is Klarg.' };

  const seed = (rows: Array<Partial<typeof campaignNotes.$inferInsert> & { slug: string }>) =>
    db.insert(campaignNotes).values(
      rows.map((r) => ({
        campaignId: campaignA,
        type: 'lore' as const,
        title: 'Untitled',
        spoilerLevel: 'player' as const,
        ...r,
      })),
    );

  const ask = (over: Partial<RetrieveInput> = {}) =>
    notes.retrieve({
      campaignId: campaignA,
      query: 'klarg',
      maxSpoilerLevel: 'player',
      chapter: 0,
      tokenCap: 1000,
      ...over,
    });
  const slugs = async (over: Partial<RetrieveInput> = {}) => (await ask(over)).map((n) => n.slug);

  it("never returns another campaign's note, even with identical text (FR-608)", async () => {
    await seed([
      { slug: 'b.klarg', campaignId: campaignB, ...BEST },
      { slug: 'a.hideout', ...WEAK },
    ]);
    expect(await slugs()).toEqual(['a.hideout']);
    expect(await slugs({ campaignId: campaignB })).toEqual(['b.klarg']);
  });

  it("never returns a note above the party's chapter; a null chapter is never gated", async () => {
    await seed([
      { slug: 'future', chapter: 3, ...BEST },
      { slug: 'ungated', chapter: null, ...WEAK },
    ]);
    expect(await slugs({ chapter: 0 })).toEqual(['ungated']);
    expect(await slugs({ chapter: 2 })).toEqual(['ungated']);
    expect(await slugs({ chapter: 3 })).toEqual(['future', 'ungated']);
  });

  it('never returns a dm note to a player reader; returns it at dm (FR-608)', async () => {
    await seed([
      { slug: 'secret', spoilerLevel: 'dm', ...BEST },
      { slug: 'public', ...WEAK },
    ]);
    expect(await slugs({ maxSpoilerLevel: 'player' })).toEqual(['public']);
    expect(await slugs({ maxSpoilerLevel: 'dm' })).toEqual(['secret', 'public']);
  });

  it('never returns a draft note, at any spoiler level or chapter', async () => {
    await seed([
      { slug: 'draft', status: 'draft', ...BEST },
      { slug: 'published', ...WEAK },
    ]);
    expect(await slugs({ maxSpoilerLevel: 'dm', chapter: 99 })).toEqual(['published']);
  });

  it('filters before ranking: out-of-scope best matches never crowd out an in-scope note', async () => {
    // Each exclusion alone supplies more best matches than the candidate
    // limit. A filter applied after rank-and-limit would see only these.
    const over = (tag: string, extra: Partial<typeof campaignNotes.$inferInsert>) =>
      Array.from({ length: MAX_CANDIDATES + 1 }, (_, i) => ({
        slug: `${tag}.${i}`,
        ...BEST,
        ...extra,
      }));
    await seed([
      ...over('dm', { spoilerLevel: 'dm' }),
      ...over('future', { chapter: 5 }),
      ...over('draft', { status: 'draft' }),
      ...over('other', { campaignId: campaignB }),
      { slug: 'visible', ...WEAK },
    ]);
    expect(await slugs()).toEqual(['visible']);
  });

  it('ranks a title match above a body match and carries slug + title as citations (FR-609)', async () => {
    // One occurrence each, so only the A/B weight separates them; the body
    // note has the smaller slug, so a weight collapse flips the order.
    const title = { title: 'Klarg', bodyMd: 'A bugbear chief.' };
    const body = { title: 'Cragmaw Hideout', bodyMd: 'Its boss is Klarg.' };
    await seed([
      { slug: 'a.body', ...body },
      { slug: 'b.title', ...title },
      { slug: 'unrelated', title: 'Phandalin', bodyMd: 'A frontier town.' },
    ]);
    expect(await ask()).toEqual([
      { slug: 'b.title', title: title.title, body: title.bodyMd },
      { slug: 'a.body', title: body.title, body: body.bodyMd },
    ]);
  });

  it('stems the query with the same english config as the tsv column', async () => {
    await seed([{ slug: 'rules', title: 'Goblin rules', bodyMd: 'The rules of the cave.' }]);
    expect(await slugs({ query: 'ruling' })).toEqual(['rules']);
  });

  it('matches ANY meaningful word of a free trigger sentence, ranked by how many (M8.3)', async () => {
    // No note holds every word of the sentence; AND semantics would return [].
    await seed([
      { slug: 'altar', title: 'The altar', bodyMd: 'A rusted key lies beneath the altar stone.' },
      { slug: 'door', title: 'North door', bodyMd: 'Locked. The key is elsewhere.' },
      { slug: 'town', title: 'Phandalin', bodyMd: 'A frontier town.' },
    ]);
    expect(await slugs({ query: '@dm I search the altar for the key' })).toEqual(['altar', 'door']);
    // Stop words only, or punctuation only: no lexemes, no match, no error.
    expect(await slugs({ query: 'I am the' })).toEqual([]);
    expect(await slugs({ query: "!!! & | ' :*" })).toEqual([]);
  });

  it('holds the token cap and keeps the highest-ranked notes (FR-609)', async () => {
    // Descending match strength: n0 says klarg most often.
    const rows = Array.from({ length: 5 }, (_, i) => ({
      slug: `n${i}`,
      title: `Note ${i}`,
      bodyMd: `${'klarg '.repeat(5 - i)}${'filler '.repeat(20)}`,
    }));
    await seed(rows);
    const cost = (r: (typeof rows)[number]) => estimateTokens(r.title + r.bodyMd);
    const total = rows.reduce((s, r) => s + cost(r), 0);
    const tokenCap = cost(rows[0]!) + cost(rows[1]!) + 1;
    expect(total).toBeGreaterThan(tokenCap);

    const got = await ask({ tokenCap });
    // Whole notes, bodies untouched: the cap drops notes, never truncates one.
    expect(got).toEqual(
      rows.slice(0, 2).map((r) => ({ slug: r.slug, title: r.title, body: r.bodyMd })),
    );
    expect(got.reduce((s, n) => s + estimateTokens(n.title + n.body), 0)).toBeLessThanOrEqual(
      tokenCap,
    );
  });
});
