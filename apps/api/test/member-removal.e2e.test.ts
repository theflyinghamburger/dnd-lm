import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import type { CommandAck, ResumeResponse } from '@dnd-lm/contracts';
import { and, eq } from 'drizzle-orm';
import { type Socket, io } from 'socket.io-client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MembershipService } from '../src/campaigns/membership.service';
import type { Db } from '../src/db/db.module';
import { memberships } from '../src/db/schema';
import { DATABASE_URL, createTestApp, truncateAll } from './app.harness';

const pregen = JSON.parse(
  readFileSync(join(process.cwd(), 'fixtures/pregens/brann-ironfell.json'), 'utf8'),
) as object;

/** #79: FR-102's "remove members" half, including the live-socket eviction. */
describe.skipIf(!DATABASE_URL)('removing a campaign member (FR-102)', () => {
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

  async function signUp(email: string): Promise<{ cookie: string; id: string }> {
    const res = await api()
      .post('/api/auth/register')
      .send({ email, displayName: email.split('@')[0], password: 'a-long-enough-password' })
      .expect(201);
    const cookie = res.headers['set-cookie'];
    return {
      cookie: Array.isArray(cookie) ? cookie[0]! : (cookie as unknown as string),
      id: res.body.id as string,
    };
  }

  async function join(
    campaignId: string,
    hostCookie: string,
    email: string,
    role: 'player' | 'host' = 'player',
  ) {
    const user = await signUp(email);
    const invite = await api()
      .post(`/api/campaigns/${campaignId}/invites`)
      .set('Cookie', hostCookie)
      .send({ role })
      .expect(201);
    await api()
      .post(`/api/invites/${invite.body.token}/accept`)
      .set('Cookie', user.cookie)
      .expect(201);
    return user;
  }

  async function stage() {
    const host = await signUp('host@example.com');
    const campaign = await api()
      .post('/api/campaigns')
      .set('Cookie', host.cookie)
      .send({ name: 'Lost Mine' })
      .expect(201);
    const campaignId = campaign.body.id as string;
    const session = await api()
      .post(`/api/campaigns/${campaignId}/sessions`)
      .set('Cookie', host.cookie)
      .send({})
      .expect(201);
    const player = await join(campaignId, host.cookie, 'player@example.com');
    return { host, player, campaignId, sessionId: session.body.session_id as string };
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

  const remove = (campaignId: string, userId: string, cookie: string) =>
    api().delete(`/api/campaigns/${campaignId}/members/${userId}`).set('Cookie', cookie);

  it('takes every campaign route away from the removed member', async () => {
    const { host, player, campaignId } = await stage();

    await remove(campaignId, player.id, host.cookie).expect(204);

    const listed = await api().get('/api/campaigns').set('Cookie', player.cookie).expect(200);
    expect(listed.body).toEqual([]);
    for (const path of ['', '/roster', '/characters', '/sessions', '/dm-settings']) {
      await api()
        .get(`/api/campaigns/${campaignId}${path}`)
        .set('Cookie', player.cookie)
        .expect(403);
    }

    const roster = await api()
      .get(`/api/campaigns/${campaignId}/roster`)
      .set('Cookie', host.cookie)
      .expect(200);
    expect(roster.body.members.map((m: { userId: string }) => m.userId)).toEqual([host.id]);
  });

  it('disconnects a connected member and refuses their reconnect', async () => {
    const { host, player, campaignId, sessionId } = await stage();
    const hostSocket = await connect(sessionId, host.cookie);
    const playerSocket = await connect(sessionId, player.cookie);

    const dropped = new Promise<string>((resolve) => playerSocket.on('disconnect', resolve));
    await remove(campaignId, player.id, host.cookie).expect(204);

    // `io server disconnect` is socket.io's reason for a server-side kick, as
    // opposed to the transport closing on its own.
    expect(await dropped).toBe('io server disconnect');
    expect(hostSocket.connected).toBe(true);
    await expect(connect(sessionId, player.cookie)).rejects.toThrow('NOT_A_MEMBER');
  });

  it('drops a socket whose removal landed between its handshake and its join', async () => {
    const { player, sessionId } = await stage();
    // The handshake reads the membership once; the removal commits before the
    // join, so the room `evict` would have emptied was still empty. The
    // re-check after the join is what catches it.
    const roleFor = vi.spyOn(app.get(MembershipService), 'roleFor');
    roleFor.mockResolvedValueOnce('player').mockResolvedValueOnce(null);
    try {
      const socket = io(`http://127.0.0.1:${port}`, {
        path: '/ws',
        transports: ['websocket'],
        extraHeaders: { Cookie: player.cookie },
        auth: { sessionId },
        reconnection: false,
      });
      open.push(socket);
      // Listening from the start: the kick can land before `connect` is handled.
      const reason = await new Promise<string>((resolve) => socket.on('disconnect', resolve));
      expect(reason).toBe('io server disconnect');
      expect(roleFor).toHaveBeenCalledTimes(2);
    } finally {
      roleFor.mockRestore();
    }
  });

  it('refuses to remove the owner, and the last host, naming why', async () => {
    const { host, campaignId } = await stage();
    const cohost = await join(campaignId, host.cookie, 'cohost@example.com', 'host');

    const owner = await remove(campaignId, host.id, cohost.cookie).expect(409);
    expect(owner.body.code).toBe('OWNER_NOT_REMOVABLE');

    // The owner's own host row is the thing that normally keeps a host in the
    // campaign; take its role away (as only hand-written SQL can) to reach the
    // last-host rule.
    await db
      .update(memberships)
      .set({ role: 'player' })
      .where(and(eq(memberships.campaignId, campaignId), eq(memberships.userId, host.id)));
    const last = await remove(campaignId, cohost.id, cohost.cookie).expect(409);
    expect(last.body.code).toBe('LAST_HOST');
    await api().get(`/api/campaigns/${campaignId}`).set('Cookie', cohost.cookie).expect(200);
  });

  it('lets a host remove another host while one remains', async () => {
    const { host, campaignId } = await stage();
    const cohost = await join(campaignId, host.cookie, 'cohost@example.com', 'host');
    await remove(campaignId, cohost.id, host.cookie).expect(204);
    await api().get(`/api/campaigns/${campaignId}`).set('Cookie', cohost.cookie).expect(403);
  });

  it('is idempotent: removing a non-member is 204', async () => {
    const { host, player, campaignId } = await stage();
    const stranger = await signUp('stranger@example.com');
    await remove(campaignId, stranger.id, host.cookie).expect(204);
    await remove(campaignId, player.id, host.cookie).expect(204);
    await remove(campaignId, player.id, host.cookie).expect(204);
    await remove(campaignId, 'not-a-uuid', host.cookie).expect(400);
  });

  it('is refused to a player, whatever the UI shows', async () => {
    const { host, player, campaignId } = await stage();
    const other = await join(campaignId, host.cookie, 'other@example.com');
    await remove(campaignId, other.id, player.cookie).expect(403);
    await remove(campaignId, host.id, player.cookie).expect(403);
    await api().get(`/api/campaigns/${campaignId}`).set('Cookie', other.cookie).expect(200);
  });

  it('leaves their characters and their history in place', async () => {
    const { host, player, campaignId, sessionId } = await stage();
    const character = await api()
      .post(`/api/campaigns/${campaignId}/characters/import`)
      .set('Cookie', player.cookie)
      .send(pregen)
      .expect(201);
    const playerSocket = await connect(sessionId, player.cookie);
    const ack = (await playerSocket.timeout(5000).emitWithAck('command', {
      command_id: 'cmd_before',
      type: 'SEND_MESSAGE',
      session_id: sessionId,
      expected_state_version: 0,
      payload: { content: 'I was here.', channel: 'in_character' },
    })) as CommandAck;
    expect(ack.sequence).toBeGreaterThan(0);

    await remove(campaignId, player.id, host.cookie).expect(204);

    const characters = await api()
      .get(`/api/campaigns/${campaignId}/characters`)
      .set('Cookie', host.cookie)
      .expect(200);
    expect(characters.body).toEqual([
      expect.objectContaining({ id: character.body.id, ownerUserId: player.id }),
    ]);
    // Nobody can act as it: the owner is not a member, and the host is not the owner.
    await api()
      .patch(`/api/campaigns/${campaignId}/characters/${character.body.id}/hp`)
      .set('Cookie', host.cookie)
      .send({ currentHp: 1, expectedStateVersion: 0 })
      .expect(403);

    const hostSocket = await connect(sessionId, host.cookie);
    const resumed = (await hostSocket
      .timeout(5000)
      .emitWithAck('resume', { last_sequence: 0 })) as ResumeResponse;
    expect(resumed.events).toContainEqual(
      expect.objectContaining({
        type: 'MESSAGE_POSTED',
        actor: expect.objectContaining({ id: player.id }),
      }),
    );
  });
});
