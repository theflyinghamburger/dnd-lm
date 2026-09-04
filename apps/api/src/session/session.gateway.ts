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
  ResumeRequest,
  type ResumeResponse,
  type ServerError,
} from '@dnd-lm/contracts';
import type { Server, Socket } from 'socket.io';
import { AuthService, SESSION_COOKIE } from '../auth/auth.service';
import { MembershipService } from '../campaigns/membership.service';
import { SessionService } from './session.service';
import { TokenBucket } from './token-bucket';

/** Burst of 20, sustained 5/s. Generous for typing, tight enough to stop a loop. */
const BUCKET_CAPACITY = 20;
const BUCKET_REFILL_PER_SECOND = 5;

type SocketData = { userId: string; sessionId: string; bucket: TokenBucket };
type SessionSocket = Socket & { data: SocketData };

const room = (sessionId: string): string => `session:${sessionId}`;

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
      bucket: new TokenBucket(BUCKET_CAPACITY, BUCKET_REFILL_PER_SECOND),
    };
  }

  handleConnection(socket: SessionSocket): void {
    void socket.join(room(socket.data.sessionId));
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
      const { ack, events } = await this.sessionService.runCommand(
        {
          commandId: command.command_id,
          sessionId: command.session_id,
          senderId: socket.data.userId,
          type: command.type,
          expectedStateVersion: command.expected_state_version,
        },
        (session) => draftsFor(command, socket.data.userId, session.id),
      );

      // Published only after the transaction commits, so a broadcast failure is
      // recoverable by replay and never leaks uncommitted state (NFR-205).
      for (const event of events) this.server.to(room(command.session_id)).emit('event', event);
      return ack;
    } catch (error) {
      return this.fail(socket, toServerError(error, command.command_id));
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

    const { sessionId } = socket.data;
    return {
      snapshot: await this.sessionService.snapshot(sessionId),
      events: await this.sessionService.eventsSince(sessionId, parsed.data.last_sequence),
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

/**
 * M2 appends the event and stops there. The routing decision, the `messages`
 * row and the DM trigger are M3's, and the dice service is M4's — both replace
 * this body without touching the envelope, ordering or idempotency above.
 */
function draftsFor(command: ClientCommand, userId: string, sessionId: string) {
  const source = { type: 'command' as const, id: command.command_id };
  const actor = { type: 'player' as const, id: userId };

  switch (command.type) {
    case 'SEND_MESSAGE':
      return [{ type: 'MESSAGE_POSTED', payload: { ...command.payload }, actor, source }];
    case 'ROLL_DICE':
      return [
        {
          type: 'ROLL_REQUESTED',
          payload: { ...command.payload, session_id: sessionId },
          actor,
          source,
        },
      ];
  }
}
