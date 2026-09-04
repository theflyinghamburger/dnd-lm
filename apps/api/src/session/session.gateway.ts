import { Logger } from '@nestjs/common';
import {
  type OnGatewayConnection,
  type OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import {
  ClientCommand,
  type CommandAck,
  type EventEnvelope,
  type MembershipRole,
  ResumeRequest,
  type ResumeResponse,
  type RoutingDecision,
  type ServerError,
  parseMessage,
} from '@dnd-lm/contracts';
import type { Server, Socket } from 'socket.io';
import { AuthService, SESSION_COOKIE } from '../auth/auth.service';
import { MembershipService } from '../campaigns/membership.service';
import { messages } from '../db/schema';
import { SessionContextService } from '../router/session-context.service';
import { type EventDraft, SessionService } from './session.service';
import { TokenBucket } from './token-bucket';

/** Burst of 20, sustained 5/s. Generous for typing, tight enough to stop a loop. */
const BUCKET_CAPACITY = 20;
const BUCKET_REFILL_PER_SECOND = 5;

type SocketData = {
  userId: string;
  sessionId: string;
  campaignId: string;
  role: MembershipRole;
  bucket: TokenBucket;
};
type SessionSocket = Socket & { data: SocketData };

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

    socket.data = {
      userId: user.id,
      sessionId,
      campaignId: session.campaignId,
      role,
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

      const { ack, events } = await this.sessionService.runCommand(
        {
          commandId: command.command_id,
          sessionId: command.session_id,
          senderId: socket.data.userId,
          type: command.type,
          expectedStateVersion: command.expected_state_version,
        },
        () => [
          {
            type: 'ROLL_REQUESTED',
            payload: { ...command.payload },
            actor: { type: 'player', id: socket.data.userId },
            source: { type: 'command', id: command.command_id },
          },
        ],
      );
      this.publish(socket.data.sessionId, events, null);
      return ack;
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

    const { ack, events } = await this.sessionService.runCommand(
      {
        commandId: command.command_id,
        sessionId,
        senderId: userId,
        type: command.type,
        expectedStateVersion: command.expected_state_version,
      },
      () => drafts,
      // M3.3: the row lands in the same transaction as its event, so the two
      // can never disagree about what was said or which trigger fired.
      async (tx, appended) => {
        await tx.insert(messages).values({
          sessionId,
          senderId: userId,
          recipientType: decision.recipientType,
          recipientIds: decision.recipientIds,
          channel: decision.channel,
          visibility: decision.visibility,
          content: decision.content,
          sequence: appended[0]!.sequence,
          triggersDm: decision.dmTrigger !== undefined,
          triggerDefinitionId: decision.dmTrigger?.definitionId ?? null,
        });
      },
    );

    this.publish(sessionId, events, decision);
    return ack;
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

function toServerError(error: unknown, commandId: string): ServerError {
  const body = (error as { response?: unknown } | null)?.response;
  if (typeof body === 'object' && body !== null && 'code' in body) {
    const typed = body as { code: string; state_version?: number };
    return {
      code: typed.code === 'STATE_CONFLICT' ? 'STATE_CONFLICT' : 'SESSION_NOT_FOUND',
      message: typed.code,
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
