/**
 * Drizzle schema — the single source of truth for the database shape.
 * Migrations in `drizzle/` are generated from this file and CI fails if the two
 * drift apart (M0.2). Tables land per milestone.
 */
import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/* -------------------------------------------------------------------------- */
/* M1 — identity, campaigns, memberships                                      */
/* -------------------------------------------------------------------------- */

export const membershipRole = pgEnum('membership_role', ['player', 'host', 'admin']);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Stored lower-cased; the unique index is what actually enforces one account per address. */
    email: text('email').notNull(),
    displayName: text('display_name').notNull(),
    /** argon2id. Never leaves the server, never appears in a response. */
    passwordHash: text('password_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('users_email_key').on(t.email)],
);

/**
 * Login sessions. Deliberately NOT `sessions` — that name belongs to game
 * sessions in M2.1, and two different things called "session" in one schema is
 * a bug waiting to happen.
 *
 * The row stores a SHA-256 of the cookie token, not the token: a leaked
 * database dump does not hand over live sessions.
 */
export const authSessions = pgTable(
  'auth_sessions',
  {
    tokenHash: text('token_hash').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('auth_sessions_user_id_idx').on(t.userId)],
);

export const campaigns = pgTable('campaigns', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerUserId: uuid('owner_user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'restrict' }),
  name: text('name').notNull(),
  /**
   * Carries the enabled trigger set (M3.2) and, later, the provider connection
   * and DM style knobs (M7.1). One JSONB column rather than a settings table:
   * it is read whole, per campaign, and never queried by field.
   */
  settings: jsonb('settings')
    .notNull()
    .default(sql`'{}'::jsonb`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: membershipRole('role').notNull().default('player'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('memberships_campaign_user_key').on(t.campaignId, t.userId)],
);

/** Single-use: `usedAt` is set in the same transaction that creates the membership. */
export const invites = pgTable(
  'invites',
  {
    token: text('token').primaryKey(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    role: membershipRole('role').notNull().default('player'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    usedBy: uuid('used_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('invites_campaign_id_idx').on(t.campaignId)],
);

/* -------------------------------------------------------------------------- */
/* M2 — sessions, event log, command idempotency                              */
/* -------------------------------------------------------------------------- */

export const sessionStatus = pgEnum('session_status', [
  'WAITING_FOR_PLAYERS',
  'DM_GENERATING',
  'WAITING_FOR_ROLL',
  'PAUSED',
  'SESSION_ENDED',
]);

/**
 * A play session. `nextSequence` is the allocator for `session_events.sequence`
 * and is bumped by an `UPDATE ... RETURNING` inside the same transaction that
 * inserts the event (M2.1) — never a Postgres sequence, whose gaps on rollback
 * would break replay contiguity.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    status: sessionStatus('status').notNull().default('WAITING_FOR_PLAYERS'),
    nextSequence: integer('next_sequence').notNull().default(1),
    stateVersion: integer('state_version').notNull().default(0),
    sceneId: text('scene_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sessions_campaign_id_idx').on(t.campaignId)],
);

/** Append-only truth (invariant 5). Nothing updates or deletes a row here. */
export const sessionEvents = pgTable(
  'session_events',
  {
    eventId: uuid('event_id').notNull().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    sequence: integer('sequence').notNull(),
    type: text('type').notNull(),
    payload: jsonb('payload')
      .notNull()
      .default(sql`'{}'::jsonb`),
    actor: jsonb('actor').notNull(),
    source: jsonb('source').notNull(),
    stateVersion: integer('state_version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.sequence] })],
);

/**
 * Idempotency ledger. The row is inserted *before* any work, so a duplicate
 * `command_id` blocks on the unique index until the original commits and then
 * reads its stored result instead of performing a second side effect (M2.3).
 */
export const commands = pgTable(
  'commands',
  {
    commandId: text('command_id').primaryKey(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    senderId: uuid('sender_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    result: jsonb('result'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('commands_session_id_idx').on(t.sessionId)],
);
