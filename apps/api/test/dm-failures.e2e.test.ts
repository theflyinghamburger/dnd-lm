import { Logger } from '@nestjs/common';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { type AddressInfo } from 'node:net';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { type EventEnvelope } from '@dnd-lm/contracts';
import { campaigns, memberships, sessions, users } from '../src/db/schema';
import { DATABASE_URL, createTestApp, truncateAll, type TestApp } from './app.harness';

/**
 * M7.9 — what a failed turn tells each audience. The player gets the static
 * per-reason sentence and learns nothing about the infrastructure; the
 * operator gets one greppable line per failed resolution carrying the
 * fine-grained class, the connection, the model and the redacted detail.
 *
 * And nothing, ever, fails over to another connection.
 */
describe.skipIf(!DATABASE_URL)('DM provider failure behaviour (M7.9)', () => {
  type Mode = 'dm-json' | 'prose' | 'unauthorized' | 'unknown-model';
  type Mock = { port: number; calls: number; mode: Mode; close: () => Promise<void> };

  const API_KEY = 'sk-failure-secret-4242';
  const MODEL = 'local-llama';

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

  function sse(res: ServerResponse, text: string): void {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (content?: string, usage?: unknown) =>
      JSON.stringify({
        id: 'cmpl-1',
        object: 'chat.completion.chunk',
        choices:
          content !== undefined ? [{ index: 0, delta: { content }, finish_reason: null }] : [],
        ...(usage ? { usage } : {}),
      });
    for (const line of text.split('\n')) res.write(`data: ${chunk(line)}\n\n`);
    res.write(`data: ${chunk(undefined, { prompt_tokens: 9, completion_tokens: 4 })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }

  function mock(): Promise<Mock> {
    const state = { port: 0, calls: 0, mode: 'dm-json' as Mode };
    const server: Server = createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        state.calls += 1;
        if (state.mode === 'unauthorized') {
          res.writeHead(401, { 'content-type': 'application/json' });
          // Providers quote the credential they rejected; M7.2 has to catch it.
          res.end(
            JSON.stringify({
              error: { message: `Incorrect API key provided: ${API_KEY}`, type: 'auth_error' },
            }),
          );
          return;
        }
        if (state.mode === 'unknown-model') {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              error: { message: `The model '${MODEL}' does not exist`, type: 'invalid_request' },
            }),
          );
          return;
        }
        sse(res, state.mode === 'prose' ? 'Just prose, no control block at all.' : DM_TEXT);
      });
    });
    return new Promise((resolve) =>
      server.listen(0, '127.0.0.1', () => {
        state.port = (server.address() as AddressInfo).port;
        resolve(
          Object.assign(state, {
            close: () =>
              new Promise<void>((r) => {
                server.closeAllConnections();
                server.close(() => r());
              }),
          }),
        );
      }),
    );
  }

  let app: TestApp;
  let primary: Mock;
  let admin: string;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  const open: Socket[] = [];

  beforeAll(async () => {
    vi.stubEnv('ALLOW_LOCAL_PROVIDERS', 'true');
    app = await createTestApp();
    primary = await mock();
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await primary?.close();
    await app?.app.close();
  });
  beforeEach(async () => {
    await truncateAll(app.db);
    admin = await makeAdmin();
    primary.calls = 0;
    primary.mode = 'dm-json';
    errorSpy = vi.spyOn(Logger.prototype, 'error');
  });
  afterEach(() => {
    errorSpy.mockRestore();
    for (const socket of open.splice(0)) socket.disconnect();
  });

  const api = () => request(app.app.getHttpServer());
  const localBase = (port: number) => `http://127.0.0.1:${port}/v1`;

  async function signUp(email: string): Promise<string> {
    const res = await api()
      .post('/api/auth/register')
      .send({ email, displayName: email.split('@')[0], password: 'a-long-enough-password' })
      .expect(201);
    const cookie = res.headers['set-cookie'];
    return Array.isArray(cookie) ? cookie[0]! : (cookie as unknown as string);
  }

  async function makeAdmin(): Promise<string> {
    const cookie = await signUp('admin@example.com');
    const [u] = await app.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, 'admin@example.com'))
      .limit(1);
    const [c] = await app.db
      .insert(campaigns)
      .values({ ownerUserId: u!.id, name: 'Admin Home' })
      .returning({ id: campaigns.id });
    await app.db.insert(memberships).values({ campaignId: c!.id, userId: u!.id, role: 'admin' });
    return cookie;
  }

  async function stage(email = 'host@example.com') {
    const host = await signUp(email);
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
    return {
      campaignId: campaign.body.id as string,
      sessionId: session.body.session_id as string,
      host,
    };
  }

  async function createConnection(over: Record<string, unknown> = {}): Promise<string> {
    const res = await api()
      .post('/api/admin/providers')
      .set('Cookie', admin)
      .send({
        label: 'Local Box',
        kind: 'openai_compatible',
        baseUrl: localBase(primary.port),
        apiKey: API_KEY,
        modelId: MODEL,
        ...over,
      })
      .expect(201);
    return res.body.id as string;
  }

  const pick = (cookie: string, campaignId: string, connectionId: string | null) =>
    api()
      .patch(`/api/campaigns/${campaignId}/provider`)
      .set('Cookie', cookie)
      .send({ providerConnectionId: connectionId })
      .expect(200);

  async function connect(sessionId: string, cookie: string): Promise<Socket> {
    const socket = io(`http://127.0.0.1:${app.port}`, {
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
  const say = (socket: Socket, sessionId: string, content: string) =>
    socket.timeout(5000).emitWithAck('command', {
      command_id: `cmd_${(counter += 1)}`,
      type: 'SEND_MESSAGE',
      session_id: sessionId,
      expected_state_version: 0,
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

  /** The operator lines this turn produced, newest last. */
  const operatorLines = (): string[] =>
    (errorSpy.mock.calls.flat() as unknown[])
      .map((entry) => String(entry))
      .filter((line) => line.startsWith('dm.resolution.failed'));

  /**
   * AC-2, applied to every class rather than to one: the sentence the table
   * reads is the static per-reason string and carries nothing about the
   * infrastructure that failed.
   */
  const PLAYER_MESSAGE: Record<string, string> = {
    PROVIDER_ERROR: 'The DM service had a problem and the turn was not committed.',
    NO_PROVIDER: 'The DM is not configured for this table yet.',
    INVALID_OUTPUT:
      'The DM could not produce a well-formed answer, and the turn was not committed.',
  };

  function expectNoLeak(event: EventEnvelope): void {
    const { reason, message } = event.payload as { reason: string; message: string };
    expect(message).toBe(PLAYER_MESSAGE[reason]);
    for (const leak of [
      API_KEY,
      String(primary.port),
      '127.0.0.1',
      MODEL,
      'Incorrect API key',
      'does not exist',
      'dm-json',
      '401',
      '404',
    ]) {
      expect(message).not.toContain(leak);
    }
  }

  /** Runs one @dm turn against the staged table and returns the failure event. */
  async function failedTurn(table: { sessionId: string; host: string }): Promise<EventEnvelope> {
    const host = await connect(table.sessionId, table.host);
    const failed = waitFor(host, 'DM_RESOLUTION_FAILED');
    await say(host, table.sessionId, '@dm Aria picks the lock');
    return failed;
  }

  it.each([
    ['unreachable', 'PROVIDER_ERROR', 'unreachable'],
    ['unauthorized', 'PROVIDER_ERROR', 'unauthenticated'],
    ['unknown-model', 'PROVIDER_ERROR', 'model_not_found'],
  ] as const)(
    'a %s endpoint fails %s, classified %s for the operator (AC-1, AC-3)',
    async (kind, reason, failureClass) => {
      const table = await stage();
      const connectionId = await createConnection(
        // Port 1 on loopback: nothing listens, so the connect is refused.
        kind === 'unreachable' ? { baseUrl: 'http://127.0.0.1:1/v1' } : {},
      );
      if (kind !== 'unreachable') primary.mode = kind;
      await pick(table.host, table.campaignId, connectionId);

      const event = await failedTurn(table);

      expect(event.payload).toMatchObject({ reason });
      expectNoLeak(event);
      const lines = operatorLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(`reason=${reason}`);
      expect(lines[0]).toContain(`class=${failureClass}`);
      expect(lines[0]).toContain(`session=${table.sessionId}`);
      expect(lines[0]).toContain(`connection=${connectionId}`);
      expect(lines[0]).toContain(`model=${MODEL}`);
      expect(lines[0]).toMatch(/resolution=[0-9a-f-]{36}/);
      expect(lines[0]).toContain('detail=');
    },
  );

  it.each([
    ['no_selection', false],
    ['disabled', true],
  ] as const)('a campaign with %s fails NO_PROVIDER (AC-1)', async (failureClass, makeRow) => {
    const table = await stage();
    if (makeRow) {
      const connectionId = await createConnection();
      await pick(table.host, table.campaignId, connectionId);
      await api()
        .patch(`/api/admin/providers/${connectionId}`)
        .set('Cookie', admin)
        .send({ enabled: false })
        .expect(200);
    }

    const event = await failedTurn(table);

    expect(event.payload).toMatchObject({ reason: 'NO_PROVIDER' });
    expectNoLeak(event);
    expect(operatorLines()[0]).toContain(`class=${failureClass}`);
    // No connection was resolved, so the line says so rather than guessing.
    expect(operatorLines()[0]).toContain('connection=-');
    expect(primary.calls).toBe(0);
  });

  it('reports the failure even when the diagnostic read itself fails (AC-6)', async () => {
    const table = await stage();
    const connectionId = await createConnection();
    await pick(table.host, table.campaignId, connectionId);
    await api()
      .patch(`/api/admin/providers/${connectionId}`)
      .set('Cookie', admin)
      .send({ enabled: false })
      .expect(200);

    // `explainNoProvider` reads the row's `enabled` flag to say *why* there is
    // no provider. That read is a diagnostic: a DB blip in exactly this window
    // -- pool exhaustion, a statement timeout, the conditions that cause
    // provider failures in the first place -- must cost the operator the
    // explanation, never the report. The projection below is unique to that
    // read, which is how this targets it and nothing else.
    const passthrough = app.db.select.bind(app.db);
    const select = vi
      .spyOn(app.db, 'select')
      .mockImplementation((projection?: Record<string, unknown>) => {
        if (projection && 'enabled' in projection) throw new Error('pool exhausted');
        return passthrough(projection as never) as never;
      });

    try {
      const event = await failedTurn(table);

      expect(event.payload).toMatchObject({ reason: 'NO_PROVIDER' });
      expectNoLeak(event);
      // The class is the only thing the failed read costs us, and it says so
      // rather than guessing a reason it could not look up.
      expect(operatorLines()[0]).toContain('class=unspecified');
      expect(operatorLines()[0]).toContain(`session=${table.sessionId}`);
    } finally {
      select.mockRestore();
    }
  });

  it('tells the table nothing about the infrastructure that failed (AC-2)', async () => {
    const table = await stage();
    const connectionId = await createConnection();
    primary.mode = 'unauthorized';
    await pick(table.host, table.campaignId, connectionId);

    const event = await failedTurn(table);

    expectNoLeak(event);
    // M7.8's attribution fields are separate keys and stay (see CL-001): the
    // rule is about the sentence the table reads, not about the payload.
    expect(event.payload).toMatchObject({
      provider_connection_id: connectionId,
      model_id: MODEL,
    });
  });

  it('redacts the key out of the operator line, even when the provider echoes it (AC-4)', async () => {
    const table = await stage();
    const connectionId = await createConnection();
    primary.mode = 'unauthorized';
    await pick(table.host, table.campaignId, connectionId);

    await failedTurn(table);

    const line = operatorLines()[0]!;
    expect(line).not.toContain(API_KEY);
    expect(line).toContain('[REDACTED]');
    expect(line).toContain('class=unauthenticated');
  });

  it('a model id cannot forge a field on the operator line', async () => {
    const table = await stage();
    const connectionId = await createConnection({
      modelId: 'evil model" class=unauthenticated connection=someone-elses',
    });
    primary.mode = 'unauthorized';
    await pick(table.host, table.campaignId, connectionId);

    await failedTurn(table);

    const line = operatorLines()[0]!;
    // One `class=` field, and it is the classifier's, not the model id's.
    expect(line.match(/class=/g)).toHaveLength(1);
    expect(line).toContain('class=unauthenticated');
    expect(line).toContain(`connection=${connectionId}`);
    expect(line).not.toContain('connection=someone-elses');
    // The id is still recognisable, just unable to open a field.
    expect(line).toContain('model=evil_model_class_unauthenticated_connection_someone-elses');
  });

  it('never fails over to another connection (AC-5)', async () => {
    const spare = await mock();
    try {
      const table = await stage();
      const failing = await createConnection({ label: 'Failing' });
      // A second, enabled, working connection the campaign did not pick.
      await createConnection({ label: 'Spare', baseUrl: localBase(spare.port) });
      primary.mode = 'unauthorized';
      await pick(table.host, table.campaignId, failing);

      const event = await failedTurn(table);

      expect(event.payload).toMatchObject({ reason: 'PROVIDER_ERROR' });
      // The turn is retried once against the same endpoint (M6.7) — and never
      // against the other one.
      expect(primary.calls).toBeGreaterThanOrEqual(1);
      expect(spare.calls).toBe(0);
      // The selection is untouched: no silent rewiring of the campaign.
      const [row] = await app.db
        .select({ settings: campaigns.settings })
        .from(campaigns)
        .where(eq(campaigns.id, table.campaignId))
        .limit(1);
      expect((row!.settings as { provider_connection_id?: string }).provider_connection_id).toBe(
        failing,
      );
    } finally {
      await spare.close();
    }
  });

  it('still maps an unreadable control block to INVALID_OUTPUT (AC-6)', async () => {
    const table = await stage();
    const connectionId = await createConnection();
    primary.mode = 'prose';
    await pick(table.host, table.campaignId, connectionId);

    const event = await failedTurn(table);

    expect(event.payload).toMatchObject({ reason: 'INVALID_OUTPUT' });
    expectNoLeak(event);
    expect(operatorLines()[0]).toContain('class=graph');
    // The bounded retry ran: two attempts, one endpoint.
    expect(primary.calls).toBe(2);
    const [row] = await app.db
      .select({ status: sessions.status })
      .from(sessions)
      .where(eq(sessions.id, table.sessionId))
      .limit(1);
    expect(row!.status).toBe('WAITING_FOR_PLAYERS');
  });
});
