import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type {
  CampaignNote,
  CampaignNoteSummary,
  CreateNoteRequest,
  UpdateNoteRequest,
} from '@dnd-lm/contracts';
import { and, asc, eq } from 'drizzle-orm';
import { DB, type Db } from '../db/db.module';
import { campaignNotes } from '../db/schema';
import { SessionContextService } from '../router/session-context.service';

const summaryColumns = {
  slug: campaignNotes.slug,
  type: campaignNotes.type,
  title: campaignNotes.title,
  frontmatter: campaignNotes.frontmatter,
  spoilerLevel: campaignNotes.spoilerLevel,
  chapter: campaignNotes.chapter,
  status: campaignNotes.status,
  sourceId: campaignNotes.sourceId,
  updatedAt: campaignNotes.updatedAt,
};
const noteColumns = { ...summaryColumns, bodyMd: campaignNotes.bodyMd };

const toNote = <T extends { frontmatter: unknown; updatedAt: Date }>(row: T) => ({
  ...row,
  frontmatter: row.frontmatter as Record<string, unknown>,
  updatedAt: row.updatedAt.toISOString(),
});

/** Drizzle wraps the driver error; the pg code sits on `cause`. */
const isSlugCollision = (error: unknown): boolean => {
  const cause = (error as { cause?: { code?: string; constraint_name?: string } })?.cause;
  return cause?.code === '23505' && cause.constraint_name === 'campaign_notes_campaign_slug_key';
};

/**
 * M8.5 — host CRUD over `campaign_notes` (FR-611). Plain DB writes, not
 * `runCommand`: a note is campaign preparation, not session state, so it takes
 * no lock and moves no `state_version` (the M7.4 precedent). Every query is
 * keyed on `campaign_id` as well as `slug`, so a route guarded for campaign A
 * can never read or write a row of campaign B.
 *
 * Every write invalidates the campaign's cached routing context: the NPC
 * roster (M8.4) is built from notes, and a stale cache would keep resolving a
 * deleted NPC (docs/campaign-pdf-ingestion.md §3.3).
 */
@Injectable()
export class NotesAdminService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly context: SessionContextService,
  ) {}

  async list(campaignId: string): Promise<CampaignNoteSummary[]> {
    const rows = await this.db
      .select(summaryColumns)
      .from(campaignNotes)
      .where(eq(campaignNotes.campaignId, campaignId))
      .orderBy(asc(campaignNotes.type), asc(campaignNotes.title), asc(campaignNotes.slug));
    return rows.map(toNote);
  }

  async get(campaignId: string, slug: string): Promise<CampaignNote> {
    const [row] = await this.db
      .select(noteColumns)
      .from(campaignNotes)
      .where(this.key(campaignId, slug))
      .limit(1);
    if (!row) throw new NotFoundException({ code: 'NOTE_NOT_FOUND', slug });
    return toNote(row);
  }

  async create(campaignId: string, input: CreateNoteRequest): Promise<CampaignNote> {
    const [row] = await this.db
      .insert(campaignNotes)
      .values({ ...input, campaignId })
      .returning(noteColumns)
      .catch((error: unknown) => this.rethrow(error, input.slug));
    this.context.invalidate(campaignId);
    return toNote(row!);
  }

  async update(campaignId: string, slug: string, input: UpdateNoteRequest): Promise<CampaignNote> {
    const [row] = await this.db
      .update(campaignNotes)
      .set(input)
      .where(this.key(campaignId, slug))
      .returning(noteColumns);
    if (!row) throw new NotFoundException({ code: 'NOTE_NOT_FOUND', slug });
    this.context.invalidate(campaignId);
    return toNote(row);
  }

  async remove(campaignId: string, slug: string): Promise<void> {
    const [row] = await this.db
      .delete(campaignNotes)
      .where(this.key(campaignId, slug))
      .returning({ id: campaignNotes.id });
    if (!row) throw new NotFoundException({ code: 'NOTE_NOT_FOUND', slug });
    this.context.invalidate(campaignId);
  }

  private key(campaignId: string, slug: string) {
    return and(eq(campaignNotes.campaignId, campaignId), eq(campaignNotes.slug, slug));
  }

  private rethrow(error: unknown, slug: string): never {
    if (isSlugCollision(error)) {
      throw new ConflictException({
        code: 'NOTE_SLUG_TAKEN',
        slug,
        reason: `slug "${slug}" is already used by another note in this campaign`,
      });
    }
    throw error;
  }
}
