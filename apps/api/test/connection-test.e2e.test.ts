import { createServer, type Server, type ServerResponse } from 'node:http';
import { type AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { AdminConnection, ConnectionTestResult } from '@dnd-lm/contracts';
import { campaigns, memberships, users } from '../src/db/schema';
import { DATABASE_URL, createTestApp, truncateAll, type TestApp } from './app.harness';

/**
 * M7.5 — *Test connection*. One real minimal call through the real adapter,
 * reported per field: a rejected key fails `authenticated` alone, an endpoint
 * that answers prose fails `structuredOutput` alone. The endpoint under test is
 * a local mock OpenAI-compatible server behind the M7.3 wall
 * (`ALLOW_LOCAL_PROVIDERS`), so the suite is offline and deterministic.
 */
describe.skipIf(!DATABASE_URL)('test connection (M7.5)', () => {
  /** What the mock endpoint does with the next request. */
  type Mode = 'dm-json' | 'prose' | 'unauthorized' | 'unknown-model';

  /** The key the connection is created with; the mock echoes it back on 401. */
  const API_KEY = 'sk-test-secret-1234';

  const DM_JSON =
    'The tavern door swings open.\n```dm-json\n' +
    JSON.stringify({
      narration: 'The tavern door swings open.',
      addressed_to: ['party'],
      tool_requests: [],
      proposed_state_changes: [],
      memory_candidates: [],
      next_state: 'WAITING_FOR_PLAYERS',
    }) +
    '\n```';

  let mode: Mode = 'dm-json';
  /**
   * Holds the mock's reply open so a write can commit while a test is still in
   * flight -- the interleaving AC-4 is about.
   */
  let hold: { announce: () => void; held: Promise<void> } | null = null;

  function holdNext(): { arrived: Promise<void>; release: () => void } {
    let announce!: () => void;
    let release!: () => void;
    const arrived = new Promise<void>((resolve) => (announce = resolve));
    const held = new Promise<void>((resolve) => (release = resolve));
    hold = { announce, held };
    return { arrived, release };
  }

  /** Makes the mock's error body enormous, the way a hostile endpoint would. */
  let long = false;
  let calls = 0;
  let server: Server;
  let base: string;
  let app: TestApp;

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

  beforeAll(async () => {
    vi.stubEnv('ALLOW_LOCAL_PROVIDERS', 'true');
    app = await createTestApp();
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', async () => {
        calls += 1;
        if (hold) {
          const gate = hold;
          hold = null;
          gate.announce();
          await gate.held;
        }
        if (mode === 'unauthorized') {
          res.writeHead(401, { 'content-type': 'application/json' });
          // Real providers quote the credential they rejected. That is exactly
          // the string M7.2's redaction has to catch before it is stored.
          res.end(
            JSON.stringify({
              error: {
                message: `Incorrect API key provided: ${API_KEY}${long ? ` ${'x'.repeat(50_000)}` : ''}`,
                type: 'invalid_request_error',
              },
            }),
          );
          return;
        }
        if (mode === 'unknown-model') {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              error: { message: "The model 'ghost' does not exist", type: 'invalid_request_error' },
            }),
          );
          return;
        }
        sse(res, mode === 'prose' ? 'The tavern door swings open. Nothing else.' : DM_JSON);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await app?.app.close();
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  });

  beforeEach(async () => {
    await truncateAll(app.db);
    mode = 'dm-json';
    calls = 0;
    hold = null;
  });

  const api = () => request(app.app.getHttpServer());

  async function signUp(email: string): Promise<string> {
    const res = await api()
      .post('/api/auth/register')
      .send({ email, displayName: email.split('@')[0], password: 'a-long-enough-password' })
      .expect(201);
    const cookie = res.headers['set-cookie'];
    return Array.isArray(cookie) ? cookie[0]! : (cookie as unknown as string);
  }

  /** Option (a) admin: an `admin` membership in any campaign (M7.4). */
  async function makeAdmin(email: string): Promise<string> {
    const cookie = await signUp(email);
    const [u] = await app.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    const [c] = await app.db
      .insert(campaigns)
      .values({ ownerUserId: u!.id, name: 'Admin Home' })
      .returning({ id: campaigns.id });
    await app.db.insert(memberships).values({ campaignId: c!.id, userId: u!.id, role: 'admin' });
    return cookie;
  }

  async function connect(
    cookie: string,
    over: Record<string, unknown> = {},
  ): Promise<AdminConnection> {
    const res = await api()
      .post('/api/admin/providers')
      .set('Cookie', cookie)
      .send(
        // An explicit `apiKey: undefined` in `over` drops the key entirely,
        // which is the keyless local-inference row (M7.3).
        Object.fromEntries(
          Object.entries({
            label: 'Local',
            kind: 'openai_compatible',
            baseUrl: base,
            apiKey: API_KEY,
            modelId: 'local-model',
            ...over,
          }).filter(([, value]) => value !== undefined),
        ),
      )
      .expect(201);
    return res.body;
  }

  async function test(cookie: string, id: string, status = 200): Promise<ConnectionTestResult> {
    const res = await api()
      .post(`/api/admin/providers/${id}/test`)
      .set('Cookie', cookie)
      .expect(status);
    return res.body;
  }

  it('reports all five fields, and every one passes against a working endpoint (AC-1)', async () => {
    const admin = await makeAdmin('admin@example.com');
    const connection = await connect(admin);

    const result = await test(admin, connection.id);

    expect(Object.keys(result)).toEqual(
      expect.arrayContaining([
        'reachable',
        'authenticated',
        'modelExists',
        'structuredOutput',
        'latencyMs',
      ]),
    );
    expect(result.reachable).toBe(true);
    expect(result.authenticated).toBe(true);
    expect(result.modelExists).toBe(true);
    expect(result.structuredOutput).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.detail).toBeNull();
    expect(calls).toBe(1);
  });

  it('a rejected key fails authentication and nothing else (AC-2)', async () => {
    const admin = await makeAdmin('admin@example.com');
    const connection = await connect(admin);
    mode = 'unauthorized';

    const result = await test(admin, connection.id);

    expect(result.reachable).toBe(true);
    expect(result.authenticated).toBe(false);
    expect(result.structuredOutput).toBe(false);
    // The provider quoted the key back; the stored detail must not (NFR-305).
    expect(result.detail).not.toContain(API_KEY);
    expect(result.detail).toContain('[REDACTED]');
  });

  it('a model the endpoint does not serve fails modelExists, not authentication (AC-3)', async () => {
    const admin = await makeAdmin('admin@example.com');
    const connection = await connect(admin, { modelId: 'ghost' });
    mode = 'unknown-model';

    const result = await test(admin, connection.id);

    expect(result.reachable).toBe(true);
    expect(result.authenticated).toBe(true);
    expect(result.modelExists).toBe(false);
    expect(result.structuredOutput).toBe(false);
  });

  it('an endpoint that answers prose fails only structuredOutput (AC-4)', async () => {
    const admin = await makeAdmin('admin@example.com');
    const connection = await connect(admin);
    mode = 'prose';

    const result = await test(admin, connection.id);

    expect(result.reachable).toBe(true);
    expect(result.authenticated).toBe(true);
    expect(result.modelExists).toBe(true);
    expect(result.structuredOutput).toBe(false);
    expect(result.detail).toContain('dm-json');
  });

  it('an endpoint that does not answer fails reachable, and claims nothing past it (AC-5)', async () => {
    const admin = await makeAdmin('admin@example.com');
    // Port 1 on loopback: nothing listens, so the connect is refused at once.
    const connection = await connect(admin, { baseUrl: 'http://127.0.0.1:1/v1' });

    const result = await test(admin, connection.id);

    expect(result.reachable).toBe(false);
    expect(result.authenticated).toBe(false);
    expect(result.modelExists).toBe(false);
    expect(result.structuredOutput).toBe(false);
    expect(calls).toBe(0);
  });

  it('rate-limits per connection, and the refused press makes no provider call (AC-6)', async () => {
    const admin = await makeAdmin('admin@example.com');
    const first = await connect(admin);
    const second = await connect(admin, { label: 'Second' });

    for (let i = 0; i < 5; i += 1) await test(admin, first.id);
    expect(calls).toBe(5);

    await test(admin, first.id, 429);
    expect(calls).toBe(5);

    // The limit is per connection: a different one is unaffected.
    await test(admin, second.id);
    expect(calls).toBe(6);
  });

  it('tests a disabled connection — a draft has to be provable before it is enabled (AC-7)', async () => {
    const admin = await makeAdmin('admin@example.com');
    const connection = await connect(admin);
    await api()
      .patch(`/api/admin/providers/${connection.id}`)
      .set('Cookie', admin)
      .send({ enabled: false })
      .expect(200);

    const result = await test(admin, connection.id);
    expect(result.structuredOutput).toBe(true);
  });

  it('stores the last result on the row, and the admin reads carry it (AC-8)', async () => {
    const admin = await makeAdmin('admin@example.com');
    const connection = await connect(admin);
    expect(connection.lastTest).toBeNull();

    const result = await test(admin, connection.id);

    const one = await api()
      .get(`/api/admin/providers/${connection.id}`)
      .set('Cookie', admin)
      .expect(200);
    expect(one.body.lastTest).toEqual(result);
    const list = await api().get('/api/admin/providers').set('Cookie', admin).expect(200);
    expect(list.body[0].lastTest.at).toBe(result.at);
    // Reading the result does not re-run it (AC-11).
    expect(calls).toBe(1);
  });

  it('never returns key material, on any status code (AC-9)', async () => {
    const admin = await makeAdmin('admin@example.com');
    const connection = await connect(admin);
    mode = 'unauthorized';
    const failed = await test(admin, connection.id);
    mode = 'dm-json';
    const passed = await test(admin, connection.id);
    const reads = await api().get('/api/admin/providers').set('Cookie', admin).expect(200);

    for (const body of [failed, passed, reads.body]) {
      expect(JSON.stringify(body)).not.toContain(API_KEY);
    }
    expect(reads.body[0].apiKeyLast4).toBe('1234');
  });

  it('caps how much a hostile endpoint can write into the row', async () => {
    const admin = await makeAdmin('admin@example.com');
    const connection = await connect(admin);
    long = true;
    mode = 'unauthorized';

    const result = await test(admin, connection.id);

    expect(result.detail!.length).toBeLessThanOrEqual(501);
    long = false;
  });

  it('drops the stored result when the configuration it attested changes', async () => {
    const admin = await makeAdmin('admin@example.com');
    const connection = await connect(admin);
    await test(admin, connection.id);

    // Renaming does not invalidate a verdict about an endpoint and a model.
    const renamed = await api()
      .patch(`/api/admin/providers/${connection.id}`)
      .set('Cookie', admin)
      .send({ label: 'Renamed' })
      .expect(200);
    expect(renamed.body.lastTest).not.toBeNull();

    // Replacing the key does: `authenticated` was about the old credential.
    const rekeyed = await api()
      .post(`/api/admin/providers/${connection.id}/key`)
      .set('Cookie', admin)
      .send({ apiKey: 'sk-test-rotated-0000' })
      .expect(200);
    expect(rekeyed.body.lastTest).toBeNull();

    await test(admin, connection.id);
    const remodelled = await api()
      .patch(`/api/admin/providers/${connection.id}`)
      .set('Cookie', admin)
      .send({ modelId: 'another-model' })
      .expect(200);
    expect(remodelled.body.lastTest).toBeNull();
  });

  it('drops a verdict whose configuration changed while the test ran (AC-4)', async () => {
    const admin = await makeAdmin('admin@example.com');
    const connection = await connect(admin);
    await test(admin, connection.id);
    const before = await api()
      .get(`/api/admin/providers/${connection.id}`)
      .set('Cookie', admin)
      .expect(200);
    expect(before.body.lastTest).not.toBeNull();

    // Hold the endpoint mid-reply and rotate the key underneath the probe. The
    // clearing #39 added runs, and then the in-flight verdict -- computed
    // against the *old* credential -- arrives to be written.
    const gate = holdNext();
    const inFlight = test(admin, connection.id);
    await gate.arrived;
    await api()
      .post(`/api/admin/providers/${connection.id}/key`)
      .set('Cookie', admin)
      .send({ apiKey: 'sk-test-rotated-0000' })
      .expect(200);
    gate.release();
    expect((await inFlight).authenticated).toBe(true);

    // It attests a key the row no longer has, so it is dropped, not stored.
    const after = await api()
      .get(`/api/admin/providers/${connection.id}`)
      .set('Cookie', admin)
      .expect(200);
    expect(after.body.lastTest).toBeNull();
  });

  it('tests a keyless endpoint — an empty key redacts nothing and hides nothing', async () => {
    const admin = await makeAdmin('admin@example.com');
    // No apiKey at all: the M7.3 local-inference case.
    const connection = await connect(admin, { apiKey: undefined });
    expect(connection.apiKeyLast4).toBeNull();

    const passing = await test(admin, connection.id);
    expect(passing.structuredOutput).toBe(true);

    mode = 'unauthorized';
    const failing = await test(admin, connection.id);
    expect(failing.authenticated).toBe(false);
    // The provider's text is kept whole: there is no secret to scrub, and an
    // empty key must not turn into a redaction that eats the message.
    expect(failing.detail).toContain('Incorrect API key provided');
    expect(failing.detail).not.toBe('[REDACTED]');
  });

  it('a test against an id that does not exist is a 404, not a rate-limit entry', async () => {
    const admin = await makeAdmin('admin@example.com');
    await api()
      .post('/api/admin/providers/00000000-0000-0000-0000-000000000000/test')
      .set('Cookie', admin)
      .expect(404);
    expect(calls).toBe(0);
  });

  it('refuses a non-admin, and makes no provider call for them (AC-10)', async () => {
    const admin = await makeAdmin('admin@example.com');
    const connection = await connect(admin);
    const host = await signUp('host@example.com');

    await api().post(`/api/admin/providers/${connection.id}/test`).set('Cookie', host).expect(403);
    await api().post(`/api/admin/providers/${connection.id}/test`).expect(401);
    expect(calls).toBe(0);
  });

  it('no other admin route calls the provider (AC-11)', async () => {
    const admin = await makeAdmin('admin@example.com');
    const connection = await connect(admin);
    await api().get('/api/admin/providers').set('Cookie', admin).expect(200);
    await api().get(`/api/admin/providers/${connection.id}`).set('Cookie', admin).expect(200);
    await api()
      .patch(`/api/admin/providers/${connection.id}`)
      .set('Cookie', admin)
      .send({ label: 'Renamed' })
      .expect(200);
    await api()
      .post(`/api/admin/providers/${connection.id}/key`)
      .set('Cookie', admin)
      .send({ apiKey: 'sk-test-9999' })
      .expect(200);
    await api().delete(`/api/admin/providers/${connection.id}`).set('Cookie', admin).expect(204);

    expect(calls).toBe(0);
  });
});
