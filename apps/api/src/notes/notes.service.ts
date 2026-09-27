import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { DB, type Db } from '../db/db.module';
import { campaignNotes, noteSpoilerLevel } from '../db/schema';
import { estimateTokens } from '../dm/context';

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
    const q = sql`plainto_tsquery('english', ${input.query})`;
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
}
