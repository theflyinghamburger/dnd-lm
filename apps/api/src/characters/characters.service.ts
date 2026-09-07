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
  parseStoredSheet,
} from '@dnd-lm/contracts';
import { and, eq, sql } from 'drizzle-orm';
import { DB, type Db } from '../db/db.module';
import { characters, pendingActions, sessions } from '../db/schema';

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

  async import(
    userId: string,
    campaignId: string,
    input: ImportCharacterRequest,
  ): Promise<CharacterView> {
    const [row] = await this.db
      .insert(characters)
      .values({
        campaignId,
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

  /**
   * Deleting a character (M4.7 follow-up). Its owner or a host of the campaign;
   * ownership alone is not enough for a host to clean up after a player, and a
   * host's authority does not extend to other campaigns.
   *
   * Refused while the character is named in an **open** pending action:
   * `pending_actions.authorized_character_ids` is a bare `uuid[]` with no foreign
   * key, so deleting mid-request would leave an id pointing at nothing and a roll
   * nobody can satisfy. `rolls.character_id` is `ON DELETE SET NULL` by contrast,
   * so past rolls keep their modifier provenance and stay reconstructible (FR-302).
   */
  async remove(
    characterId: string,
    userId: string,
    campaignId: string,
    isHost: boolean,
  ): Promise<void> {
    const [row] = await this.db
      .select({ id: characters.id, ownerUserId: characters.ownerUserId })
      .from(characters)
      .where(and(eq(characters.id, characterId), eq(characters.campaignId, campaignId)))
      .limit(1);

    // A character in another campaign reads the same as one owned by someone
    // else, so neither is probeable (FR-105).
    if (!row || (row.ownerUserId !== userId && !isHost)) {
      throw new ForbiddenException({ code: 'NOT_YOUR_CHARACTER' });
    }

    // The guard is part of the write, not a check before it. Checking first and
    // deleting second leaves a window in which a DM turn opens a pending action
    // naming this character between the two statements — and the delete would
    // then remove a character an open action still points at, which is exactly
    // what this refuses.
    const openAction = sql`
      select 1 from ${pendingActions}
      join ${sessions} on ${sessions.id} = ${pendingActions.sessionId}
      where ${sessions.campaignId} = ${campaignId}
        and ${pendingActions.status} = 'open'
        and ${characterId}::uuid = any(${pendingActions.authorizedCharacterIds})
    `;
    const deleted = await this.db
      .delete(characters)
      .where(and(eq(characters.id, characterId), sql`not exists (${openAction})`))
      .returning({ id: characters.id });

    if (deleted.length === 0) {
      throw new ConflictException({
        code: 'CHARACTER_HAS_OPEN_ACTION',
        message: 'That character is waiting on a roll. Resolve or cancel it first.',
      });
    }
  }

  /** Derived values are recomputed on read and never persisted as truth (FR-401). */
  private toView(row: typeof characters.$inferSelect): CharacterView {
    const sheet = parseStoredSheet(row.sheet);
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
