import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  type CharacterSheet,
  type DerivedSheet,
  type ImportCharacterRequest,
  type UpdateHpRequest,
  deriveSheet,
} from '@dnd-lm/contracts';
import { and, eq, sql } from 'drizzle-orm';
import { DB, type Db } from '../db/db.module';
import { characters } from '../db/schema';

export type CharacterView = {
  id: string;
  campaignId: string;
  ownerUserId: string;
  name: string;
  sheet: CharacterSheet;
  derived: DerivedSheet;
  stateVersion: number;
};

@Injectable()
export class CharactersService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async import(userId: string, input: ImportCharacterRequest): Promise<CharacterView> {
    const [row] = await this.db
      .insert(characters)
      .values({
        campaignId: input.campaignId,
        ownerUserId: userId,
        name: input.name,
        // Already validated against the SRD subset by the pipe. Derived values
        // in the payload were rejected there, not stripped here (D-3).
        sheet: input.sheet,
      })
      .returning();
    if (!row) throw new Error('character insert returned no row');
    return this.toView(row);
  }

  async listForCampaign(campaignId: string): Promise<CharacterView[]> {
    const rows = await this.db
      .select()
      .from(characters)
      .where(eq(characters.campaignId, campaignId));
    return rows.map((row) => this.toView(row));
  }

  async get(characterId: string): Promise<CharacterView> {
    const [row] = await this.db
      .select()
      .from(characters)
      .where(eq(characters.id, characterId))
      .limit(1);
    if (!row) throw new NotFoundException({ code: 'CHARACTER_NOT_FOUND' });
    return this.toView(row);
  }

  /**
   * Ownership is checked at the point of use, never at connect time (FR-105,
   * M1.3). A character in another campaign is refused with the same error as
   * one owned by another player, so neither is probeable.
   */
  async requireOwned(
    characterId: string,
    userId: string,
    campaignId: string,
  ): Promise<CharacterView> {
    const [row] = await this.db
      .select()
      .from(characters)
      .where(and(eq(characters.id, characterId), eq(characters.campaignId, campaignId)))
      .limit(1);

    if (!row || row.ownerUserId !== userId) {
      throw new ForbiddenException({ code: 'NOT_YOUR_CHARACTER' });
    }
    return this.toView(row);
  }

  /**
   * Current HP is an *input*, so it lives in the sheet — but it is the only one
   * a player edits mid-session, and it is guarded by the character's own
   * `stateVersion` so a stale tab cannot undo a heal (M4.6).
   */
  async updateHp(
    characterId: string,
    userId: string,
    campaignId: string,
    input: UpdateHpRequest,
  ): Promise<CharacterView> {
    const current = await this.requireOwned(characterId, userId, campaignId);
    if (input.currentHp > current.sheet.maxHp) {
      throw new ConflictException({ code: 'HP_ABOVE_MAX', max: current.sheet.maxHp });
    }

    const [row] = await this.db
      .update(characters)
      .set({
        sheet: sql`jsonb_set(${characters.sheet}, '{currentHp}', ${String(input.currentHp)}::jsonb)`,
        stateVersion: sql`${characters.stateVersion} + 1`,
      })
      .where(
        and(
          eq(characters.id, characterId),
          eq(characters.stateVersion, input.expectedStateVersion),
        ),
      )
      .returning();

    if (!row) {
      throw new ConflictException({
        code: 'STATE_CONFLICT',
        state_version: current.stateVersion,
      });
    }
    return this.toView(row);
  }

  /** Derived values are recomputed on read and never persisted as truth (FR-401). */
  private toView(row: typeof characters.$inferSelect): CharacterView {
    const sheet = row.sheet as CharacterSheet;
    return {
      id: row.id,
      campaignId: row.campaignId,
      ownerUserId: row.ownerUserId,
      name: row.name,
      sheet,
      derived: deriveSheet(sheet),
      stateVersion: row.stateVersion,
    };
  }
}
