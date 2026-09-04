import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type {
  ActorRef,
  CommandAck,
  EventEnvelope,
  SessionSnapshot,
  SourceRef,
} from '@dnd-lm/contracts';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { DB, type Db } from '../db/db.module';
import { commands, sessionEvents, sessions } from '../db/schema';

/** What a command handler asks to be appended. Sequence and version are not its business. */
export type EventDraft = {
  type: string;
  payload: Record<string, unknown>;
  actor: ActorRef;
  source: SourceRef;
};

export type SessionRow = typeof sessions.$inferSelect;

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Runs inside the resolution transaction, after events are appended and their
 * sequences are known. M3 uses it to write the `messages` row alongside its
 * event so the two can never disagree (M3.3).
 */
export type AfterAppend = (tx: Tx, appended: Array<{ sequence: number }>) => Promise<void>;

/** Postgres unique-violation. A duplicate command_id is expected traffic, not a fault. */
const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505';

@Injectable()
export class SessionService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async create(campaignId: string, sceneId: string | null): Promise<SessionSnapshot> {
    const [session] = await this.db.insert(sessions).values({ campaignId, sceneId }).returning();
    if (!session) throw new Error('session insert returned no row');
    return this.toSnapshot(session);
  }

  async find(sessionId: string): Promise<SessionRow | null> {
    const [session] = await this.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    return session ?? null;
  }

  async listForCampaign(campaignId: string): Promise<SessionSnapshot[]> {
    const rows = await this.db
      .select()
      .from(sessions)
      .where(eq(sessions.campaignId, campaignId))
      .orderBy(asc(sessions.createdAt));
    return rows.map((row) => this.toSnapshot(row));
  }

  async snapshot(sessionId: string): Promise<SessionSnapshot> {
    const session = await this.find(sessionId);
    if (!session) throw new NotFoundException({ code: 'SESSION_NOT_FOUND' });
    return this.toSnapshot(session);
  }

  /**
   * M2.4. Contiguous by construction: `sequence` has no gaps to skip over.
   *
   * Privacy is a `WHERE` predicate, not a post-filter (M3.4, FR-207). Replay is
   * part of the event stream, so a whisper has to be excluded here too — a
   * reconnecting third player must not receive one to drop client-side.
   */
  async eventsSince(
    sessionId: string,
    lastSequence: number,
    viewerId: string,
  ): Promise<EventEnvelope[]> {
    const session = await this.find(sessionId);
    if (!session) throw new NotFoundException({ code: 'SESSION_NOT_FOUND' });

    const rows = await this.db
      .select()
      .from(sessionEvents)
      .where(
        and(
          eq(sessionEvents.sessionId, sessionId),
          gt(sessionEvents.sequence, lastSequence),
          sql`(
            ${sessionEvents.payload}->>'visibility' IS DISTINCT FROM 'private'
            OR ${sessionEvents.actor}->>'id' = ${viewerId}
            OR ${sessionEvents.payload}->'recipient_ids' ? ${viewerId}
          )`,
        ),
      )
      .orderBy(asc(sessionEvents.sequence));

    return rows.map((row) => this.toEnvelope(session.campaignId, row));
  }

  /**
   * The idempotent unit of work (M2.3, NFR-201/202).
   *
   * The `commands` row is claimed *before* any work happens. A concurrent
   * duplicate blocks on the unique index until this transaction commits, then
   * raises 23505 and reads the stored result — so a retry can never produce a
   * second event, whether it arrives after the response or during it.
   */
  async runCommand(
    input: {
      commandId: string;
      sessionId: string;
      senderId: string;
      type: string;
      expectedStateVersion: number;
    },
    produce: (session: SessionRow) => EventDraft[],
    afterAppend?: AfterAppend,
  ): Promise<{ ack: CommandAck; events: EventEnvelope[] }> {
    // A replay is answered with the original result and no events: they were
    // already published, and the client refetches missed ones with RESUME.
    const replay = await this.storedAck(input.commandId);
    if (replay) return { ack: replay, events: [] };

    try {
      return await this.db.transaction(async (tx) => {
        await tx.insert(commands).values({
          commandId: input.commandId,
          sessionId: input.sessionId,
          senderId: input.senderId,
          type: input.type,
        });

        const [session] = await tx
          .select()
          .from(sessions)
          .where(eq(sessions.id, input.sessionId))
          .limit(1);
        if (!session) throw new NotFoundException({ code: 'SESSION_NOT_FOUND' });

        // `expected_state_version` is carried and recorded here but not yet
        // enforced: rejecting a stale version is M5.4, and doing it now would
        // make M2's own acceptance criterion — two concurrent commands produce
        // two events with contiguous sequences — unsatisfiable, since the second
        // command is stale by definition the moment the first commits.
        // The STATE_CONFLICT contract and the client retry path land with M5.4.

        const drafts = produce(session);
        const { firstSequence, stateVersion } = await this.allocate(tx, session.id, drafts.length);

        const rows =
          drafts.length === 0
            ? []
            : await tx
                .insert(sessionEvents)
                .values(
                  drafts.map((draft, offset) => ({
                    sessionId: session.id,
                    sequence: firstSequence + offset,
                    type: draft.type,
                    payload: draft.payload,
                    actor: draft.actor,
                    source: draft.source,
                    stateVersion,
                  })),
                )
                .returning();

        if (afterAppend) await afterAppend(tx, rows);

        const ack: CommandAck = {
          command_id: input.commandId,
          sequence: firstSequence + Math.max(drafts.length - 1, 0),
          state_version: stateVersion,
        };
        await tx
          .update(commands)
          .set({ result: ack })
          .where(eq(commands.commandId, input.commandId));
        return { ack, events: rows.map((row) => this.toEnvelope(session.campaignId, row)) };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        const stored = await this.storedAck(input.commandId);
        // No stored result means the original transaction rolled back after all,
        // so the command never took effect and the caller may retry it.
        if (stored) return { ack: stored, events: [] };
      }
      throw error;
    }
  }

  /**
   * Allocates `count` sequences and bumps the state version, in one statement.
   * The row-level lock this takes is what makes concurrent commands on one
   * session produce contiguous sequences instead of a race (M2.1).
   */
  private async allocate(
    tx: Tx,
    sessionId: string,
    count: number,
  ): Promise<{ firstSequence: number; stateVersion: number }> {
    const [row] = await tx
      .update(sessions)
      .set({
        nextSequence: sql`${sessions.nextSequence} + ${count}`,
        stateVersion: sql`${sessions.stateVersion} + 1`,
      })
      .where(eq(sessions.id, sessionId))
      .returning({ nextSequence: sessions.nextSequence, stateVersion: sessions.stateVersion });

    if (!row) throw new NotFoundException({ code: 'SESSION_NOT_FOUND' });
    return { firstSequence: row.nextSequence - count, stateVersion: row.stateVersion };
  }

  private async storedAck(commandId: string): Promise<CommandAck | null> {
    const [row] = await this.db
      .select({ result: commands.result })
      .from(commands)
      .where(eq(commands.commandId, commandId))
      .limit(1);
    return (row?.result as CommandAck | null) ?? null;
  }

  private toSnapshot(session: SessionRow): SessionSnapshot {
    return {
      session_id: session.id,
      campaign_id: session.campaignId,
      status: session.status,
      state_version: session.stateVersion,
      last_sequence: session.nextSequence - 1,
      scene_id: session.sceneId,
    };
  }

  private toEnvelope(campaignId: string, row: typeof sessionEvents.$inferSelect): EventEnvelope {
    return {
      event_id: row.eventId,
      type: row.type,
      campaign_id: campaignId,
      session_id: row.sessionId,
      sequence: row.sequence,
      state_version: row.stateVersion,
      actor: row.actor as ActorRef,
      source: row.source as SourceRef,
      payload: row.payload as Record<string, unknown>,
      created_at: row.createdAt.toISOString(),
    };
  }
}
