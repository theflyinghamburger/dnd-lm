import { createHash } from 'node:crypto';
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { CampaignSource } from '@dnd-lm/contracts';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { DB, type Db } from '../db/db.module';
import { campaignSources } from '../db/schema';

/**
 * Every column except `content`. The bytes are never selected for a response,
 * so no code path can leak them by forgetting to strip a field.
 */
const view = {
  id: campaignSources.id,
  campaignId: campaignSources.campaignId,
  filename: campaignSources.filename,
  byteSize: campaignSources.byteSize,
  sha256: campaignSources.sha256,
  status: campaignSources.status,
  error: campaignSources.error,
  pagesTotal: campaignSources.pagesTotal,
  pagesDone: campaignSources.pagesDone,
  notesExtracted: campaignSources.notesExtracted,
  uploadedBy: campaignSources.uploadedBy,
  createdAt: campaignSources.createdAt,
  finishedAt: campaignSources.finishedAt,
};

type Row = Omit<CampaignSource, 'createdAt' | 'finishedAt'> & {
  createdAt: Date;
  finishedAt: Date | null;
};

const toSource = (row: Row): CampaignSource => ({
  ...row,
  createdAt: row.createdAt.toISOString(),
  finishedAt: row.finishedAt?.toISOString() ?? null,
});

/** Postgres unique-violation: here, only the one-in-flight partial index. */
const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  ((error as { code?: string }).code === '23505' ||
    (error as { cause?: { code?: string } }).cause?.code === '23505');

@Injectable()
export class SourcesService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Stores the book as `pending` (FR-601). One in-flight ingest per campaign:
   * the partial unique index refuses the insert, so two racing uploads cannot
   * both land, and the 409 names the source in the way.
   */
  async upload(
    campaignId: string,
    userId: string,
    file: { filename: string; buffer: Buffer },
  ): Promise<CampaignSource> {
    try {
      const [row] = await this.db
        .insert(campaignSources)
        .values({
          campaignId,
          uploadedBy: userId,
          filename: file.filename,
          byteSize: file.buffer.length,
          sha256: createHash('sha256').update(file.buffer).digest('hex'),
          content: file.buffer,
        })
        .returning(view);
      if (!row) throw new Error('campaign source insert returned no row');
      return toSource(row);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const [inFlight] = await this.db
        .select(view)
        .from(campaignSources)
        .where(
          and(
            eq(campaignSources.campaignId, campaignId),
            inArray(campaignSources.status, ['pending', 'extracting']),
          ),
        );
      throw new ConflictException({
        code: 'SOURCE_IN_FLIGHT',
        message: 'This campaign already has a book being ingested.',
        source: inFlight ? toSource(inFlight) : null,
      });
    }
  }

  async list(campaignId: string): Promise<CampaignSource[]> {
    const rows = await this.db
      .select(view)
      .from(campaignSources)
      .where(eq(campaignSources.campaignId, campaignId))
      .orderBy(desc(campaignSources.createdAt));
    return rows.map(toSource);
  }

  /** Scoped to the route's campaign: another campaign's id is a 404, not a read. */
  async get(campaignId: string, id: string): Promise<CampaignSource> {
    const [row] = await this.db
      .select(view)
      .from(campaignSources)
      .where(and(eq(campaignSources.campaignId, campaignId), eq(campaignSources.id, id)));
    if (!row) throw new NotFoundException({ code: 'SOURCE_NOT_FOUND' });
    return toSource(row);
  }

  /** Notes extracted from it stay, with `source_id` nulled by the foreign key. */
  async remove(campaignId: string, id: string): Promise<void> {
    const deleted = await this.db
      .delete(campaignSources)
      .where(and(eq(campaignSources.campaignId, campaignId), eq(campaignSources.id, id)))
      .returning({ id: campaignSources.id });
    if (deleted.length === 0) throw new NotFoundException({ code: 'SOURCE_NOT_FOUND' });
  }
}
