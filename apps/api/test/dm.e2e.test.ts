import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import type { CommandAck, EventEnvelope } from '@dnd-lm/contracts';
import { eq } from 'drizzle-orm';
import { type Socket, io } from 'socket.io-client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import type { Db } from '../src/db/db.module';
import { DB } from '../src/db/db.module';
import { characters, pendingActions, rolls, sessionEvents, sessions } from '../src/db/schema';
import { type DmProvider, type DmProviderConfig, type DmRequest } from '../src/dm/provider';
import { DM_PROVIDER_SOURCE } from '../src/dm/orchestrator';
import { truncateAll, DATABASE_URL } from './app.harness';

const pregen = (file: string): { name: string; sheet: unknown } =>
  JSON.parse(readFileSync(join(process.cwd(), 'fixtures/pregens', file), 'utf8')) as {
    name: string;
    sheet: unknown;
  };

const CONFIG: DmProviderConfig = {
  kind: 'anthropic',
  baseUrl: null,
  apiKey: 'test-key',
  model: 'scripted-dm',
  maxTokens: 1024,
};

/**
 * A provider whose replies the test scripts. One instance with a swappable
 * script: the app (and its checkpointer) is built once, the behavior changes
 * per test, and the restart test rebuilds the app around a fresh provider.
 */
class ScriptedDm implements DmProvider {
  kind = 'scripted';
  model = 'scripted-dm';
  calls: DmRequest[] = [];
  script: (index: number, req: DmRequest) => string | { error: string };

  constructor(script: ScriptedDm['script']) {
    this.script = script;
  }

  async generate(
    req: DmRequest,
    onDelta?: (chunk: string) => void,
  ): Promise<
    | {
        kind: 'ok';
        raw: string;
        usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
      }
    | { kind: 'error'; message: string }
  > {
    const index = this.calls.length;
    this.calls.push(req);
    const out = this.script(index, req);
    if (typeof out === 'string') {
      onDelta?.(out);
      return {
        kind: 'ok',
        raw: out,
        usage: { inputTokens: 11, outputTokens: 7, cacheReadTokens: 0 },
      };
    }
    return { kind: 'error', message: out.error };
  }
}

const block = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    narration: 'The gate grinds open.',
    addressed_to: ['party'],
    tool_requests: [],
    proposed_state_changes: [],
    memory_candidates: [],
    next_state: 'WAITING_FOR_PLAYERS',
    ...over,
  });

// The contract says the block's narration repeats the prose exactly, so the
// helper derives the prose from it — a reply where the two disagree is the
// malformation the retry path exists for, not a test fixture.
const answer = (over: Record<string, unknown> = {}) =>
  `${(over.narration as string) ?? 'The gate grinds open.'}\n\`\`\`dm-json\n${block(over)}\n\`\`\``;

type TestApp = { app: INestApplication; db: Db; port: number };

type ProviderSource = { get: () => { provider: DmProvider; config: DmProviderConfig } | null };

async function createDmApp(source: ProviderSource): Promise<TestApp> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DM_PROVIDER_SOURCE)
    .useValue(source)
    .compile();
  const app = moduleRef.createNestApplication();
  app.use(cookieParser());
  app.setGlobalPrefix('api', { exclude: ['healthz'] });
  await app.listen(0);
  const address = app.getHttpServer().address();
  if (typeof address !== 'object' || address === null) throw new Error('no ephemeral port');
  return { app, db: app.get<Db>(DB), port: address.port };
}

/**
 * M6 acceptance (M6.6–M6.8, FR-504, FR-505): the DM turn commits narration
 * and proposals as one resolution, parks on a roll and resumes from the
 * checkpoint across a process restart, and a failed turn fails typed without
 * ever publishing narration.
 */
describe.skipIf(!DATABASE_URL)('the langgraph DM', () => {
  let main: TestApp;
  const dm = new ScriptedDm(() => answer());
  const open: Socket[] = [];
  let counter = 0;

  beforeAll(async () => {
    main = await createDmApp({ get: () => ({ provider: dm, config: CONFIG }) });
  });
  afterAll(async () => {
    await main?.app.close();
  });
  beforeEach(async () => {
    dm.calls = [];
    await truncateAll(main.db);
  });
  afterEach(() => {
    for (const socket of open.splice(0)) socket.disconnect();
  });

  function api(target: TestApp) {
    return request(target.app.getHttpServer());
  }

  async function signUp(target: TestApp, email: string, displayName: string): Promise<string> {
    const res = await api(target)
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
    ariaCharacter: string;
  };

  async function stage(target: TestApp): Promise<Table> {
    const host = await signUp(target, 'host@example.com', 'Host');
    const campaign = await api(target)
      .post('/api/campaigns')
      .set('Cookie', host)
      .send({ name: 'Lost Mine' })
      .expect(201);
    const campaignId = campaign.body.id as string;

    const invite = async (cookie: string): Promise<void> => {
      const created = await api(target)
        .post(`/api/campaigns/${campaignId}/invites`)
        .set('Cookie', host)
        .send({})
        .expect(201);
      await api(target)
        .post(`/api/invites/${created.body.token}/accept`)
        .set('Cookie', cookie)
        .expect(201);
    };

    const aria = await signUp(target, 'aria@example.com', 'Aria');
    await invite(aria);
    const imported = await api(target)
      .post(`/api/campaigns/${campaignId}/characters/import`)
      .set('Cookie', aria)
      .send(pregen('aria-sunhollow.json'))
      .expect(201);

    const session = await api(target)
      .post(`/api/campaigns/${campaignId}/sessions`)
      .set('Cookie', host)
      .send({})
      .expect(201);

    return {
      campaignId,
      sessionId: session.body.session_id as string,
      host,
      aria,
      ariaCharacter: imported.body.id as string,
    };
  }

  function connect(
    target: TestApp,
    sessionId: string,
    cookie: string,
    characterId?: string,
  ): Promise<Socket> {
    const socket = io(`http://127.0.0.1:${target.port}`, {
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

  function command(socket: Socket, body: Record<string, unknown>): Promise<unknown> {
    return socket
      .timeout(5000)
      .emitWithAck('command', { command_id: `cmd_${(counter += 1)}`, ...body });
  }

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

  const waitFor = (socket: Socket, type: string, ms = 15000): Promise<EventEnvelope> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.off('event', onEvent);
        reject(new Error(`timed out waiting for ${type}`));
      }, ms);
      const onEvent = (event: EventEnvelope) => {
        if (event.type === type) {
          clearTimeout(timer);
          socket.off('event', onEvent);
          resolve(event);
        }
      };
      socket.on('event', onEvent);
    });

  const status = async (target: TestApp, sessionId: string): Promise<string> => {
    const [row] = await target.db.select().from(sessions).where(eq(sessions.id, sessionId));
    return row!.status;
  };

  const sheetOf = async (target: TestApp, characterId: string) => {
    const [row] = await target.db.select().from(characters).where(eq(characters.id, characterId));
    return row!.sheet as { currentHp?: number; maxHp: number };
  };

  it('commits the narration and its proposals as one resolution (M6.6)', async () => {
    const table = await stage(main);
    dm.script = () =>
      answer({
        proposed_state_changes: [
          {
            operation: 'adjust_hp',
            target_id: table.ariaCharacter,
            payload: { delta: -4 },
            actor: { type: 'dm', id: table.campaignId },
            scope: 'host',
            expected_state_version: 1,
          },
        ],
      });

    const before = (await sheetOf(main, table.ariaCharacter)).currentHp;
    const host = await connect(main, table.sessionId, table.host);
    const narration = waitFor(host, 'DM_NARRATION');
    const ack = (await say(host, table.sessionId, '@dm Aria picks the lock')) as CommandAck;
    const event = await narration;

    expect(ack.state_version).toBe(1);
    expect(event.payload).toMatchObject({
      entry_profile: 'resolve_action',
      definition_id: 'dm_mention',
    });
    expect((event.payload as { narration: string }).narration).toBe('The gate grinds open.');

    const after = await sheetOf(main, table.ariaCharacter);
    expect(after.currentHp).toBe((before ?? after.maxHp) - 4);

    expect(await status(main, table.sessionId)).toBe('WAITING_FOR_PLAYERS');
    const events = await main.db.select().from(sessionEvents);
    expect(events.filter((e) => e.type === 'DM_NARRATION')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'DM_RESOLUTION_FAILED')).toHaveLength(0);
  });

  it('parks on a requested roll, and resumes from the checkpoint after a restart (M6.8)', async () => {
    const table = await stage(main);
    dm.script = (index) =>
      index === 0
        ? answer({
            tool_requests: [
              {
                name: 'request_roll',
                arguments: {
                  prompt: 'Coin flip',
                  expression: '1d20',
                  character_ids: [table.ariaCharacter],
                },
              },
            ],
          })
        : answer({ narration: 'The tails of the coin.' });

    const host = await connect(main, table.sessionId, table.host);
    const requested = waitFor(host, 'ROLL_REQUESTED');
    await say(host, table.sessionId, '@dm Aria flips a silver coin');
    const rolled = await requested;
    expect(rolled.payload).toMatchObject({ prompt: 'Coin flip', expression: '1d20' });
    expect(await status(main, table.sessionId)).toBe('WAITING_FOR_ROLL');

    const [action] = await main.db.select().from(pendingActions);
    expect(action!.graphThreadId).toBeTruthy();
    const [session] = await main.db.select().from(sessions).where(eq(sessions.id, table.sessionId));
    const parkedVersion = session!.stateVersion;

    // The process dies between the ask and the roll. The checkpoint is in
    // Postgres; a fresh process with a fresh provider resumes it.
    await main.app.close();
    const resumption = new ScriptedDm(() => answer({ narration: 'The tails of the coin.' }));
    main = await createDmApp({ get: () => ({ provider: resumption, config: CONFIG }) });
    try {
      const host2 = await connect(main, table.sessionId, table.host);
      const narration = waitFor(host2, 'DM_NARRATION');
      const aria2 = await connect(main, table.sessionId, table.aria, table.ariaCharacter);
      await roll(aria2, table.sessionId, table.ariaCharacter, parkedVersion);
      const event = await narration;

      expect((event.payload as { narration: string }).narration).toBe('The tails of the coin.');
      // The resumed turn began from the checkpoint: its first prompt carries
      // the roll result, not the original trigger as a fresh start.
      expect(resumption.calls).toHaveLength(1);
      expect(resumption.calls[0]!.prompt).toContain('## The roll came back');

      expect(await status(main, table.sessionId)).toBe('WAITING_FOR_PLAYERS');
      const closed = await main.db.select().from(pendingActions);
      expect(closed[0]!.status).toBe('completed');
      const stored = await main.db.select().from(rolls);
      expect(stored).toHaveLength(1);
      expect(stored[0]!.pendingActionId).toBe(action!.id);
    } finally {
      await main.app.close();
      // afterAll closes it again; close is idempotent enough, but leave a live
      // app so the next beforeEach does not hit a dead port.
      main = await createDmApp({ get: () => ({ provider: dm, config: CONFIG }) });
    }
  });

  it('fails NO_PROVIDER with no graph and a table-safe message (M6.7)', async () => {
    const bare = await createDmApp({ get: () => null });
    try {
      const table = await stage(bare);
      const host = await connect(bare, table.sessionId, table.host);
      const failed = waitFor(host, 'DM_RESOLUTION_FAILED');
      await say(host, table.sessionId, '@dm Aria opens the door');
      const event = await failed;

      expect(event.payload).toMatchObject({ reason: 'NO_PROVIDER' });
      expect(await status(bare, table.sessionId)).toBe('WAITING_FOR_PLAYERS');
      const events = await bare.db.select().from(sessionEvents);
      expect(events.filter((e) => e.type === 'DM_NARRATION')).toHaveLength(0);
    } finally {
      await bare.app.close();
    }
  });

  it('retracts a turn whose proposals the table does not allow (M6.6, invariant 4)', async () => {
    const table = await stage(main);
    dm.script = () =>
      answer({
        proposed_state_changes: [
          {
            operation: 'adjust_hp',
            target_id: table.ariaCharacter,
            payload: { delta: -999 },
            actor: { type: 'dm', id: table.campaignId },
            scope: 'host',
            expected_state_version: 1,
          },
        ],
      });

    const before = (await sheetOf(main, table.ariaCharacter)).currentHp;
    const host = await connect(main, table.sessionId, table.host);
    const failed = waitFor(host, 'DM_RESOLUTION_FAILED');
    await say(host, table.sessionId, '@dm Aria is hit by the trap');
    const event = await failed;

    expect(event.payload).toMatchObject({ reason: 'MUTATION_REJECTED' });
    expect((await sheetOf(main, table.ariaCharacter)).currentHp).toBe(before);
    expect(await status(main, table.sessionId)).toBe('WAITING_FOR_PLAYERS');
    const events = await main.db.select().from(sessionEvents);
    expect(events.filter((e) => e.type === 'DM_NARRATION')).toHaveLength(0);
  });

  it('caps a turn that never stops calling tools (M6.2)', async () => {
    const table = await stage(main);
    dm.script = () =>
      answer({
        tool_requests: [{ name: 'search_campaign_notes', arguments: { query: 'anything' } }],
      });

    const host = await connect(main, table.sessionId, table.host);
    const failed = waitFor(host, 'DM_RESOLUTION_FAILED');
    await say(host, table.sessionId, '@dm find out something');
    const event = await failed;

    expect(event.payload).toMatchObject({ reason: 'RECURSION_LIMIT' });
    expect(await status(main, table.sessionId)).toBe('WAITING_FOR_PLAYERS');
    const events = await main.db.select().from(sessionEvents);
    expect(events.filter((e) => e.type === 'DM_NARRATION')).toHaveLength(0);
  });
});
