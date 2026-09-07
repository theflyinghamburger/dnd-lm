import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.module';
import { characters, memberships, pendingActions, rolls, sessions } from '../src/db/schema';
import { DATABASE_URL, createTestApp, truncateAll } from './app.harness';

const pregen = JSON.parse(
  readFileSync(join(process.cwd(), 'fixtures/pregens/brann-ironfell.json'), 'utf8'),
) as { name: string; sheet: Record<string, unknown> };

/**
 * The shape every sheet had before `classes[]` — what is sitting in any database
 * written before M4.7. Nothing in the app can produce this any more, so the
 * fixture has to be built by hand.
 */
const LEGACY_SHEET = (() => {
  const { classes, attacks, spells, race, background, hitDice, senses, ...rest } = pregen.sheet;
  void classes;
  void attacks;
  void spells;
  void race;
  void background;
  void hitDice;
  void senses;
  return { ...rest, className: 'Fighter', level: 3 };
})();

describe.skipIf(!DATABASE_URL)('character lifecycle (M4.7 follow-ups)', () => {
  let app: INestApplication;
  let db: Db;

  beforeAll(async () => {
    ({ app, db } = await createTestApp());
  });
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(async () => {
    await truncateAll(db);
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

  async function campaignFor(cookie: string): Promise<string> {
    const res = await api()
      .post('/api/campaigns')
      .set('Cookie', cookie)
      .send({ name: 'Lost Mine' })
      .expect(201);
    return res.body.id as string;
  }

  async function join(campaignId: string, hostCookie: string, cookie: string, role: string) {
    const invite = await api()
      .post(`/api/campaigns/${campaignId}/invites`)
      .set('Cookie', hostCookie)
      .send({ role })
      .expect(201);
    await api().post(`/api/invites/${invite.body.token}/accept`).set('Cookie', cookie).expect(201);
  }

  /** Inserts straight into the table, because no route will produce the old shape. */
  async function insertLegacy(campaignId: string, ownerUserId: string): Promise<string> {
    const [row] = await db
      .insert(characters)
      .values({ campaignId, ownerUserId, name: 'Brann Ironfell', sheet: LEGACY_SHEET })
      .returning({ id: characters.id });
    return row!.id;
  }

  describe('sheets stored before classes[] existed', () => {
    it('lists and derives, rather than throwing from inside deriveSheet', async () => {
      const host = await signUp('host@example.com');
      const campaignId = await campaignFor(host.cookie);
      await insertLegacy(campaignId, host.id);

      const list = await api()
        .get(`/api/campaigns/${campaignId}/characters`)
        .set('Cookie', host.cookie)
        .expect(200);

      expect(list.body).toHaveLength(1);
      expect(list.body[0].sheet.classes).toEqual([{ name: 'Fighter', level: 3 }]);
      expect(list.body[0].derived).toMatchObject({
        level: 3,
        className: 'Fighter 3',
        proficiencyBonus: 2,
      });
      // The reshape is a read-time projection: nothing rewrote the row here.
      const [stored] = await db
        .select({ sheet: characters.sheet })
        .from(characters)
        .where(eq(characters.id, list.body[0].id));
      expect(stored!.sheet).toHaveProperty('className');
    });

    /**
     * A corrupt stored row is an internal fault, not a client one, so the caller
     * gets a 500 and learns nothing about the sheet's shape. What matters is that
     * it is contained at the read boundary — `parseStoredSheet`'s own unit test
     * pins the message that names the field for the operator.
     */
    it('contains a structurally corrupt sheet without leaking its shape', async () => {
      const host = await signUp('host@example.com');
      const campaignId = await campaignFor(host.cookie);
      await db
        .insert(characters)
        .values({
          campaignId,
          ownerUserId: host.id,
          name: 'Broken',
          sheet: { ...LEGACY_SHEET, abilityScores: { str: 'not a number' } },
        })
        .returning({ id: characters.id });

      const res = await api()
        .get(`/api/campaigns/${campaignId}/characters`)
        .set('Cookie', host.cookie)
        .expect(500);
      expect(JSON.stringify(res.body)).not.toMatch(/abilityScores|not a number/);
    });
  });

  describe('deleting a character', () => {
    it('lets the owner delete, and the roll history survives with its provenance', async () => {
      const host = await signUp('host@example.com');
      const campaignId = await campaignFor(host.cookie);
      const created = await api()
        .post(`/api/campaigns/${campaignId}/characters/import`)
        .set('Cookie', host.cookie)
        .send(pregen)
        .expect(201);
      const characterId = created.body.id as string;

      const [session] = await db
        .insert(sessions)
        .values({ campaignId })
        .returning({ id: sessions.id });
      await db.insert(rolls).values({
        sessionId: session!.id,
        characterId,
        expression: '1d20',
        dice: [11],
        modifiers: [],
        total: 11,
        requesterId: host.id,
        stateVersion: 0,
      });

      await api()
        .delete(`/api/campaigns/${campaignId}/characters/${characterId}`)
        .set('Cookie', host.cookie)
        .expect(204);

      expect(await db.select().from(characters).where(eq(characters.id, characterId))).toHaveLength(
        0,
      );
      // FR-302: the roll stays reconstructible; only the link goes null.
      const [roll] = await db.select().from(rolls).where(eq(rolls.sessionId, session!.id));
      expect(roll!.characterId).toBeNull();
      expect(roll!.total).toBe(11);
    });

    it('lets a host delete a player character, and refuses a bystander', async () => {
      const host = await signUp('host@example.com');
      const player = await signUp('player@example.com');
      const other = await signUp('other@example.com');
      const campaignId = await campaignFor(host.cookie);
      await join(campaignId, host.cookie, player.cookie, 'player');
      await join(campaignId, host.cookie, other.cookie, 'player');

      const created = await api()
        .post(`/api/campaigns/${campaignId}/characters/import`)
        .set('Cookie', player.cookie)
        .send(pregen)
        .expect(201);
      const characterId = created.body.id as string;

      await api()
        .delete(`/api/campaigns/${campaignId}/characters/${characterId}`)
        .set('Cookie', other.cookie)
        .expect(403);

      await api()
        .delete(`/api/campaigns/${campaignId}/characters/${characterId}`)
        .set('Cookie', host.cookie)
        .expect(204);
    });

    /** AC-11 names admin alongside host; an authority in the code and not the spec is the bug. */
    it('lets a campaign admin delete a player character', async () => {
      const host = await signUp('host@example.com');
      const player = await signUp('player@example.com');
      const admin = await signUp('admin@example.com');
      const campaignId = await campaignFor(host.cookie);
      await join(campaignId, host.cookie, player.cookie, 'player');
      // An `admin` membership is deliberately not invitable — `CreateInviteRequest`
      // excludes the role — so it is inserted the way the bootstrap creates it.
      await db.insert(memberships).values({ campaignId, userId: admin.id, role: 'admin' });

      const created = await api()
        .post(`/api/campaigns/${campaignId}/characters/import`)
        .set('Cookie', player.cookie)
        .send(pregen)
        .expect(201);

      await api()
        .delete(`/api/campaigns/${campaignId}/characters/${created.body.id}`)
        .set('Cookie', admin.cookie)
        .expect(204);
    });

    /**
     * `pending_actions.authorized_character_ids` is a bare `uuid[]` with no
     * foreign key, so a deletion mid-request would leave a roll nobody can close.
     */
    it('refuses while the character is named in an open pending action', async () => {
      const host = await signUp('host@example.com');
      const campaignId = await campaignFor(host.cookie);
      const created = await api()
        .post(`/api/campaigns/${campaignId}/characters/import`)
        .set('Cookie', host.cookie)
        .send(pregen)
        .expect(201);
      const characterId = created.body.id as string;

      const [session] = await db
        .insert(sessions)
        .values({ campaignId })
        .returning({ id: sessions.id });
      const [action] = await db
        .insert(pendingActions)
        .values({
          sessionId: session!.id,
          type: 'roll',
          requesterId: host.id,
          authorizedCharacterIds: [characterId],
          status: 'open',
        })
        .returning({ id: pendingActions.id });

      const refused = await api()
        .delete(`/api/campaigns/${campaignId}/characters/${characterId}`)
        .set('Cookie', host.cookie)
        .expect(409);
      expect(refused.body.code).toBe('CHARACTER_HAS_OPEN_ACTION');

      // Closing it unblocks the delete — the guard is on "open", not on existing.
      await db
        .update(pendingActions)
        .set({ status: 'completed', completedAt: sql`now()` })
        .where(eq(pendingActions.id, action!.id));

      await api()
        .delete(`/api/campaigns/${campaignId}/characters/${characterId}`)
        .set('Cookie', host.cookie)
        .expect(204);
    });

    it('refuses a character in another campaign the same way as one you do not own', async () => {
      const host = await signUp('host@example.com');
      const stranger = await signUp('stranger@example.com');
      const mine = await campaignFor(host.cookie);
      const theirs = await campaignFor(stranger.cookie);

      const created = await api()
        .post(`/api/campaigns/${mine}/characters/import`)
        .set('Cookie', host.cookie)
        .send(pregen)
        .expect(201);

      // Right owner, wrong campaign: still 403, so nothing is probeable.
      await api()
        .delete(`/api/campaigns/${theirs}/characters/${created.body.id}`)
        .set('Cookie', stranger.cookie)
        .expect(403);
    });
  });
});
