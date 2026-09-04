import type { INestApplication } from '@nestjs/common';
import type { EventEnvelope, ResumeResponse, ServerError } from '@dnd-lm/contracts';
import { eq } from 'drizzle-orm';
import { type Socket, io } from 'socket.io-client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.module';
import { messages, sessionEvents } from '../src/db/schema';
import { DATABASE_URL, createTestApp, truncateAll } from './app.harness';

/**
 * M3 acceptance, including the release gate from spec-doc.md §14: a full
 * multi-player conversation with no registered trigger must never activate
 * the DM.
 */
describe.skipIf(!DATABASE_URL)('deterministic routing over the gateway', () => {
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
    ariaId: string;
    brannId: string;
  };

  /** A host and two players in one session — enough for a whisper to have a bystander. */
  async function stage(): Promise<Table> {
    const host = await signUp('ferris@example.com', 'Ferris');
    const campaign = await api()
      .post('/api/campaigns')
      .set('Cookie', host)
      .send({ name: 'Lost Mine' })
      .expect(201);
    const campaignId = campaign.body.id as string;

    const joined: Record<string, string> = {};
    for (const [email, name] of [
      ['aria@example.com', 'Aria'],
      ['brann@example.com', 'Brann'],
    ]) {
      const cookie = await signUp(email!, name!);
      const invite = await api()
        .post(`/api/campaigns/${campaignId}/invites`)
        .set('Cookie', host)
        .send({})
        .expect(201);
      await api()
        .post(`/api/invites/${invite.body.token}/accept`)
        .set('Cookie', cookie)
        .expect(201);
      joined[name!] = cookie;
    }

    const session = await api()
      .post(`/api/campaigns/${campaignId}/sessions`)
      .set('Cookie', host)
      .send({})
      .expect(201);

    const me = async (cookie: string): Promise<string> =>
      (await api().get('/api/auth/me').set('Cookie', cookie).expect(200)).body.id as string;

    return {
      campaignId,
      sessionId: session.body.session_id as string,
      host,
      aria: joined['Aria']!,
      brann: joined['Brann']!,
      ariaId: await me(joined['Aria']!),
      brannId: await me(joined['Brann']!),
    };
  }

  function connect(sessionId: string, cookie: string): Promise<Socket> {
    const socket = io(`http://127.0.0.1:${port}`, {
      path: '/ws',
      transports: ['websocket'],
      extraHeaders: { Cookie: cookie },
      auth: { sessionId },
      reconnection: false,
    });
    open.push(socket);
    return new Promise((resolve, reject) => {
      socket.on('connect', () => resolve(socket));
      socket.on('connect_error', reject);
    });
  }

  let counter = 0;
  const say = (socket: Socket, sessionId: string, content: string): Promise<unknown> =>
    socket.timeout(5000).emitWithAck('command', {
      command_id: `cmd_${(counter += 1)}`,
      type: 'SEND_MESSAGE',
      session_id: sessionId,
      expected_state_version: 0,
      payload: { content, channel: 'in_character' },
    });

  describe('the release gate (spec-doc.md §14)', () => {
    it('never activates the DM across a trigger-free conversation', async () => {
      const table = await stage();
      const socket = await connect(table.sessionId, table.aria);

      const conversation = [
        'We should retreat.',
        '@ferris Do you have the key?',
        '@party We should retreat.',
        '/roll perception',
        '/sheet equip longsword',
        '/ooc back in five',
        '/whisper @brann cover me',
        '@wizard hello?',
        '/dance',
        'I told the @dm about it',
        '`@dm` is the tag',
      ];
      for (const line of conversation) await say(socket, table.sessionId, line);

      const stored = await db
        .select()
        .from(messages)
        .where(eq(messages.sessionId, table.sessionId));
      expect(stored).toHaveLength(conversation.length);
      expect(stored.every((m) => m.triggersDm === false)).toBe(true);
      expect(stored.every((m) => m.triggerDefinitionId === null)).toBe(true);

      // The event log is the gate: no activation event, so nothing downstream
      // could have called a provider (FR-202, FR-206).
      const events = await db
        .select()
        .from(sessionEvents)
        .where(eq(sessionEvents.sessionId, table.sessionId));
      expect(events.filter((e) => e.type === 'DM_TRIGGERED')).toHaveLength(0);
    });

    it('does activate the DM, and records why, when a registered trigger fires', async () => {
      const table = await stage();
      const socket = await connect(table.sessionId, table.aria);
      await say(socket, table.sessionId, '@dm I inspect the altar.');

      const [message] = await db
        .select()
        .from(messages)
        .where(eq(messages.sessionId, table.sessionId));
      expect(message!.triggersDm).toBe(true);
      expect(message!.triggerDefinitionId).toBe('dm_mention');
      expect(message!.recipientType).toBe('dm');

      const events = await db
        .select()
        .from(sessionEvents)
        .where(eq(sessionEvents.sessionId, table.sessionId));
      const triggered = events.find((e) => e.type === 'DM_TRIGGERED');
      expect(triggered?.payload).toMatchObject({
        definition_id: 'dm_mention',
        entry_profile: 'resolve_action',
      });
    });
  });

  describe('visibility-aware fanout (M3.4, FR-207)', () => {
    it('never puts a whisper in a third player’s event stream', async () => {
      const table = await stage();
      const ariaSocket = await connect(table.sessionId, table.aria);
      const brannSocket = await connect(table.sessionId, table.brann);
      const hostSocket = await connect(table.sessionId, table.host);

      const seen: Record<string, EventEnvelope[]> = { brann: [], host: [] };
      brannSocket.on('event', (e: EventEnvelope) => seen.brann!.push(e));
      hostSocket.on('event', (e: EventEnvelope) => seen.host!.push(e));

      await say(ariaSocket, table.sessionId, '/whisper @brann cover me');
      await say(ariaSocket, table.sessionId, 'Everyone ready?');
      await new Promise((r) => setTimeout(r, 250));

      const whisperContent = (events: EventEnvelope[]) =>
        events.filter((e) => (e.payload as { content?: string }).content === 'cover me');

      // Asserted at the socket, not the UI.
      expect(whisperContent(seen.brann!)).toHaveLength(1);
      expect(whisperContent(seen.host!)).toHaveLength(0);
      expect(
        seen.host!.some((e) => (e.payload as { content?: string }).content === 'Everyone ready?'),
      ).toBe(true);
    });

    it('excludes a whisper from a bystander’s replay too', async () => {
      const table = await stage();
      const ariaSocket = await connect(table.sessionId, table.aria);
      await say(ariaSocket, table.sessionId, '/whisper @brann cover me');
      await say(ariaSocket, table.sessionId, 'Everyone ready?');

      const hostSocket = await connect(table.sessionId, table.host);
      const replay = (await hostSocket
        .timeout(5000)
        .emitWithAck('resume', { last_sequence: 0 })) as ResumeResponse;

      const contents = replay.events.map((e) => (e.payload as { content?: string }).content);
      expect(contents).toContain('Everyone ready?');
      expect(contents).not.toContain('cover me');

      const brannSocket = await connect(table.sessionId, table.brann);
      const brannReplay = (await brannSocket
        .timeout(5000)
        .emitWithAck('resume', { last_sequence: 0 })) as ResumeResponse;
      expect(brannReplay.events.map((e) => (e.payload as { content?: string }).content)).toContain(
        'cover me',
      );
    });
  });

  describe('rejections reach the player (rules 4 and 5)', () => {
    it('explains an unknown NPC instead of firing a trigger', async () => {
      const table = await stage();
      const socket = await connect(table.sessionId, table.aria);
      const error = (await say(socket, table.sessionId, '@npc Klarg hello')) as ServerError;

      expect(error.code).toBe('ROUTING_REJECTED');
      expect(error.reason).toBe('UNKNOWN_NPC');

      const stored = await db
        .select()
        .from(messages)
        .where(eq(messages.sessionId, table.sessionId));
      expect(stored).toHaveLength(0);
    });

    it('rejects an unknown whisper target without posting anything', async () => {
      const table = await stage();
      const socket = await connect(table.sessionId, table.aria);
      const error = (await say(socket, table.sessionId, '/whisper @nobody hi')) as ServerError;
      expect(error.reason).toBe('UNKNOWN_PLAYER');
      expect(await db.select().from(messages)).toHaveLength(0);
    });
  });

  describe('per-campaign trigger settings (M3.2, rule 7)', () => {
    it('makes a disabled trigger behave exactly like an unknown tag', async () => {
      const table = await stage();

      await api()
        .patch(`/api/campaigns/${table.campaignId}/triggers`)
        .set('Cookie', table.host)
        .send({ triggers: { dm_mention: false } })
        .expect(200);

      const socket = await connect(table.sessionId, table.aria);
      await say(socket, table.sessionId, '@dm I inspect the altar.');

      const [message] = await db
        .select()
        .from(messages)
        .where(eq(messages.sessionId, table.sessionId));
      expect(message!.triggersDm).toBe(false);
      expect(message!.recipientType).toBe('table');
    });

    it('refuses a player changing them, and an unknown trigger id', async () => {
      const table = await stage();
      await api()
        .patch(`/api/campaigns/${table.campaignId}/triggers`)
        .set('Cookie', table.aria)
        .send({ triggers: { dm_mention: false } })
        .expect(403);
      await api()
        .patch(`/api/campaigns/${table.campaignId}/triggers`)
        .set('Cookie', table.host)
        .send({ triggers: { not_a_trigger: false } })
        .expect(400);
    });
  });

  describe('chat latency (NFR-101)', () => {
    it('delivers non-DM chat with a p95 under 500ms across 6 clients', async () => {
      const table = await stage();
      const cookies = [table.host, table.aria, table.brann];
      const sockets = await Promise.all(
        [...cookies, ...cookies].map((cookie) => connect(table.sessionId, cookie)),
      );

      const samples: number[] = [];
      for (let i = 0; i < 40; i += 1) {
        const sender = sockets[i % sockets.length]!;
        const started = Date.now();
        await say(sender, table.sessionId, `line ${i}`);
        samples.push(Date.now() - started);
      }

      samples.sort((a, b) => a - b);
      const p95 = samples[Math.floor(samples.length * 0.95) - 1]!;
      expect(p95).toBeLessThan(500);
    });
  });
});
