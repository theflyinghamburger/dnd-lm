import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import type { CommandAck, EventEnvelope, ServerError } from '@dnd-lm/contracts';
import { eq } from 'drizzle-orm';
import { type Socket, io } from 'socket.io-client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.module';
import { pendingActions, rolls, sessionEvents, sessions } from '../src/db/schema';
import { SessionService } from '../src/session/session.service';
import { DATABASE_URL, createTestApp, truncateAll } from './app.harness';

const pregen = (file: string): { name: string; sheet: unknown } =>
  JSON.parse(readFileSync(join(process.cwd(), 'fixtures/pregens', file), 'utf8')) as {
    name: string;
    sheet: unknown;
  };

const isError = (result: unknown): result is ServerError =>
  typeof result === 'object' && result !== null && 'code' in result;

/**
 * M5 acceptance: per-session serialization, optimistic concurrency, pending
 * actions and host controls (FR-106, FR-305, FR-801, NFR-202, NFR-203, NFR-204).
 */
describe.skipIf(!DATABASE_URL)('session orchestrator', () => {
  let app: INestApplication;
  let db: Db;
  let port: number;
  const open: Socket[] = [];
  let counter = 0;

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

  async function signUp(email: string, displayName: string): Promise<string> {
    const res = await api()
      .post('/api/auth/register')
      .send({ email, displayName, password: 'a-long-enough-password' })
      .expect(201);
    const cookie = res.headers['set-cookie']!;
    return Array.isArray(cookie) ? cookie[0]! : cookie;
  }

  type Table = {
    campaignId: string;
    sessionId: string;
    host: string;
    aria: string;
    brann: string;
    /** Aria's character, and Brann's. Both needed: authorization is per character. */
    ariaCharacter: string;
    brannCharacter: string;
  };

  /** A host and two players, each with an imported pregen to roll as. */
  async function stage(): Promise<Table> {
    const host = await signUp('ferris@example.com', 'Ferris');
    const campaign = await api()
      .post('/api/campaigns')
      .set('Cookie', host)
      .send({ name: 'Lost Mine' })
      .expect(201);
    const campaignId = campaign.body.id as string;

    const invite = async (cookie: string): Promise<void> => {
      const created = await api()
        .post(`/api/campaigns/${campaignId}/invites`)
        .set('Cookie', host)
        .send({})
        .expect(201);
      await api()
        .post(`/api/invites/${created.body.token}/accept`)
        .set('Cookie', cookie)
        .expect(201);
    };

    const aria = await signUp('aria@example.com', 'Aria');
    const brann = await signUp('brann@example.com', 'Brann');
    await invite(aria);
    await invite(brann);

    const importFor = async (cookie: string, file: string): Promise<string> => {
      const res = await api()
        .post(`/api/campaigns/${campaignId}/characters/import`)
        .set('Cookie', cookie)
        .send(pregen(file))
        .expect(201);
      return res.body.id as string;
    };

    const session = await api()
      .post(`/api/campaigns/${campaignId}/sessions`)
      .set('Cookie', host)
      .send({})
      .expect(201);

    return {
      campaignId,
      sessionId: session.body.session_id as string,
      host,
      aria,
      brann,
      ariaCharacter: await importFor(aria, 'aria-sunhollow.json'),
      brannCharacter: await importFor(brann, 'brann-ironfell.json'),
    };
  }

  function connect(sessionId: string, cookie: string, characterId?: string): Promise<Socket> {
    const socket = io(`http://127.0.0.1:${port}`, {
      path: '/ws',
      transports: ['websocket'],
      extraHeaders: { Cookie: cookie },
      auth: { sessionId, ...(characterId ? { characterId } : {}) },
      reconnection: false,
    });
    open.push(socket);
    return new Promise((resolve, reject) => {
      socket.on('connect', () => resolve(socket));
      socket.on('connect_error', reject);
    });
  }

  const command = (socket: Socket, body: Record<string, unknown>): Promise<unknown> =>
    socket.timeout(5000).emitWithAck('command', { command_id: `cmd_${(counter += 1)}`, ...body });

  const say = (socket: Socket, sessionId: string, content: string, version = 0) =>
    command(socket, {
      type: 'SEND_MESSAGE',
      session_id: sessionId,
      expected_state_version: version,
      payload: { content, channel: 'in_character' },
    });

  const roll = (socket: Socket, sessionId: string, characterId: string, version: number) =>
    command(socket, {
      type: 'ROLL_DICE',
      session_id: sessionId,
      expected_state_version: version,
      payload: { expression: '1d20', character_id: characterId },
    });

  const hostControl = (socket: Socket, sessionId: string, action: string, version: number) =>
    command(socket, {
      type: 'HOST_CONTROL',
      session_id: sessionId,
      expected_state_version: version,
      payload: { action },
    });

  const requestRoll = (
    socket: Socket,
    sessionId: string,
    characterIds: string[],
    version: number,
  ) =>
    command(socket, {
      type: 'REQUEST_ROLL',
      session_id: sessionId,
      expected_state_version: version,
      payload: {
        expression: 'perception',
        prompt: 'Perception check',
        character_ids: characterIds,
      },
    });

  const status = async (sessionId: string): Promise<string> => {
    const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    return row!.status;
  };

  /** Opens a pending action and returns the version to quote next. */
  async function park(table: Table, authorized: string[]): Promise<number> {
    const hostSocket = await connect(table.sessionId, table.host);
    const ack = (await requestRoll(hostSocket, table.sessionId, authorized, 0)) as CommandAck;
    expect(ack.state_version).toBe(1);
    expect(await status(table.sessionId)).toBe('WAITING_FOR_ROLL');
    return ack.state_version;
  }

  describe('per-session serialization (M5.2, NFR-202)', () => {
    it('lets only one of two simultaneous rolls close a pending action', async () => {
      const table = await stage();
      const version = await park(table, [table.ariaCharacter, table.brannCharacter]);

      const ariaSocket = await connect(table.sessionId, table.aria, table.ariaCharacter);
      const brannSocket = await connect(table.sessionId, table.brann, table.brannCharacter);

      // Real parallel connections, both quoting the same version — not two
      // sequential calls, which would never exercise the lock.
      const results = await Promise.all([
        roll(ariaSocket, table.sessionId, table.ariaCharacter, version),
        roll(brannSocket, table.sessionId, table.brannCharacter, version),
      ]);

      // One wins; the other is told the version it must refetch to.
      const accepted = results.filter((r) => !isError(r)) as CommandAck[];
      const refused = results.filter(isError);
      expect(accepted).toHaveLength(1);
      expect(refused).toHaveLength(1);
      expect(refused[0]!.code).toBe('STATE_CONFLICT');
      expect(refused[0]!.state_version).toBe(accepted[0]!.state_version);

      // The resource itself was spent exactly once.
      const actions = await db.select().from(pendingActions);
      expect(actions).toHaveLength(1);
      expect(actions[0]!.status).toBe('completed');

      const stored = await db.select().from(rolls);
      expect(stored).toHaveLength(1);
      expect(stored[0]!.pendingActionId).toBe(actions[0]!.id);

      const events = await db.select().from(sessionEvents);
      expect(events.filter((e) => e.type === 'PENDING_ACTION_COMPLETED')).toHaveLength(1);
      expect(await status(table.sessionId)).toBe('WAITING_FOR_PLAYERS');
    });

    it('leaves the version and the event log untouched when a resolution throws', async () => {
      const table = await stage();
      const service = app.get(SessionService);
      const before = await service.snapshot(table.sessionId);

      await expect(
        service.runCommand(
          {
            commandId: 'cmd_boom',
            sessionId: table.sessionId,
            senderId: (await api().get('/api/auth/me').set('Cookie', table.host).expect(200)).body
              .id as string,
            type: 'ROLL_DICE',
            expectedStateVersion: before.state_version,
            mode: 'mutation',
          },
          () => {
            throw new Error('mid-resolution failure');
          },
        ),
      ).rejects.toThrow('mid-resolution failure');

      const after = await service.snapshot(table.sessionId);
      expect(after).toEqual(before);
      expect(await db.select().from(sessionEvents)).toHaveLength(0);
    });

    it('leaves no partial state behind, and the same command_id retries clean', async () => {
      const table = await stage();
      const service = app.get(SessionService);
      const me = (await api().get('/api/auth/me').set('Cookie', table.host).expect(200)).body
        .id as string;

      const input = {
        commandId: 'cmd_retry',
        sessionId: table.sessionId,
        senderId: me,
        type: 'ROLL_DICE',
        expectedStateVersion: 0,
        mode: 'mutation' as const,
      };
      const draft = {
        type: 'ROLL_RESULT',
        payload: { total: 7 },
        actor: { type: 'player' as const, id: me },
        source: { type: 'command' as const, id: input.commandId },
      };

      // Events appended, then a failure after the append — the shape a killed
      // process leaves: work started, nothing committed.
      await expect(
        service.runCommand(
          input,
          () => [draft],
          async () => {
            throw new Error('process died');
          },
        ),
      ).rejects.toThrow('process died');

      // Nothing half-applied, and the idempotency ledger rolled back with it,
      // so the retry is a first attempt rather than a replay of a failure.
      expect(await db.select().from(sessionEvents)).toHaveLength(0);
      const { ack } = await service.runCommand(input, () => [draft]);
      expect(ack).toEqual({ command_id: 'cmd_retry', sequence: 1, state_version: 1 });
      expect(await db.select().from(sessionEvents)).toHaveLength(1);
    });
  });

  describe('pending actions (M5.5, FR-305)', () => {
    it('does not let an unauthorized character close a parked action', async () => {
      const table = await stage();
      const version = await park(table, [table.ariaCharacter]);

      const brannSocket = await connect(table.sessionId, table.brann, table.brannCharacter);
      const ack = (await roll(
        brannSocket,
        table.sessionId,
        table.brannCharacter,
        version,
      )) as CommandAck;

      // Brann's roll is a perfectly good roll. It just resumes nothing.
      expect(ack.sequence).toBeGreaterThan(0);
      const stored = await db.select().from(rolls);
      expect(stored).toHaveLength(1);
      expect(stored[0]!.pendingActionId).toBeNull();

      const [action] = await db.select().from(pendingActions);
      expect(action!.status).toBe('open');

      const events = await db.select().from(sessionEvents);
      expect(events.filter((e) => e.type === 'PENDING_ACTION_COMPLETED')).toHaveLength(0);
      expect(events.filter((e) => e.type === 'DM_TRIGGERED')).toHaveLength(0);
      // Still parked: the session is waiting for the roll it actually asked for.
      expect(await status(table.sessionId)).toBe('WAITING_FOR_ROLL');
    });

    it('fires the pending_action_completed trigger when the right character rolls', async () => {
      const table = await stage();
      const version = await park(table, [table.ariaCharacter]);

      const ariaSocket = await connect(table.sessionId, table.aria, table.ariaCharacter);
      await roll(ariaSocket, table.sessionId, table.ariaCharacter, version);

      const events = await db.select().from(sessionEvents);
      const triggered = events.find((e) => e.type === 'DM_TRIGGERED');
      expect(triggered?.payload).toMatchObject({ definition_id: 'pending_action_completed' });
      expect(await status(table.sessionId)).toBe('WAITING_FOR_PLAYERS');
    });

    it('refuses a roll request from a player, and one naming an outside character', async () => {
      const table = await stage();
      const playerSocket = await connect(table.sessionId, table.aria, table.ariaCharacter);
      const denied = (await requestRoll(
        playerSocket,
        table.sessionId,
        [table.ariaCharacter],
        0,
      )) as ServerError;
      expect(denied.code).toBe('NOT_THE_HOST');

      const hostSocket = await connect(table.sessionId, table.host);
      const unknown = (await requestRoll(
        hostSocket,
        table.sessionId,
        ['11111111-1111-1111-1111-111111111111'],
        0,
      )) as ServerError;
      expect(unknown.code).toBe('CHARACTER_NOT_FOUND');
      expect(await db.select().from(pendingActions)).toHaveLength(0);
      expect(await status(table.sessionId)).toBe('WAITING_FOR_PLAYERS');
    });
  });

  describe('optimistic concurrency (M5.4)', () => {
    it('refuses a stale mutating command and reports the current version', async () => {
      const table = await stage();
      const ariaSocket = await connect(table.sessionId, table.aria, table.ariaCharacter);

      const first = (await roll(ariaSocket, table.sessionId, table.ariaCharacter, 0)) as CommandAck;
      expect(first.state_version).toBe(1);

      const stale = (await roll(
        ariaSocket,
        table.sessionId,
        table.ariaCharacter,
        0,
      )) as ServerError;
      expect(stale.code).toBe('STATE_CONFLICT');
      expect(stale.state_version).toBe(1);
      expect(await db.select().from(rolls)).toHaveLength(1);
    });

    it('never invalidates a version for table chat, however chatty the table', async () => {
      const table = await stage();
      const socket = await connect(table.sessionId, table.aria, table.ariaCharacter);

      for (let i = 0; i < 5; i += 1) await say(socket, table.sessionId, `line ${i}`);

      // Five sequences allocated, zero state changes — so a roll composed
      // before the chatter still quotes a current version.
      const [session] = await db.select().from(sessions).where(eq(sessions.id, table.sessionId));
      expect(session!.stateVersion).toBe(0);
      expect(session!.nextSequence).toBe(6);
      expect(await roll(socket, table.sessionId, table.ariaCharacter, 0)).not.toHaveProperty(
        'code',
      );
    });
  });

  describe('host controls (M5.6, FR-801)', () => {
    it('refuses mutations while paused but leaves chat live', async () => {
      const table = await stage();
      const hostSocket = await connect(table.sessionId, table.host);
      const ariaSocket = await connect(table.sessionId, table.aria, table.ariaCharacter);

      const paused = (await hostControl(hostSocket, table.sessionId, 'PAUSE', 0)) as CommandAck;
      expect(await status(table.sessionId)).toBe('PAUSED');

      const refused = (await roll(
        ariaSocket,
        table.sessionId,
        table.ariaCharacter,
        paused.state_version,
      )) as ServerError;
      expect(refused.code).toBe('SESSION_PAUSED');

      // A trigger is a mutating turn, so it is blocked too — but only the
      // trigger. The same player can still talk to the table.
      const blocked = (await say(
        ariaSocket,
        table.sessionId,
        '@dm I pick the lock',
        paused.state_version,
      )) as ServerError;
      expect(blocked.code).toBe('SESSION_PAUSED');

      expect(await say(ariaSocket, table.sessionId, 'anyone want snacks')).not.toHaveProperty(
        'code',
      );
      const events = await db.select().from(sessionEvents);
      expect(events.filter((e) => e.type === 'DM_TRIGGERED')).toHaveLength(0);
      expect(events.filter((e) => e.type === 'MESSAGE_POSTED')).toHaveLength(1);
      expect(await db.select().from(rolls)).toHaveLength(0);
    });

    it('resumes to the state the pause interrupted, not to a default', async () => {
      const table = await stage();
      const version = await park(table, [table.ariaCharacter]);
      const hostSocket = await connect(table.sessionId, table.host);

      const paused = (await hostControl(
        hostSocket,
        table.sessionId,
        'PAUSE',
        version,
      )) as CommandAck;
      expect(await status(table.sessionId)).toBe('PAUSED');

      await hostControl(hostSocket, table.sessionId, 'RESUME', paused.state_version);
      // The parked roll is still parked, rather than dropped on the floor.
      expect(await status(table.sessionId)).toBe('WAITING_FOR_ROLL');
      const [session] = await db.select().from(sessions).where(eq(sessions.id, table.sessionId));
      expect(session!.pausedFrom).toBeNull();
    });

    it('refuses an illegal transition rather than half-applying it', async () => {
      const table = await stage();
      const hostSocket = await connect(table.sessionId, table.host);

      const paused = (await hostControl(hostSocket, table.sessionId, 'PAUSE', 0)) as CommandAck;
      const twice = (await hostControl(
        hostSocket,
        table.sessionId,
        'PAUSE',
        paused.state_version,
      )) as ServerError;

      expect(twice.code).toBe('ILLEGAL_TRANSITION');
      expect(await status(table.sessionId)).toBe('PAUSED');
      // The refused resolution appended nothing.
      const events = await db.select().from(sessionEvents);
      expect(events.filter((e) => e.type === 'SESSION_STATE_CHANGED')).toHaveLength(1);
    });

    it('ends a session, and nothing mutates after that', async () => {
      const table = await stage();
      const hostSocket = await connect(table.sessionId, table.host);
      const ariaSocket = await connect(table.sessionId, table.aria, table.ariaCharacter);

      const ended = (await hostControl(hostSocket, table.sessionId, 'END', 0)) as CommandAck;
      expect(await status(table.sessionId)).toBe('SESSION_ENDED');

      const refused = (await roll(
        ariaSocket,
        table.sessionId,
        table.ariaCharacter,
        ended.state_version,
      )) as ServerError;
      expect(refused.code).toBe('SESSION_PAUSED');
      expect(await db.select().from(rolls)).toHaveLength(0);
    });

    it('blocks a forced DM turn while paused — a pause blocks all triggers', async () => {
      const table = await stage();
      const hostSocket = await connect(table.sessionId, table.host);

      const paused = (await hostControl(hostSocket, table.sessionId, 'PAUSE', 0)) as CommandAck;
      const forced = (await hostControl(
        hostSocket,
        table.sessionId,
        'FORCE_DM_TURN',
        paused.state_version,
      )) as ServerError;

      expect(forced.code).toBe('SESSION_PAUSED');
      const events = await db.select().from(sessionEvents);
      expect(events.filter((e) => e.type === 'DM_TRIGGERED')).toHaveLength(0);
    });

    it('activates the DM on a forced turn, and only for the host', async () => {
      const table = await stage();
      const hostSocket = await connect(table.sessionId, table.host);
      const ariaSocket = await connect(table.sessionId, table.aria, table.ariaCharacter);

      const denied = (await hostControl(
        ariaSocket,
        table.sessionId,
        'FORCE_DM_TURN',
        0,
      )) as ServerError;
      expect(denied.code).toBe('NOT_THE_HOST');

      const seen: EventEnvelope[] = [];
      ariaSocket.on('event', (event: EventEnvelope) => seen.push(event));
      await hostControl(hostSocket, table.sessionId, 'FORCE_DM_TURN', 0);
      await new Promise((r) => setTimeout(r, 200));

      const triggered = seen.find((e) => e.type === 'DM_TRIGGERED');
      expect(triggered?.payload).toMatchObject({
        definition_id: 'host_turn',
        entry_profile: 'resolve_action',
      });
      // No graph to call yet, so the session stays where the players left it.
      expect(await status(table.sessionId)).toBe('WAITING_FOR_PLAYERS');
    });
  });
});
