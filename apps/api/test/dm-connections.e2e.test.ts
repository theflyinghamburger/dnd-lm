import { eq, sql } from 'drizzle-orm';
import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type EventEnvelope } from '@dnd-lm/contracts';
import { campaigns, memberships, sessions, sessionEvents, users } from '../src/db/schema';
import { AnthropicProvider } from '../src/dm/anthropic.adapter';
import { DM_PROVIDER_SOURCE, type DmProviderSource } from '../src/dm/orchestrator';
import { DATABASE_URL, createTestApp, truncateAll, type TestApp } from './app.harness';

/**
 * M7.7 — the DM runs on the campaign's selected connection. Endpoint, key,
 * and model come from the row (no env), the provider is rebuilt per turn so
 * a rekey takes effect on the next turn without a restart, and two campaigns
 * on two connections never cross. The endpoint is a local mock
 * OpenAI-compatible SSE server behind the M7.3 wall (`ALLOW_LOCAL_PROVIDERS`).
 */
describe.skipIf(!DATABASE_URL)('DM adapter wiring from connections (M7.7)', () => {
  type Rec = { auth: string | undefined; model: string | undefined; path: string };
  type Mock = { port: number; recs: Rec[]; close: () => Promise<void> };

  // One dm-json reply, streamed as SSE. Split per source line so every `data:`
  // field is a single line (JSON escapes the newlines inside it).
  const DM_TEXT =
    'The gate grinds open.\n```dm-json\n' +
    JSON.stringify({
      narration: 'The gate grinds open.',
      addressed_to: ['party'],
      tool_requests: [],
      proposed_state_changes: [],
      memory_candidates: [],
      next_state: 'WAITING_FOR_PLAYERS',
    }) +
    '\n```';

  function mockOpenAI(): Promise<Mock> {
    const recs: Rec[] = [];
    const server: Server = createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        const body = JSON.parse(data || '{}') as { model?: string };
        recs.push({ auth: req.headers.authorization, model: body.model, path: req.url ?? '' });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const chunk = (content?: string, usage?: unknown) =>
          JSON.stringify({
            id: 'cmpl-1',
            object: 'chat.completion.chunk',
            choices:
              content !== undefined ? [{ index: 0, delta: { content }, finish_reason: null }] : [],
            ...(usage ? { usage } : {}),
          });
        for (const line of DM_TEXT.split('\n')) res.write(`data: ${chunk(line)}\n\n`);
        res.write(`data: ${chunk(undefined, { prompt_tokens: 9, completion_tokens: 4 })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    return new Promise((resolve) =>
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo;
        resolve({
          port,
          recs,
          close: () =>
            new Promise<void>((r) => {
              server.closeAllConnections();
              server.close(() => r());
            }),
        });
      }),
    );
  }

  let app: TestApp;
  let mock: Mock;
  let admin: string;
  const open: Socket[] = [];

  beforeAll(async () => {
    vi.stubEnv('ALLOW_LOCAL_PROVIDERS', 'true');
    app = await createTestApp();
    mock = await mockOpenAI();
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await mock?.close();
    await app?.app.close();
  });
  beforeEach(async () => {
    await truncateAll(app.db);
    admin = await makeAdmin(app);
    mock.recs.length = 0;
  });
  afterEach(() => {
    for (const socket of open.splice(0)) socket.disconnect();
  });

  function api(target: TestApp) {
    return request(target.app.getHttpServer());
  }

  async function signUp(target: TestApp, email: string): Promise<string> {
    const res = await api(target)
      .post('/api/auth/register')
      .send({ email, displayName: email.split('@')[0], password: 'a-long-enough-password' })
      .expect(201);
    const cookie = res.headers['set-cookie']!;
    return Array.isArray(cookie) ? cookie[0]! : cookie;
  }

  /** Option (a) admin: an `admin` membership in any campaign (M7.4). */
  async function makeAdmin(target: TestApp): Promise<string> {
    const cookie = await signUp(target, 'admin@example.com');
    const [u] = await target.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, 'admin@example.com'))
      .limit(1);
    const [c] = await target.db
      .insert(campaigns)
      .values({ ownerUserId: u!.id, name: 'Admin Home' })
      .returning({ id: campaigns.id });
    await target.db.insert(memberships).values({ campaignId: c!.id, userId: u!.id, role: 'admin' });
    return cookie;
  }

  type Table = { campaignId: string; sessionId: string; host: string };

  async function stage(target: TestApp, hostEmail: string): Promise<Table> {
    const host = await signUp(target, hostEmail);
    const campaign = await api(target)
      .post('/api/campaigns')
      .set('Cookie', host)
      .send({ name: 'Lost Mine' })
      .expect(201);
    const session = await api(target)
      .post(`/api/campaigns/${campaign.body.id}/sessions`)
      .set('Cookie', host)
      .send({})
      .expect(201);
    return {
      campaignId: campaign.body.id as string,
      sessionId: session.body.session_id as string,
      host,
    };
  }

  async function createConnection(
    target: TestApp,
    cookie: string,
    body: Record<string, unknown>,
  ): Promise<string> {
    const res = await api(target)
      .post('/api/admin/providers')
      .set('Cookie', cookie)
      .send(body)
      .expect(201);
    return res.body.id as string;
  }

  const pick = (target: TestApp, cookie: string, campaignId: string, connectionId: string | null) =>
    api(target)
      .patch(`/api/campaigns/${campaignId}/provider`)
      .set('Cookie', cookie)
      .send({ providerConnectionId: connectionId })
      .expect(200);

  const localBase = (port: number) => `http://127.0.0.1:${port}/v1`;

  async function connect(target: TestApp, sessionId: string, cookie: string): Promise<Socket> {
    const socket = io(`http://127.0.0.1:${target.port}`, {
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
  const say = (socket: Socket, sessionId: string, content: string, version: number) =>
    socket.timeout(5000).emitWithAck('command', {
      command_id: `cmd_${(counter += 1)}`,
      type: 'SEND_MESSAGE',
      session_id: sessionId,
      expected_state_version: version,
      payload: { content, channel: 'in_character' },
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

  it("runs the DM on the campaign's selected connection — endpoint, key, and model from the row", async () => {
    const table = await stage(app, 'host@example.com');
    const connId = await createConnection(app, admin, {
      label: 'Local Box',
      kind: 'openai_compatible',
      baseUrl: localBase(mock.port),
      apiKey: 'sk-key-a',
      modelId: 'local-llama',
    });
    await pick(app, table.host, table.campaignId, connId);

    const host = await connect(app, table.sessionId, table.host);
    const narration = waitFor(host, 'DM_NARRATION');
    await say(host, table.sessionId, '@dm Aria picks the lock', 0);
    const event = await narration;

    expect((event.payload as { narration: string }).narration).toBe('The gate grinds open.');
    // M7.8: the committed narration names the connection and model that made it.
    expect(event.payload).toMatchObject({
      provider_connection_id: connId,
      model_id: 'local-llama',
    });
    expect(mock.recs).toHaveLength(1);
    expect(mock.recs[0]).toMatchObject({
      auth: 'Bearer sk-key-a',
      model: 'local-llama',
      path: '/v1/chat/completions',
    });
  });

  it('picks up a rekeyed connection on the next turn, no restart', async () => {
    const table = await stage(app, 'host@example.com');
    const connId = await createConnection(app, admin, {
      label: 'Local Box',
      kind: 'openai_compatible',
      baseUrl: localBase(mock.port),
      apiKey: 'sk-key-a',
      modelId: 'local-llama',
    });
    await pick(app, table.host, table.campaignId, connId);

    const host = await connect(app, table.sessionId, table.host);
    const first = waitFor(host, 'DM_NARRATION');
    await say(host, table.sessionId, '@dm Aria picks the lock', 0);
    await first;

    await api(app)
      .post(`/api/admin/providers/${connId}/key`)
      .set('Cookie', admin)
      .send({ apiKey: 'sk-key-b' })
      .expect(200);

    const second = waitFor(host, 'DM_NARRATION');
    const [s] = await app.db.select().from(sessions).where(eq(sessions.id, table.sessionId));
    await say(host, table.sessionId, '@dm and again', s!.stateVersion);
    await second;

    expect(mock.recs.map((r) => r.auth)).toEqual(['Bearer sk-key-a', 'Bearer sk-key-b']);
  });

  it('a keyless connection still talks across — the SDK placeholder is not a secret', async () => {
    const table = await stage(app, 'host@example.com');
    const connId = await createConnection(app, admin, {
      label: 'Local Box',
      kind: 'openai_compatible',
      baseUrl: localBase(mock.port),
      modelId: 'local-llama',
    });
    await pick(app, table.host, table.campaignId, connId);

    const host = await connect(app, table.sessionId, table.host);
    const narration = waitFor(host, 'DM_NARRATION');
    await say(host, table.sessionId, '@dm Aria picks the lock', 0);
    await narration;

    expect(mock.recs).toHaveLength(1);
    expect(mock.recs[0]!.auth).toBe('Bearer keyless-local');
  });

  it('two campaigns on two connections never cross wires', async () => {
    const other = await mockOpenAI();
    try {
      const a = await stage(app, 'alice@example.com');
      const b = await stage(app, 'bob@example.com');
      const connA = await createConnection(app, admin, {
        label: 'A',
        kind: 'openai_compatible',
        baseUrl: localBase(mock.port),
        apiKey: 'sk-key-a',
        modelId: 'model-a',
      });
      const connB = await createConnection(app, admin, {
        label: 'B',
        kind: 'openai_compatible',
        baseUrl: localBase(other.port),
        apiKey: 'sk-key-b',
        modelId: 'model-b',
      });
      await pick(app, a.host, a.campaignId, connA);
      await pick(app, b.host, b.campaignId, connB);

      const hostA = await connect(app, a.sessionId, a.host);
      const narrationA = waitFor(hostA, 'DM_NARRATION');
      await say(hostA, a.sessionId, '@dm hello from A', 0);
      const eventA = await narrationA;

      const hostB = await connect(app, b.sessionId, b.host);
      const narrationB = waitFor(hostB, 'DM_NARRATION');
      await say(hostB, b.sessionId, '@dm hello from B', 0);
      const eventB = await narrationB;

      // M7.8: each turn is attributed to its own connection, so a
      // per-connection cost or failure rate is computable from the log.
      expect(eventA.payload).toMatchObject({
        provider_connection_id: connA,
        model_id: 'model-a',
      });
      expect(eventB.payload).toMatchObject({
        provider_connection_id: connB,
        model_id: 'model-b',
      });

      // M7.8 AC-10: the per-connection roll-up the attribution exists for.
      // Failure rate and token spend, keyed on the connection, from the event
      // log alone — no join to a table the resolution did not write.
      const rollup = await app.db.execute(sql`
        SELECT payload->>'provider_connection_id' AS connection_id,
               payload->>'model_id'               AS model_id,
               count(*) FILTER (WHERE type = 'DM_RESOLUTION_FAILED') AS failures,
               count(*) FILTER (WHERE type = 'DM_NARRATION')         AS resolutions,
               COALESCE(SUM((payload->'usage'->>'input_tokens')::bigint), 0)  AS input_tokens,
               COALESCE(SUM((payload->'usage'->>'output_tokens')::bigint), 0) AS output_tokens
          FROM session_events
         WHERE type IN ('DM_NARRATION', 'DM_RESOLUTION_FAILED')
         GROUP BY 1, 2
         ORDER BY connection_id
      `);
      expect(
        [...rollup].map((r) => ({
          connection_id: r.connection_id,
          model_id: r.model_id,
          resolutions: Number(r.resolutions),
          failures: Number(r.failures),
          input_tokens: Number(r.input_tokens),
          output_tokens: Number(r.output_tokens),
        })),
      ).toEqual(
        [
          {
            connection_id: connA,
            model_id: 'model-a',
            resolutions: 1,
            failures: 0,
            input_tokens: 9,
            output_tokens: 4,
          },
          {
            connection_id: connB,
            model_id: 'model-b',
            resolutions: 1,
            failures: 0,
            input_tokens: 9,
            output_tokens: 4,
          },
        ].sort((x, y) => x.connection_id.localeCompare(y.connection_id)),
      );
      // The failure half of the query is exercised where failures happen:
      // `dm-failures.e2e.test.ts` attributes each failed turn to its own
      // connection, which is the same payload field this groups on.

      expect(mock.recs).toEqual([
        { auth: 'Bearer sk-key-a', model: 'model-a', path: '/v1/chat/completions' },
      ]);
      expect(other.recs).toEqual([
        { auth: 'Bearer sk-key-b', model: 'model-b', path: '/v1/chat/completions' },
      ]);
    } finally {
      await other.close();
    }
  });

  it('a campaign with no selected connection fails NO_PROVIDER, typed, and the state does not move', async () => {
    const table = await stage(app, 'host@example.com');
    await createConnection(app, admin, {
      label: 'Never Picked',
      kind: 'openai_compatible',
      baseUrl: localBase(mock.port),
      apiKey: 'sk-key-a',
      modelId: 'local-llama',
    });

    const host = await connect(app, table.sessionId, table.host);
    const failed = waitFor(host, 'DM_RESOLUTION_FAILED');
    await say(host, table.sessionId, '@dm Aria picks the lock', 0);
    const event = await failed;

    // M7.8: a failure with no connection resolved reports null rather than
    // guessing — that is what NO_PROVIDER means.
    expect(event.payload).toMatchObject({
      reason: 'NO_PROVIDER',
      provider_connection_id: null,
      model_id: null,
    });
    expect(await status(app, table.sessionId)).toBe('WAITING_FOR_PLAYERS');
    const narrations = await app.db
      .select({ eventId: sessionEvents.eventId })
      .from(sessionEvents)
      .where(eq(sessionEvents.type, 'DM_NARRATION'));
    expect(narrations).toHaveLength(0);
    expect(mock.recs).toHaveLength(0);
  });

  it('disabling a selected connection also reads as NO_PROVIDER', async () => {
    const table = await stage(app, 'host@example.com');
    const connId = await createConnection(app, admin, {
      label: 'Disabled Soon',
      kind: 'openai_compatible',
      baseUrl: localBase(mock.port),
      apiKey: 'sk-key-a',
      modelId: 'local-llama',
    });
    await pick(app, table.host, table.campaignId, connId);
    await api(app)
      .patch(`/api/admin/providers/${connId}`)
      .set('Cookie', admin)
      .send({ enabled: false })
      .expect(200);

    const host = await connect(app, table.sessionId, table.host);
    const failed = waitFor(host, 'DM_RESOLUTION_FAILED');
    await say(host, table.sessionId, '@dm Aria picks the lock', 0);
    const event = await failed;

    expect(event.payload).toMatchObject({ reason: 'NO_PROVIDER' });
    expect(await status(app, table.sessionId)).toBe('WAITING_FOR_PLAYERS');
    expect(mock.recs).toHaveLength(0);
  });

  it('an anthropic-kind connection builds the Anthropic adapter', async () => {
    const table = await stage(app, 'host@example.com');
    const connId = await createConnection(app, admin, {
      label: 'Anthropic',
      kind: 'anthropic',
      baseUrl: localBase(mock.port),
      apiKey: 'sk-key-a',
      modelId: 'claude-test',
    });
    await pick(app, table.host, table.campaignId, connId);

    const source = app.app.get(DM_PROVIDER_SOURCE) as DmProviderSource;
    const sourced = await source.get(table.campaignId);
    expect(sourced).not.toBeNull();
    expect(sourced!.provider).toBeInstanceOf(AnthropicProvider);
    expect((sourced!.provider as AnthropicProvider).kind).toBe('anthropic');
  });
});
