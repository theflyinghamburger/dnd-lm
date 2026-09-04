import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import type { CommandAck, EventEnvelope, RollModifier, ServerError } from '@dnd-lm/contracts';
import { eq } from 'drizzle-orm';
import { type Socket, io } from 'socket.io-client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.module';
import { messages, rolls } from '../src/db/schema';
import { DATABASE_URL, createTestApp, truncateAll } from './app.harness';

// vitest runs from the workspace root, so the fixtures resolve from cwd.
const pregen = (file: string): { name: string; sheet: unknown } =>
  JSON.parse(readFileSync(join(process.cwd(), 'fixtures/pregens', file), 'utf8')) as {
    name: string;
    sheet: unknown;
  };

/** M4 acceptance: server-authoritative dice, ownership, and reconstructible rolls. */
describe.skipIf(!DATABASE_URL)('characters and dice', () => {
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
    player: string;
  };

  async function stage(): Promise<Table> {
    const host = await signUp('ferris@example.com', 'Ferris');
    const campaign = await api()
      .post('/api/campaigns')
      .set('Cookie', host)
      .send({ name: 'Lost Mine' })
      .expect(201);
    const campaignId = campaign.body.id as string;

    const player = await signUp('aria@example.com', 'Aria');
    const invite = await api()
      .post(`/api/campaigns/${campaignId}/invites`)
      .set('Cookie', host)
      .send({})
      .expect(201);
    await api().post(`/api/invites/${invite.body.token}/accept`).set('Cookie', player).expect(201);

    const session = await api()
      .post(`/api/campaigns/${campaignId}/sessions`)
      .set('Cookie', host)
      .send({})
      .expect(201);

    return { campaignId, sessionId: session.body.session_id as string, host, player };
  }

  const importPregen = (table: Table, cookie: string, file: string) =>
    api()
      .post(`/api/campaigns/${table.campaignId}/characters/import`)
      .set('Cookie', cookie)
      .send(pregen(file));

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

  let counter = 0;
  const say = (socket: Socket, sessionId: string, content: string) =>
    socket.timeout(5000).emitWithAck('command', {
      command_id: `cmd_${(counter += 1)}`,
      type: 'SEND_MESSAGE',
      session_id: sessionId,
      expected_state_version: 0,
      payload: { content, channel: 'in_character' },
    });

  const rollCommand = (
    socket: Socket,
    sessionId: string,
    expression: string,
    characterId?: string,
  ) =>
    socket.timeout(5000).emitWithAck('command', {
      command_id: `cmd_${(counter += 1)}`,
      type: 'ROLL_DICE',
      session_id: sessionId,
      expected_state_version: 0,
      payload: { expression, ...(characterId ? { character_id: characterId } : {}) },
    });

  describe('import (M4.2, D-3)', () => {
    it('imports a pregen and computes every derived value on read', async () => {
      const table = await stage();
      const res = await importPregen(table, table.player, 'aria-sunhollow.json').expect(201);

      expect(res.body.name).toBe('Aria Sunhollow');
      expect(res.body.derived.proficiencyBonus).toBe(2);
      // WIS 16 (+3) and proficient in Perception (+2).
      expect(res.body.derived.skillModifiers.perception).toBe(5);
      expect(res.body.derived.passivePerception).toBe(15);
      // The stored sheet keeps inputs only.
      expect(res.body.sheet).not.toHaveProperty('passivePerception');
      expect(res.body.sheet).not.toHaveProperty('skillModifiers');
    });

    it('rejects a sheet that supplies a derived value', async () => {
      const table = await stage();
      const body = pregen('aria-sunhollow.json');
      await api()
        .post(`/api/campaigns/${table.campaignId}/characters/import`)
        .set('Cookie', table.player)
        .send({ ...body, sheet: { ...(body.sheet as object), passivePerception: 99 } })
        .expect(400);
    });

    it('refuses a non-member', async () => {
      const table = await stage();
      const stranger = await signUp('stranger@example.com', 'Stranger');
      await importPregen(table, stranger, 'brann-ironfell.json').expect(403);
    });
  });

  describe('rolling (M4.4, M4.5, FR-301, FR-302)', () => {
    it('reconstructs every roll total from its stored dice and modifiers', async () => {
      const table = await stage();
      const character = await importPregen(table, table.player, 'aria-sunhollow.json').expect(201);
      const socket = await connect(table.sessionId, table.player, character.body.id);

      for (const expression of ['1d20', '2d6+3', '3d8-2', '1d20+5 adv', 'perception', 'wis save']) {
        await rollCommand(socket, table.sessionId, expression, character.body.id);
      }

      const stored = await db.select().from(rolls).where(eq(rolls.sessionId, table.sessionId));
      expect(stored).toHaveLength(6);

      for (const row of stored) {
        const modifiers = row.modifiers as RollModifier[];
        const bonus = modifiers.reduce((sum, m) => sum + m.value, 0);
        const advantage = / (adv|dis)$/.exec(row.expression)?.[1];
        const kept =
          advantage === 'adv'
            ? Math.max(...row.dice)
            : advantage === 'dis'
              ? Math.min(...row.dice)
              : row.dice.reduce((a, b) => a + b, 0);

        expect(row.total).toBe(kept + bonus);
        expect(modifiers.every((m) => m.source.length > 0)).toBe(true);
      }
    });

    it('resolves a named roll from the character’s current sheet (FR-303)', async () => {
      const table = await stage();
      const character = await importPregen(table, table.player, 'aria-sunhollow.json').expect(201);
      const socket = await connect(table.sessionId, table.player, character.body.id);

      await rollCommand(socket, table.sessionId, 'perception', character.body.id);

      const [row] = await db.select().from(rolls).where(eq(rolls.sessionId, table.sessionId));
      expect(row!.modifiers).toEqual([
        { source: 'Wisdom', value: 3 },
        { source: 'Proficiency', value: 2 },
      ]);
      expect(row!.expression).toBe('1d20');
    });

    it('rolls from chat without ever waking the DM (FR-304)', async () => {
      const table = await stage();
      const character = await importPregen(table, table.player, 'aria-sunhollow.json').expect(201);
      const socket = await connect(table.sessionId, table.player, character.body.id);

      const received: EventEnvelope[] = [];
      socket.on('event', (event: EventEnvelope) => received.push(event));

      await say(socket, table.sessionId, '/roll perception');
      await new Promise((r) => setTimeout(r, 200));

      expect(received.some((e) => e.type === 'ROLL_RESULT')).toBe(true);
      expect(received.some((e) => e.type === 'DM_TRIGGERED')).toBe(false);
      expect(await db.select().from(rolls)).toHaveLength(1);

      // The typed line is a chat message too, and M3.3 says it gets its row in
      // the same transaction. It did not, until CI caught the missing insert.
      const posted = await db.select().from(messages);
      expect(posted).toHaveLength(1);
      expect(posted[0]!.recipientType).toBe('dice');
      expect(posted[0]!.content).toBe('/roll perception');
      expect(posted[0]!.triggersDm).toBe(false);
    });

    it('refuses a roll as another player’s character', async () => {
      const table = await stage();
      const mine = await importPregen(table, table.player, 'aria-sunhollow.json').expect(201);
      const theirs = await importPregen(table, table.host, 'brann-ironfell.json').expect(201);

      const socket = await connect(table.sessionId, table.player, mine.body.id);
      const error = (await rollCommand(
        socket,
        table.sessionId,
        'perception',
        theirs.body.id,
      )) as ServerError;

      expect(error.code).toBe('NOT_YOUR_CHARACTER');
      expect(await db.select().from(rolls)).toHaveLength(0);
    });

    it('refuses a handshake that claims another player’s character', async () => {
      const table = await stage();
      const theirs = await importPregen(table, table.host, 'brann-ironfell.json').expect(201);
      await expect(connect(table.sessionId, table.player, theirs.body.id)).rejects.toThrow(
        'NOT_YOUR_CHARACTER',
      );
    });

    it('explains a malformed expression instead of inventing dice', async () => {
      const table = await stage();
      const socket = await connect(table.sessionId, table.player);
      const error = (await rollCommand(socket, table.sessionId, '4d6kh3')) as ServerError;
      expect(error.code).toBe('ROUTING_REJECTED');
      expect(await db.select().from(rolls)).toHaveLength(0);
    });

    it('meets the p95 roll round-trip budget (NFR-102)', async () => {
      const table = await stage();
      const character = await importPregen(table, table.player, 'aria-sunhollow.json').expect(201);
      const socket = await connect(table.sessionId, table.player, character.body.id);

      const samples: number[] = [];
      for (let i = 0; i < 20; i += 1) {
        const started = Date.now();
        const ack = (await rollCommand(
          socket,
          table.sessionId,
          'perception',
          character.body.id,
        )) as CommandAck;
        expect(ack.sequence).toBeGreaterThan(0);
        samples.push(Date.now() - started);
      }

      samples.sort((a, b) => a - b);
      expect(samples[Math.floor(samples.length * 0.95) - 1]!).toBeLessThan(750);
    });
  });
});
