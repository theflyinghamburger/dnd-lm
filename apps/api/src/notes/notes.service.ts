import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, lte, or, sql } from 'drizzle-orm';
import type { RosterNpc } from '@dnd-lm/contracts';
import { DB, type Db } from '../db/db.module';
import { campaignNotes, noteSpoilerLevel } from '../db/schema';
import { estimateTokens } from '../dm/tokens';

export type NoteSpoilerLevel = (typeof noteSpoilerLevel.enumValues)[number];

export type RetrievedNote = { slug: string; title: string; body: string };

export type RetrieveInput = {
  campaignId: string;
  query: string;
  /** The highest spoiler level the reader may see (`player` < `dm`). */
  maxSpoilerLevel: NoteSpoilerLevel;
  /**
   * The party's current progression — `campaigns.settings.progression.chapter`,
   * 0 when absent. A note with a null `chapter` is never gated.
   */
  chapter: number;
  tokenCap: number;
};

/** Top-N before the token cap; the cap is the real ceiling, this bounds the fetch. */
export const MAX_CANDIDATES = 20;

/**
 * Keep notes in rank order while their running `estimateTokens(title + body)`
 * fits `tokenCap`; stop at the first that does not. A note is never cut
 * mid-sentence — a half-fact is worse than no fact (FR-609).
 */
export function capNotes(ranked: RetrievedNote[], tokenCap: number): RetrievedNote[] {
  const kept: RetrievedNote[] = [];
  let used = 0;
  for (const n of ranked) {
    used += estimateTokens(n.title + n.body);
    if (used > tokenCap) break;
    kept.push(n);
  }
  return kept;
}

@Injectable()
export class NotesService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Full-text retrieval over one campaign's notes (M8.2, FR-608/609).
   *
   * Invariant 7: every hard filter — campaign, published status, spoiler level,
   * chapter — is a `WHERE` predicate in the same statement as the ranking, so
   * no row outside the reader's scope is ever ranked, let alone returned.
   */
  async retrieve(input: RetrieveInput): Promise<RetrievedNote[]> {
    // ponytail: a note is its own chunk — hand-written notes are small and the
    // layer cap is the real ceiling; heading-level splitting arrives with
    // Phase 4 ingestion, which is also when notes get big enough to need it.
    // M8.3: ANY meaningful word matches, ts_rank orders by how many and
    // where. plainto_tsquery (and the design doc's websearch_to_tsquery) AND
    // every word, and free trigger text ("I search the altar for the key")
    // almost never has all its words in one note. plainto still does the
    // stemming, stop words and quoting; its `&` becomes `|`. A compound word's
    // `<->` phrase stays a phrase.
    const q = sql`replace(plainto_tsquery('english', ${input.query})::text, ' & ', ' | ')::tsquery`;
    const ranked = await this.db
      .select({ slug: campaignNotes.slug, title: campaignNotes.title, body: campaignNotes.bodyMd })
      .from(campaignNotes)
      .where(
        and(
          eq(campaignNotes.campaignId, input.campaignId),
          eq(campaignNotes.status, 'published'),
          lte(campaignNotes.spoilerLevel, input.maxSpoilerLevel),
          or(isNull(campaignNotes.chapter), lte(campaignNotes.chapter, input.chapter)),
          sql`${campaignNotes.tsv} @@ ${q}`,
        ),
      )
      .orderBy(desc(sql`ts_rank(${campaignNotes.tsv}, ${q})`), campaignNotes.slug)
      .limit(MAX_CANDIDATES);
    return capNotes(ranked, input.tokenCap);
  }

  /**
   * The campaign's addressable NPCs for `@npc` routing (M8.4, MVP.md §4.3 rule 4).
   *
   * The same hard filters as `retrieve`, as `WHERE` predicates, at `player`
   * level: the roster is served to every member (`GET …/roster`, the composer
   * preview), so an NPC the party has not met must not be in it at all —
   * addressing one then reads exactly like an unknown NPC (rule 2).
   */
  async npcs(campaignId: string, chapter: number): Promise<RosterNpc[]> {
    const rows = await this.db
      .select({
        slug: campaignNotes.slug,
        title: campaignNotes.title,
        frontmatter: campaignNotes.frontmatter,
      })
      .from(campaignNotes)
      .where(
        and(
          eq(campaignNotes.campaignId, campaignId),
          eq(campaignNotes.type, 'npc'),
          eq(campaignNotes.status, 'published'),
          eq(campaignNotes.spoilerLevel, 'player'),
          or(isNull(campaignNotes.chapter), lte(campaignNotes.chapter, chapter)),
        ),
      )
      .orderBy(campaignNotes.slug);
    return rows.map((r) => ({ id: r.slug, name: r.title, aliases: readAliases(r.frontmatter) }));
  }
}

/** `frontmatter` is host-authored JSONB: a non-array, or a non-string entry, is dropped. */
export function readAliases(frontmatter: unknown): string[] {
  const aliases = (frontmatter as { aliases?: unknown } | null)?.aliases;
  return Array.isArray(aliases) ? aliases.filter((a): a is string => typeof a === 'string') : [];
}
