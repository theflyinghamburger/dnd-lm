import { Logger } from '@nestjs/common';
import {
  type OnGatewayConnection,
  type OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { randomUUID } from 'node:crypto';
import {
  ClientCommand,
  type CommandAck,
  ErrorCode,
  type EventEnvelope,
  type HostControlAction,
  type MembershipRole,
  ResumeRequest,
  type ResumeResponse,
  type RoutingDecision,
  type ServerError,
  type SessionState,
  type TriggerDefinition,
  formatExpression,
  parseMessage,
} from '@dnd-lm/contracts';
import { and, eq, sql } from 'drizzle-orm';
import type { Server, Socket } from 'socket.io';
import { AuthService, SESSION_COOKIE } from '../auth/auth.service';
import { MembershipService } from '../campaigns/membership.service';
import { CharactersService } from '../characters/characters.service';
import { messages, pendingActions, rolls } from '../db/schema';
import { DiceService } from '../dice/dice.service';
import { resolveRollRequest } from '../dice/roll-request';
import { SessionContextService } from '../router/session-context.service';
import { type EventDraft, type SessionRow, SessionService, type Tx } from './session.service';
import { TokenBucket } from './token-bucket';

/** Burst of 20, sustained 5/s. Generous for typing, tight enough to stop a loop. */
const BUCKET_CAPACITY = 20;
const BUCKET_REFILL_PER_SECOND = 5;

type SocketData = {
  userId: string;
  sessionId: string;
  campaignId: string;
  role: MembershipRole;
  /** Chosen at handshake; `/roll perception` needs to know whose sheet to read. */
  activeCharacterId: string | null;
  bucket: TokenBucket;
};
type SessionSocket = Socket & { data: SocketData };

/**
 * M3.3: a posted message always gets its row, in the same transaction as its
 * event. Written once and shared, because the `/roll` path posts a chat line
 * too — and a second copy of this insert is how one of them ends up missing.
 */
async function insertMessageRow(
  tx: Tx,
  row: {
    sessionId: string;
    senderId: string;
    sequence: number;
    decision: Extract<RoutingDecision, { kind: 'route' }>;
    content?: string;
  },
): Promise<void> {
  await tx.insert(messages).values({
    sessionId: row.sessionId,
    senderId: row.senderId,
    recipientType: row.decision.recipientType,
    recipientIds: row.decision.recipientIds,
    channel: row.decision.channel,
    visibility: row.decision.visibility,
    content: row.content ?? row.decision.content,
    sequence: row.sequence,
    triggersDm: row.decision.dmTrigger !== undefined,
    triggerDefinitionId: row.decision.dmTrigger?.definitionId ?? null,
  });
}

const room = (sessionId: string): string => `session:${sessionId}`;
/** Per-user room, so a private event is addressed rather than filtered client-side. */
const userRoom = (sessionId: string, userId: string): string => `session:${sessionId}:u:${userId}`;

/** No `cookie` dependency for three lines of parsing. */
function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

/**
 * One room per session (M2.2). Authentication and membership are settled in
 * handshake middleware, so no message handler re-checks identity — and an
 * unauthorized socket never reaches a handler at all.
 *
 * There is deliberately no `EventBus` abstraction here: socket.io's adapter API
 * is already that seam. Phase 3 multi-instance fanout is
 * `@socket.io/redis-adapter` on the server, with no change to any caller.
 */
@WebSocketGateway({ path: '/ws', serveClient: false, cors: false })
export class SessionGateway implements OnGatewayInit, OnGatewayConnection {
  private readonly logger = new Logger(SessionGateway.name);

  @WebSocketServer()
  private server!: Server;

  constructor(
    private readonly auth: AuthService,
    private readonly memberships: MembershipService,
    private readonly sessionService: SessionService,
    private readonly context: SessionContextService,
    private readonly characters: CharactersService,
    private readonly dice: DiceService,
  ) {}

  afterInit(server: Server): void {
    server.use((socket, next) => {
      void this.authenticate(socket as SessionSocket)
        .then(() => next())
        .catch((error: Error) => next(error));
    });
  }

  private async authenticate(socket: SessionSocket): Promise<void> {
    const token = readCookie(socket.handshake.headers.cookie, SESSION_COOKIE);
    const user = token ? await this.auth.resolveSession(token) : null;
    if (!user) throw new Error('NOT_AUTHENTICATED');

    const sessionId = socket.handshake.auth?.sessionId ?? socket.handshake.query?.sessionId;
    if (typeof sessionId !== 'string') throw new Error('SESSION_NOT_FOUND');

    const session = await this.sessionService.find(sessionId);
    if (!session) throw new Error('SESSION_NOT_FOUND');

    const role = await this.memberships.roleFor(session.campaignId, user.id);
    if (!role) throw new Error('NOT_A_MEMBER');

    const requested = socket.handshake.auth?.characterId;
    // Verified here so a forged id cannot reach a sheet; an unowned one is a
    // refused handshake rather than a socket that fails on its first roll.
    let activeCharacterId: string | null = null;
    if (typeof requested === 'string') {
      try {
        activeCharacterId = (
          await this.characters.requireOwned(requested, user.id, session.campaignId)
        ).id;
      } catch {
        throw new Error('NOT_YOUR_CHARACTER');
      }
    }

    socket.data = {
      userId: user.id,
      sessionId,
      campaignId: session.campaignId,
      role,
      activeCharacterId,
      bucket: new TokenBucket(BUCKET_CAPACITY, BUCKET_REFILL_PER_SECOND),
    };
  }

  handleConnection(socket: SessionSocket): void {
    const { sessionId, userId } = socket.data;
    void socket.join([room(sessionId), userRoom(sessionId, userId)]);
  }

  @SubscribeMessage('command')
  async onCommand(socket: SessionSocket, raw: unknown): Promise<CommandAck | ServerError> {
    if (!socket.data.bucket.take()) {
      return this.fail(socket, { code: 'RATE_LIMITED', message: 'Too many commands.' });
    }

    const parsed = ClientCommand.safeParse(raw);
    if (!parsed.success) {
      return this.fail(socket, { code: 'INVALID_PAYLOAD', message: 'Malformed command.' });
    }
    const command = parsed.data;

    // The socket is bound to one session; a command naming another is refused
    // rather than trusted, and `sender_id` comes from the connection either way.
    if (command.session_id !== socket.data.sessionId) {
      return this.fail(socket, {
        code: 'NOT_A_MEMBER',
        message: 'Command does not belong to this session.',
        command_id: command.command_id,
      });
    }

    try {
      if (command.type === 'SEND_MESSAGE') return await this.sendMessage(socket, command);
      if (command.type === 'REQUEST_ROLL') return await this.requestRoll(socket, command);
      if (command.type === 'HOST_CONTROL') return await this.hostControl(socket, command);
      return await this.rollDice(
        socket,
        command.command_id,
        command.expected_state_version,
        command.payload.expression,
        command.payload.character_id ?? null,
        null,
      );
    } catch (error) {
      return this.fail(socket, toServerError(error, command.command_id));
    }
  }

  /**
   * The whole point of M3: the routing decision is made by a pure function
   * before anything is written, and the DM is activated only when that function
   * says a registered trigger fired (FR-202, FR-206, D-6).
   */
  private async sendMessage(
    socket: SessionSocket,
    command: Extract<ClientCommand, { type: 'SEND_MESSAGE' }>,
  ): Promise<CommandAck | ServerError> {
    const { userId, sessionId, campaignId, role } = socket.data;
    const { registry, roster } = await this.context.forCampaign(campaignId);
    const decision = parseMessage(command.payload.content, roster, registry, { role });

    if (decision.kind === 'reject') {
      return this.fail(socket, {
        code: 'ROUTING_REJECTED',
        message: decision.message,
        reason: decision.code,
        command_id: command.command_id,
      });
    }

    const actor = { type: 'player' as const, id: userId };
    const source = { type: 'command' as const, id: command.command_id };

    const drafts: EventDraft[] = [
      {
        type: 'MESSAGE_POSTED',
        payload: {
          recipient_type: decision.recipientType,
          recipient_ids: decision.recipientIds,
          visibility: decision.visibility,
          channel: decision.channel,
          content: decision.content,
          triggers_dm: decision.dmTrigger !== undefined,
          trigger_definition_id: decision.dmTrigger?.definitionId ?? null,
        },
        actor,
        source,
      },
    ];

    // The DM's activation is its own event, so "did the DM wake, and why?" is a
    // question the event log answers on its own. M6's orchestrator consumes it.
    if (decision.dmTrigger) {
      drafts.push({
        type: 'DM_TRIGGERED',
        payload: {
          definition_id: decision.dmTrigger.definitionId,
          entry_profile: decision.dmTrigger.entryProfile,
          args: decision.dmTrigger.args,
        },
        actor,
        source,
      });
    }

    // A `/roll ...` typed into chat is the same resolution as the button: one
    // command, one transaction, one roll (FR-304 — it is not a DM trigger).
    if (decision.recipientType === 'dice') {
      return this.rollDice(
        socket,
        command.command_id,
        command.expected_state_version,
        decision.argument,
        socket.data.activeCharacterId,
        { decision },
      );
    }

    const { ack, events } = await this.sessionService.runCommand(
      {
        commandId: command.command_id,
        sessionId,
        senderId: userId,
        type: command.type,
        expectedStateVersion: command.expected_state_version,
        // A message that wakes the DM starts a mutating turn, so it takes the
        // lock and the version check. Table talk does neither, which is what
        // keeps chat live while the DM generates (M5.2, M5.4).
        mode: decision.dmTrigger ? 'mutation' : 'chat',
      },
      () => drafts,
      async (tx, appended) =>
        insertMessageRow(tx, {
          sessionId,
          senderId: userId,
          sequence: appended[0]!.sequence,
          decision,
        }),
    );

    this.publish(sessionId, events, decision);
    return ack;
  }

  /**
   * Every published roll comes from here (FR-301). The character's ownership is
   * checked at this point of use, the modifier is read from the server's own
   * derived sheet, and the dice, their sources and the total are stored so the
   * row reconstructs its own breakdown (FR-302, FR-303, FR-305).
   */
  private async rollDice(
    socket: SessionSocket,
    commandId: string,
    expectedStateVersion: number,
    request: string,
    characterId: string | null,
    /** Set when the roll came from a typed `/roll ...`, which is also a chat line. */
    chat: { decision: Extract<RoutingDecision, { kind: 'route' }> } | null,
  ): Promise<CommandAck | ServerError> {
    const { userId, sessionId, campaignId } = socket.data;

    const character = characterId
      ? await this.characters.requireOwned(characterId, userId, campaignId)
      : null;

    const resolved = resolveRollRequest(request, character?.derived ?? null);
    if (!resolved.ok) {
      return this.fail(socket, {
        code: 'ROUTING_REJECTED',
        message: resolved.error,
        reason: 'BAD_ROLL',
        command_id: commandId,
      });
    }

    const rolled = this.dice.roll(resolved.expression, resolved.modifiers);
    const rollId = randomUUID();
    const actor = { type: 'player' as const, id: userId };
    const source = { type: 'command' as const, id: commandId };
    const expression = formatExpression(resolved.expression);

    const drafts: EventDraft[] = [];
    if (chat) {
      drafts.push({
        type: 'MESSAGE_POSTED',
        payload: {
          recipient_type: chat.decision.recipientType,
          recipient_ids: chat.decision.recipientIds,
          visibility: chat.decision.visibility,
          channel: chat.decision.channel,
          content: chat.decision.content,
          triggers_dm: false,
          trigger_definition_id: null,
        },
        actor,
        source,
      });
    }
    drafts.push({
      type: 'ROLL_RESULT',
      payload: {
        roll_id: rollId,
        label: resolved.label,
        expression,
        dice: rolled.dice,
        kept: rolled.kept,
        modifiers: resolved.modifiers,
        total: rolled.total,
        visibility: 'public',
        character_id: character?.id ?? null,
      },
      actor,
      source,
    });

    // Set inside the resolution, under the lock, and read again in
    // `afterAppend` so the roll row and the events agree about what it closed.
    let closedId: string | null = null;
    // Resolved before the transaction opens. Inside it the per-session lock is
    // held, and a cache miss here would hold that lock across a query on a
    // second pooled connection — which is how a busy table deadlocks.
    const resumeTrigger = await this.trigger(campaignId, 'pending_action_completed');

    const { ack, events } = await this.sessionService.runCommand(
      {
        commandId,
        sessionId,
        senderId: userId,
        type: 'ROLL_DICE',
        expectedStateVersion,
        mode: 'mutation',
      },
      async (session, tx) => {
        const closed = await this.closePendingAction(tx, session, character?.id ?? null);
        if (!closed) return drafts;
        closedId = closed.id;

        drafts.push({
          type: 'PENDING_ACTION_COMPLETED',
          payload: {
            pending_action_id: closed.id,
            roll_id: rollId,
            character_id: character?.id ?? null,
            graph_thread_id: closed.graphThreadId,
          },
          actor,
          source,
        });

        // FR-305. The registry says whether a closed action wakes the DM, so a
        // campaign that disabled the trigger sees no activation — rule 7 again.
        // M6 attaches the graph resume to this event; there is no graph to
        // resume yet, so the session simply returns to the players.
        if (resumeTrigger) {
          drafts.push({
            type: 'DM_TRIGGERED',
            payload: {
              definition_id: resumeTrigger.id,
              entry_profile: resumeTrigger.entryProfile,
              args: { text: '', pending_action_id: closed.id },
            },
            actor,
            source,
          });
        }
        return drafts;
      },
      async (tx, appended, stateVersion, session) => {
        if (chat) {
          await insertMessageRow(tx, {
            sessionId,
            senderId: userId,
            sequence: appended[0]!.sequence,
            decision: chat.decision,
          });
        }
        await tx.insert(rolls).values({
          id: rollId,
          sessionId,
          characterId: character?.id ?? null,
          expression,
          dice: rolled.dice,
          modifiers: resolved.modifiers,
          total: rolled.total,
          visibility: 'public',
          requesterId: userId,
          authorizedRollerId: userId,
          pendingActionId: closedId,
          stateVersion,
        });

        if (closedId && session.status === 'WAITING_FOR_ROLL') {
          await this.sessionService.setStatus(tx, session, 'WAITING_FOR_PLAYERS');
        }
      },
    );

    this.publish(sessionId, events, null);
    return ack;
  }

  /**
   * M5.5. A roll closes a pending action only when the action is still open
   * **and** the rolling character is authorized. An unrelated or unauthorized
   * roll is still a perfectly good roll — it just changes nothing and resumes
   * nothing, which is the whole point of the acceptance test.
   *
   * Runs under the resolution lock, so two rolls racing for one action cannot
   * both see it open. At most one action is open per session by construction:
   * opening one parks on `WAITING_FOR_ROLL`, and the transition table refuses
   * a second `WAITING_FOR_ROLL`.
   *
   * ponytail: authorization is by character, not by expression, so an
   * authorized player rolling `1d4` closes a requested Perception check.
   * Matching the expression is an M6 concern, once the graph states what it
   * asked for.
   */
  private async closePendingAction(
    tx: Tx,
    session: SessionRow,
    characterId: string | null,
  ): Promise<typeof pendingActions.$inferSelect | null> {
    if (!characterId) return null;
    const [closed] = await tx
      .update(pendingActions)
      .set({ status: 'completed', completedAt: new Date() })
      .where(
        and(
          eq(pendingActions.sessionId, session.id),
          eq(pendingActions.status, 'open'),
          // Cast explicitly: the column is `uuid[]`, and an uncast text
          // parameter against it is an operator the planner will not resolve.
          sql`${characterId}::uuid = ANY(${pendingActions.authorizedCharacterIds})`,
        ),
      )
      .returning();
    return closed ?? null;
  }

  /** The campaign's enabled definition for an id, or null if it is switched off. */
  private async trigger(campaignId: string, id: string): Promise<TriggerDefinition | null> {
    const { registry } = await this.context.forCampaign(campaignId);
    return registry.find((definition) => definition.id === id) ?? null;
  }

  /**
   * M5.5. The host asks the party for a check: one pending action, and the
   * session parks on `WAITING_FOR_ROLL` until an authorized character rolls.
   * This is the seam M6's graph interrupt reuses rather than a second path.
   */
  private async requestRoll(
    socket: SessionSocket,
    command: Extract<ClientCommand, { type: 'REQUEST_ROLL' }>,
  ): Promise<CommandAck | ServerError> {
    const { userId, sessionId, campaignId } = socket.data;
    const denied = this.requireHost(socket, command.command_id);
    if (denied) return denied;

    // A forged character id must never reach a pending action's authorized set,
    // so every id is checked against this campaign's roster before anything is
    // written — not trusted because the sender happens to be the host.
    const owned = new Set((await this.characters.listForCampaign(campaignId)).map((c) => c.id));
    const unknown = command.payload.character_ids.filter((id) => !owned.has(id));
    if (unknown.length > 0) {
      return this.fail(socket, {
        code: 'CHARACTER_NOT_FOUND',
        message: `Not a character in this campaign: ${unknown.join(', ')}`,
        command_id: command.command_id,
      });
    }

    const actionId = randomUUID();
    const actor = { type: 'host' as const, id: userId };
    const source = { type: 'command' as const, id: command.command_id };

    const { ack, events } = await this.sessionService.runCommand(
      {
        commandId: command.command_id,
        sessionId,
        senderId: userId,
        type: 'REQUEST_ROLL',
        expectedStateVersion: command.expected_state_version,
        mode: 'mutation',
      },
      () => [
        {
          type: 'ROLL_REQUESTED',
          payload: {
            pending_action_id: actionId,
            prompt: command.payload.prompt,
            expression: command.payload.expression,
            authorized_character_ids: command.payload.character_ids,
          },
          actor,
          source,
        },
      ],
      async (tx, _appended, _stateVersion, session) => {
        // Asserted before the insert, so a request made from a state that
        // cannot wait for a roll leaves no orphaned action behind.
        await this.sessionService.setStatus(tx, session, 'WAITING_FOR_ROLL');
        await tx.insert(pendingActions).values({
          id: actionId,
          sessionId,
          type: 'roll',
          requesterId: userId,
          authorizedCharacterIds: command.payload.character_ids,
          payload: { prompt: command.payload.prompt, expression: command.payload.expression },
        });
      },
    );

    this.publish(sessionId, events, null);
    return ack;
  }

  /**
   * M5.6. Pause, resume, end, and force a DM turn. All host-only, all mutating,
   * and all reachable from `PAUSED` — a host who cannot resume from a pause is
   * trapped, so these run in `host` mode and skip the paused-session refusal.
   */
  private async hostControl(
    socket: SessionSocket,
    command: Extract<ClientCommand, { type: 'HOST_CONTROL' }>,
  ): Promise<CommandAck | ServerError> {
    const { userId, sessionId, campaignId } = socket.data;
    const denied = this.requireHost(socket, command.command_id);
    if (denied) return denied;

    const { action } = command.payload;
    const actor = { type: 'host' as const, id: userId };
    const source = { type: 'command' as const, id: command.command_id };
    // Read here rather than inside the resolution: the transaction holds the
    // per-session lock, and a cache miss there would hold it over a query.
    const hostTurn =
      action === 'FORCE_DM_TURN' ? await this.trigger(campaignId, 'host_turn') : null;
    // Only RESUME, END and PAUSE get the paused-session exemption. Forcing a DM
    // turn *is* a trigger, and a pause blocks all triggers (M5.6) — so it runs
    // as an ordinary mutation and is refused like any other.
    const mode = action === 'FORCE_DM_TURN' ? 'mutation' : 'host';

    const { ack, events } = await this.sessionService.runCommand(
      {
        commandId: command.command_id,
        sessionId,
        senderId: userId,
        type: `HOST_${action}`,
        expectedStateVersion: command.expected_state_version,
        mode,
      },
      (session) => {
        const to = nextStatus(session, action);
        // Only a real move is recorded. FORCE_DM_TURN moves nothing, and an
        // event claiming a transition from a state to itself would be a lie in
        // a log that is supposed to be truth (invariant 5).
        const drafts: EventDraft[] =
          to === session.status
            ? []
            : [
                {
                  type: 'SESSION_STATE_CHANGED',
                  payload: { action, from: session.status, to },
                  actor,
                  source,
                },
              ];
        // FORCE_DM_TURN has no graph to call yet; the activation event is the
        // hook M6 consumes, and until then the session stays where it is.
        if (hostTurn) {
          drafts.push({
            type: 'DM_TRIGGERED',
            payload: {
              definition_id: hostTurn.id,
              entry_profile: hostTurn.entryProfile,
              args: { text: '' },
            },
            actor,
            source,
          });
        }
        return drafts;
      },
      async (tx, _appended, _stateVersion, session) => {
        // FORCE_DM_TURN is the only control that moves nothing. Every other one
        // goes through the transition table, so pausing a paused session is
        // refused there rather than quietly succeeding here.
        if (action === 'FORCE_DM_TURN') return;
        await this.sessionService.setStatus(
          tx,
          session,
          nextStatus(session, action),
          action === 'PAUSE' ? session.status : null,
        );
      },
    );

    this.publish(sessionId, events, null);
    return ack;
  }

  /** Host-only commands are refused on role, not by a routing rule (FR-801). */
  private requireHost(socket: SessionSocket, commandId: string): ServerError | null {
    const { role } = socket.data;
    if (role === 'host' || role === 'admin') return null;
    return this.fail(socket, {
      code: 'NOT_THE_HOST',
      message: 'Only the host can do that.',
      command_id: commandId,
    });
  }

  /**
   * M3.4. The recipient set is computed server-side from the decision that was
   * stored. A private message is emitted only to the sender's and target's own
   * rooms — never broadcast for the client to filter.
   */
  private publish(
    sessionId: string,
    events: EventEnvelope[],
    decision: RoutingDecision | null,
  ): void {
    const targets =
      decision?.kind === 'route' && decision.visibility === 'private'
        ? [...new Set([...decision.recipientIds, ...events.map((e) => e.actor.id)])].map((id) =>
            userRoom(sessionId, id),
          )
        : [room(sessionId)];

    for (const event of events) {
      // A DM activation is public even when it followed from a private view of
      // the world; there is no private trigger in the MVP (FR-207).
      const to = event.type === 'DM_TRIGGERED' ? [room(sessionId)] : targets;
      this.server.to(to).emit('event', event);
    }
  }

  @SubscribeMessage('resume')
  async onResume(socket: SessionSocket, raw: unknown): Promise<ResumeResponse | ServerError> {
    if (!socket.data.bucket.take()) {
      return this.fail(socket, { code: 'RATE_LIMITED', message: 'Too many requests.' });
    }

    const parsed = ResumeRequest.safeParse(raw);
    if (!parsed.success) {
      return this.fail(socket, { code: 'INVALID_PAYLOAD', message: 'Malformed resume request.' });
    }

    const { sessionId, userId } = socket.data;
    return {
      snapshot: await this.sessionService.snapshot(sessionId),
      events: await this.sessionService.eventsSince(sessionId, parsed.data.last_sequence, userId),
    };
  }

  /** Every rejection is both acknowledged and emitted — never a silent drop (M2.5). */
  private fail(socket: SessionSocket, error: ServerError): ServerError {
    socket.emit('error', error);
    if (error.code === 'INTERNAL_ERROR') this.logger.error(error.message);
    return error;
  }
}

/**
 * Where a host control moves the session (M5.6). RESUME returns to whatever the
 * pause interrupted, so a parked roll is not dropped on the floor. FORCE_DM_TURN
 * moves nothing — a self-transition is illegal, and the activation is the event.
 */
function nextStatus(session: SessionRow, action: HostControlAction): SessionState {
  switch (action) {
    case 'PAUSE':
      return 'PAUSED';
    case 'RESUME':
      return session.pausedFrom ?? 'WAITING_FOR_PLAYERS';
    case 'END':
      return 'SESSION_ENDED';
    case 'FORCE_DM_TURN':
      return session.status;
  }
}

/**
 * Maps a thrown HTTP-style exception onto the socket error contract. Codes the
 * contract knows are passed through verbatim; anything else becomes
 * INTERNAL_ERROR rather than leaking an unmodelled string to the client.
 */
function toServerError(error: unknown, commandId: string): ServerError {
  const body = (error as { response?: unknown } | null)?.response;
  if (typeof body === 'object' && body !== null && 'code' in body) {
    const typed = body as { code: string; message?: string; state_version?: number };
    const known = ErrorCode.safeParse(typed.code);
    return {
      code: known.success ? known.data : 'INTERNAL_ERROR',
      message: typed.message ?? typed.code,
      command_id: commandId,
      ...(typed.state_version === undefined ? {} : { state_version: typed.state_version }),
    };
  }
  return {
    code: 'INTERNAL_ERROR',
    message: error instanceof Error ? error.message : 'Unknown failure',
    command_id: commandId,
  };
}
