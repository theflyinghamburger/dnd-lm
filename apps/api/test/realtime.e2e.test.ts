import type { INestApplication } from '@nestjs/common';
import type { CommandAck, EventEnvelope, ResumeResponse, ServerError } from '@dnd-lm/contracts';
import { eq } from 'drizzle-orm';
import { type Socket, io } from 'socket.io-client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.module';
import { sessionEvents, sessions } from '../src/db/schema';
import { DATABASE_URL, createTestApp, truncateAll } from './app.harness';

/** M2 acceptance: ordering, idempotency and replay (FR-104, FR-107, NFR-104, NFR-201). */
describe.skipIf(!DATABASE_URL)('realtime session gateway', () => {
  let app: INestApplication;
  let db: Db;
  let port: number;
  const open: Socket[] = [];

  beforeAll(async () => {
    ({ app, db, port } = await createTestApp());
  });
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(async () => {
    await truncateAll(db);
  });
  afterEach(() => {
    for (const socket of open.splice(0)) socket.disconnect();
  });

  const api = () => request(app.getHttpServer());

  async function signUp(email: string): Promise<string> {
    const res = await api()
      .post('/api/auth/register')
      .send({ email, displayName: email.split('@')[0], password: 'a-long-enough-password' })
      .expect(201);
    const cookie = res.headers['set-cookie']!;
    return Array.isArray(cookie) ? cookie[0]! : cookie;
  }

  /** Host with a campaign and an open session; `join` adds another member. */
  async function stage(): Promise<{ host: string; campaignId: string; sessionId: string }> {
    const host = await signUp('host@example.com');
    const campaign = await api()
      .post('/api/campaigns')
      .set('Cookie', host)
      .send({ name: 'Lost Mine' })
      .expect(201);
    const session = await api()
      .post(`/api/campaigns/${campaign.body.id}/sessions`)
      .set('Cookie', host)
      .send({})
      .expect(201);
    return { host, campaignId: campaign.body.id, sessionId: session.body.session_id };
  }

  async function join(campaignId: string, hostCookie: string, email: string): Promise<string> {
    const cookie = await signUp(email);
    const invite = await api()
      .post(`/api/campaigns/${campaignId}/invites`)
      .set('Cookie', hostCookie)
      .send({})
      .expect(201);
    await api().post(`/api/invites/${invite.body.token}/accept`).set('Cookie', cookie).expect(201);
    return cookie;
  }

  function connect(sessionId: string, cookie?: string): Promise<Socket> {
    const socket = io(`http://127.0.0.1:${port}`, {
      path: '/ws',
      transports: ['websocket'],
      extraHeaders: cookie ? { Cookie: cookie } : {},
      auth: { sessionId },
      reconnection: false,
    });
    open.push(socket);
    return new Promise((resolve, reject) => {
      socket.on('connect', () => resolve(socket));
      socket.on('connect_error', reject);
    });
  }

  const send = (socket: Socket, event: string, body: unknown): Promise<unknown> =>
    socket.timeout(5000).emitWithAck(event, body);

  describe('handshake (M2.2)', () => {
    it('refuses an unauthenticated connection', async () => {
      const { sessionId } = await stage();
      await expect(connect(sessionId)).rejects.toThrow('NOT_AUTHENTICATED');
    });

    it('refuses a member of no campaign', async () => {
      const { sessionId } = await stage();
      const stranger = await signUp('stranger@example.com');
      await expect(connect(sessionId, stranger)).rejects.toThrow('NOT_A_MEMBER');
    });

    it('refuses an unknown session', async () => {
      const { host } = await stage();
      await expect(connect('11111111-1111-1111-1111-111111111111', host)).rejects.toThrow(
        'SESSION_NOT_FOUND',
      );
    });
  });

  describe('commands (M2.3)', () => {
    it('appends one event and broadcasts it to the room', async () => {
      const { host, campaignId, sessionId } = await stage();
      const player = await join(campaignId, host, 'player@example.com');

      const hostSocket = await connect(sessionId, host);
      const playerSocket = await connect(sessionId, player);

      const delivered = new Promise<EventEnvelope>((resolve) =>
        playerSocket.on('event', resolve as (e: EventEnvelope) => void),
      );

      const ack = (await send(hostSocket, 'command', {
        command_id: 'cmd_1',
        type: 'SEND_MESSAGE',
        session_id: sessionId,
        expected_state_version: 0,
        payload: { content: 'I inspect the altar.', channel: 'in_character' },
      })) as CommandAck;

      // Table chat is not a mutating resolution, so it allocates a sequence and
      // leaves `state_version` alone (M5.4). The two counters are different
      // things: one is log position, the other is state.
      expect(ack).toEqual({ command_id: 'cmd_1', sequence: 1, state_version: 0 });

      const event = await delivered;
      expect(event.type).toBe('MESSAGE_POSTED');
      expect(event.sequence).toBe(1);
      expect(event.session_id).toBe(sessionId);
      expect(event.campaign_id).toBe(campaignId);
    });

    it('replays a duplicate command_id without producing a second event', async () => {
      const { host, sessionId } = await stage();
      const socket = await connect(sessionId, host);

      const command = {
        command_id: 'cmd_repeat',
        type: 'SEND_MESSAGE' as const,
        session_id: sessionId,
        expected_state_version: 0,
        payload: { content: 'again', channel: 'in_character' as const },
      };

      const first = (await send(socket, 'command', command)) as CommandAck;
      const second = (await send(socket, 'command', command)) as CommandAck;
      expect(second).toEqual(first);

      const rows = await db
        .select()
        .from(sessionEvents)
        .where(eq(sessionEvents.sessionId, sessionId));
      expect(rows).toHaveLength(1);

      const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
      expect(session!.stateVersion).toBe(0);
    });

    it('gives two concurrent commands contiguous sequences', async () => {
      const { host, campaignId, sessionId } = await stage();
      const player = await join(campaignId, host, 'player@example.com');
      const a = await connect(sessionId, host);
      const b = await connect(sessionId, player);

      const [first, second] = (await Promise.all([
        send(a, 'command', {
          command_id: 'cmd_a',
          type: 'SEND_MESSAGE',
          session_id: sessionId,
          expected_state_version: 0,
          payload: { content: 'left', channel: 'in_character' },
        }),
        send(b, 'command', {
          command_id: 'cmd_b',
          type: 'SEND_MESSAGE',
          session_id: sessionId,
          expected_state_version: 0,
          payload: { content: 'right', channel: 'in_character' },
        }),
      ])) as [CommandAck, CommandAck];

      expect([first.sequence, second.sequence].sort()).toEqual([1, 2]);

      const rows = await db
        .select()
        .from(sessionEvents)
        .where(eq(sessionEvents.sessionId, sessionId));
      expect(rows.map((r) => r.sequence).sort()).toEqual([1, 2]);
    });

    it('refuses a command addressed to another session', async () => {
      const { host, sessionId } = await stage();
      const socket = await connect(sessionId, host);

      const error = (await send(socket, 'command', {
        command_id: 'cmd_elsewhere',
        type: 'SEND_MESSAGE',
        session_id: '11111111-1111-1111-1111-111111111111',
        expected_state_version: 0,
        payload: { content: 'not yours', channel: 'in_character' },
      })) as ServerError;

      expect(error.code).toBe('NOT_A_MEMBER');
    });

    it('answers a malformed command with a typed error, not a silent drop', async () => {
      const { host, sessionId } = await stage();
      const socket = await connect(sessionId, host);
      const error = (await send(socket, 'command', { nonsense: true })) as ServerError;
      expect(error.code).toBe('INVALID_PAYLOAD');
    });
  });

  describe('resume (M2.4, NFR-104)', () => {
    it('delivers exactly the missed events, in order, with no gaps, under 3s', async () => {
      const { host, sessionId } = await stage();

      // 1,000-event fixture written straight to the log, as if play had happened.
      const total = 1000;
      await db.insert(sessionEvents).values(
        Array.from({ length: total }, (_, i) => ({
          sessionId,
          sequence: i + 1,
          type: 'MESSAGE_POSTED',
          payload: { content: `line ${i + 1}` },
          actor: { type: 'player', id: 'seed' },
          source: { type: 'command', id: `seed_${i + 1}` },
          stateVersion: i + 1,
        })),
      );
      await db
        .update(sessions)
        .set({ nextSequence: total + 1, stateVersion: total })
        .where(eq(sessions.id, sessionId));

      const socket = await connect(sessionId, host);

      const started = Date.now();
      const resumed = (await send(socket, 'resume', { last_sequence: 500 })) as ResumeResponse;
      const elapsed = Date.now() - started;

      expect(resumed.events).toHaveLength(500);
      expect(resumed.events[0]!.sequence).toBe(501);
      expect(resumed.events.at(-1)!.sequence).toBe(total);
      expect(resumed.events.map((e) => e.sequence)).toEqual(
        Array.from({ length: 500 }, (_, i) => 501 + i),
      );
      expect(resumed.snapshot.last_sequence).toBe(total);
      expect(elapsed).toBeLessThan(3000);
    });

    it('returns nothing when the client is already current', async () => {
      const { host, sessionId } = await stage();
      const socket = await connect(sessionId, host);
      const resumed = (await send(socket, 'resume', { last_sequence: 0 })) as ResumeResponse;
      expect(resumed.events).toEqual([]);
      expect(resumed.snapshot.last_sequence).toBe(0);
    });
  });

  describe('rate limits (M2.5)', () => {
    it('rejects a burst with a typed error rather than dropping it', async () => {
      const { host, sessionId } = await stage();
      const socket = await connect(sessionId, host);

      const results = (await Promise.all(
        Array.from({ length: 40 }, (_, i) =>
          send(socket, 'command', {
            command_id: `cmd_flood_${i}`,
            type: 'SEND_MESSAGE',
            session_id: sessionId,
            expected_state_version: 0,
            payload: { content: `spam ${i}`, channel: 'in_character' },
          }),
        ),
      )) as Array<CommandAck | ServerError>;

      const limited = results.filter((r) => 'code' in r && r.code === 'RATE_LIMITED');
      expect(limited.length).toBeGreaterThan(0);
      // Every request is answered — none is silently dropped.
      expect(results).toHaveLength(40);
    });
  });
});
