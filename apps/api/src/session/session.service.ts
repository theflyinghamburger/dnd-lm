import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  type ActorRef,
  type CommandAck,
  type EventEnvelope,
  IllegalTransitionError,
  type SessionSnapshot,
  type SessionState,
  type SourceRef,
  acceptsMutations,
  assertTransition,
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
 * Decides what a resolution is allowed to do (M5.2, M5.4). The split is the
 * whole reason `expected_state_version` can finally be enforced:
 *
 * - `chat` — table talk, `@player`, `@party`, `/ooc`, `/whisper`. No lock, no
 *   version check, and it does **not** bump `state_version`. Chat stays
 *   responsive while the DM generates, and a chatty table does not invalidate
 *   every client's version.
 * - `mutation` — rolls, DM resolutions, anything that starts a DM turn. Takes
 *   the per-session lock, checks the version, bumps it, and is refused while
 *   the session is paused.
 * - `host` — as `mutation`, except a paused session still accepts it: RESUME
 *   and END would otherwise be unreachable from the state they exist to leave.
 */
export type ResolutionMode = 'chat' | 'mutation' | 'host';

/**
 * Builds the events to append. Runs inside the resolution transaction and
 * under its lock, so it may read state it is about to act on — which is how a
 * roll decides whether it closes a pending action without racing (M5.5).
 */
export type Produce = (session: SessionRow, tx: Tx) => EventDraft[] | Promise<EventDraft[]>;

/**
 * Runs inside the resolution transaction, after events are appended and their
 * sequences are known. M3 uses it to write the `messages` row alongside its
 * event so the two can never disagree (M3.3); M5 uses it for the state
 * transition, so narration and mutation commit together (invariant 4).
 */
export type AfterAppend = (
  tx: Tx,
  appended: Array<{ sequence: number }>,
  stateVersion: number,
  session: SessionRow,
) => Promise<void>;

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
      mode: ResolutionMode;
    },
    produce: Produce,
    afterAppend?: AfterAppend,
  ): Promise<{ ack: CommandAck; events: EventEnvelope[] }> {
    // A replay is answered with the original result and no events: they were
    // already published, and the client refetches missed ones with RESUME.
    const replay = await this.storedAck(input.commandId);
    if (replay) return { ack: replay, events: [] };

    const mutating = input.mode !== 'chat';

    try {
      return await this.db.transaction(async (tx) => {
        // M5.2. First statement of a mutating resolution, before anything reads
        // the state it is about to change. Transaction-scoped, so it releases on
        // commit or rollback with no cleanup path to forget.
        //
        // ponytail: the key is a 32-bit hash of the session id, so two unrelated
        // sessions can serialize on a collision. Harmless at MVP scale; move to
        // a dedicated lock table if session concurrency ever makes it measurable.
        if (mutating) {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${input.sessionId}))`);
        }

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

        // M5.6. Checked here rather than in the gateway so every mutating path
        // is covered by construction — including ones M6 has yet to add. Host
        // controls are exempt: resuming and ending a pause happen from PAUSED.
        // One code for both refusing states, with the status in the message:
        // PAUSED and SESSION_ENDED refuse mutations for the same reason, and
        // the client's job in both cases is to stop offering them.
        if (input.mode === 'mutation' && !acceptsMutations(session.status)) {
          throw new ConflictException({
            code: 'SESSION_PAUSED',
            message: `This session is ${session.status}.`,
            state_version: session.stateVersion,
          });
        }

        // M5.4. Under the lock, so the version read here is the one committed
        // against. Rejecting rolls back the `commands` row too, which is what
        // lets the client refetch and retry with the same `command_id`.
        if (mutating && input.expectedStateVersion !== session.stateVersion) {
          throw new ConflictException({
            code: 'STATE_CONFLICT',
            state_version: session.stateVersion,
          });
        }

        const drafts = await produce(session, tx);
        const { firstSequence, stateVersion } = await this.allocate(
          tx,
          session.id,
          drafts.length,
          mutating,
        );

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

        if (afterAppend) await afterAppend(tx, rows, stateVersion, session);

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
   * Allocates `count` sequences, and bumps the state version only for a
   * mutating resolution (M5.4). The row-level lock this takes is what makes
   * concurrent commands on one session produce contiguous sequences instead of
   * a race (M2.1) — `sequence` is the log position, `state_version` is state,
   * and chat moves one without the other.
   */
  private async allocate(
    tx: Tx,
    sessionId: string,
    count: number,
    bumpVersion: boolean,
  ): Promise<{ firstSequence: number; stateVersion: number }> {
    const [row] = await tx
      .update(sessions)
      .set({
        nextSequence: sql`${sessions.nextSequence} + ${count}`,
        ...(bumpVersion ? { stateVersion: sql`${sessions.stateVersion} + 1` } : {}),
      })
      .where(eq(sessions.id, sessionId))
      .returning({ nextSequence: sessions.nextSequence, stateVersion: sessions.stateVersion });

    if (!row) throw new NotFoundException({ code: 'SESSION_NOT_FOUND' });
    return { firstSequence: row.nextSequence - count, stateVersion: row.stateVersion };
  }

  /**
   * The only way a session's status changes (M5.1). The transition table is
   * asserted first, so an illegal move rolls the whole resolution back rather
   * than half-applying it, and the client is told which move was refused.
   */
  async setStatus(
    tx: Tx,
    session: SessionRow,
    to: SessionState,
    pausedFrom: SessionState | null = null,
  ): Promise<void> {
    try {
      assertTransition(session.status, to);
    } catch (error) {
      if (error instanceof IllegalTransitionError) {
        throw new ConflictException({ code: 'ILLEGAL_TRANSITION', message: error.message });
      }
      throw error;
    }
    await tx.update(sessions).set({ status: to, pausedFrom }).where(eq(sessions.id, session.id));
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
