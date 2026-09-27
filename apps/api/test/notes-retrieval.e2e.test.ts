import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { campaignNotes, campaigns, users } from '../src/db/schema';
import type { Db } from '../src/db/db.module';
import { estimateTokens } from '../src/dm/context';
import { NotesService, type RetrieveInput } from '../src/notes/notes.service';
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
    // More out-of-scope best matches than the candidate limit. A filter applied
    // after rank-and-limit would see only these and return nothing.
    const hidden = Array.from({ length: 30 }, (_, i) => ({ slug: `hidden.${i}`, ...BEST }));
    await seed([
      ...hidden.slice(0, 10).map((h) => ({ ...h, spoilerLevel: 'dm' as const })),
      ...hidden.slice(10, 20).map((h) => ({ ...h, chapter: 5 })),
      ...hidden.slice(20).map((h) => ({ ...h, status: 'draft' as const })),
      { slug: 'visible', ...WEAK },
    ]);
    await db.insert(campaignNotes).values(
      Array.from({ length: 30 }, (_, i) => ({
        campaignId: campaignB,
        slug: `other.${i}`,
        type: 'lore' as const,
        spoilerLevel: 'player' as const,
        ...BEST,
      })),
    );
    expect(await slugs()).toEqual(['visible']);
  });

  it('ranks a title match above a body match and carries slug + title as citations (FR-609)', async () => {
    await seed([
      { slug: 'body', ...WEAK },
      { slug: 'title', ...BEST },
      { slug: 'unrelated', title: 'Phandalin', bodyMd: 'A frontier town.' },
    ]);
    expect(await ask()).toEqual([
      { slug: 'title', title: BEST.title, body: BEST.bodyMd },
      { slug: 'body', title: WEAK.title, body: WEAK.bodyMd },
    ]);
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
