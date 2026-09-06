/**
 * Platform admin bootstrap (#60, FR-105/NFR-301).
 *
 * M7.4 defines a platform admin as an `admin` membership in any campaign and
 * gives admins sole power over provider connections; nothing said how the first
 * one is made, so the README instructed a hand-typed `UPDATE` on a live table.
 * This is that `UPDATE`, with the checks it never had.
 *
 * Promotion, not invention: no new column, no new table, no `ADMIN_EMAILS` env.
 * `AdminGuard` reads `memberships` through `MembershipService.isPlatformAdmin`,
 * so this writes the row that query already looks for — there is no second
 * notion of admin to keep in step.
 *
 * Only campaigns the user **owns** are promoted. `admin` is not merely the
 * platform flag: `@CampaignRoles('host', 'admin')` treats it as host inside that
 * campaign, so promoting every membership would hand the user host powers in
 * other people's campaigns. One owned row is all `isPlatformAdmin` needs.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { Db } from '../db/db.module';
import * as schema from '../db/schema';
import { campaigns, memberships, users } from '../db/schema';

type Campaign = { id: string; name: string };

export type GrantResult = {
  /** Campaigns whose membership this run moved to `admin`. */
  promoted: Campaign[];
  /** Owned campaigns already at `admin` — a second run reports these, not a second success. */
  alreadyAdmin: Campaign[];
  /** Memberships in campaigns owned by somebody else, deliberately untouched. */
  leftAlone: number;
};

/** Thrown for the operator's mistakes, whose message is the whole output. */
export class GrantError extends Error {}

export async function grantAdmin(db: Db, email: string): Promise<GrantResult> {
  // `users.email` is stored lower-cased; the unique index is on the stored form.
  const address = email.trim().toLowerCase();

  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, address))
    .limit(1);
  if (!user) {
    throw new GrantError(`No account for ${address}. Register in the app first, then re-run this.`);
  }

  const rows = await db
    .select({
      id: campaigns.id,
      name: campaigns.name,
      ownerUserId: campaigns.ownerUserId,
      role: memberships.role,
    })
    .from(memberships)
    .innerJoin(campaigns, eq(campaigns.id, memberships.campaignId))
    .where(eq(memberships.userId, user.id));

  const owned = rows.filter((row) => row.ownerUserId === user.id);
  if (owned.length === 0) {
    throw new GrantError(
      `${address} owns no campaign, so there is no membership to promote. ` +
        'Create a campaign in the app first — the creator gets a host membership on it.',
    );
  }

  const promoted = owned.filter((row) => row.role !== 'admin');
  if (promoted.length > 0) {
    await db
      .update(memberships)
      .set({ role: 'admin' })
      .where(
        and(
          eq(memberships.userId, user.id),
          inArray(
            memberships.campaignId,
            promoted.map((row) => row.id),
          ),
        ),
      );
  }

  const strip = ({ id, name }: Campaign): Campaign => ({ id, name });
  return {
    promoted: promoted.map(strip),
    alreadyAdmin: owned.filter((row) => row.role === 'admin').map(strip),
    leftAlone: rows.length - owned.length,
  };
}

function report(address: string, result: GrantResult): void {
  const list = (campaign: Campaign): string => `  - ${campaign.name}`;
  if (result.promoted.length > 0) {
    console.log(`promoted ${address} to admin in ${result.promoted.length} campaign(s) they own:`);
    console.log(result.promoted.map(list).join('\n'));
  }
  if (result.alreadyAdmin.length > 0) {
    console.log(`already admin in ${result.alreadyAdmin.length} campaign(s):`);
    console.log(result.alreadyAdmin.map(list).join('\n'));
  }
  if (result.leftAlone > 0) {
    console.log(
      `left alone: ${result.leftAlone} membership(s) in campaigns owned by someone else.`,
    );
  }
  console.log(
    result.promoted.length > 0
      ? 'Reload the app — a Providers button appears in the lobby.'
      : 'Nothing to do; this user is already a platform admin.',
  );
}

async function main(): Promise<void> {
  const address = process.argv[2];
  if (!address) {
    throw new GrantError('usage: pnpm --filter @dnd-lm/api admin:grant <email>');
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new GrantError('DATABASE_URL is not set. This script reads the repo-root .env.');
  }

  const client = postgres(url);
  try {
    report(address.trim().toLowerCase(), await grantAdmin(drizzle(client, { schema }), address));
  } finally {
    await client.end();
  }
}

// `typeof require` because vitest transforms this module to ESM, where `require`
// does not exist; the shipped `dist/scripts/grant-admin.js` is CommonJS.
if (typeof require !== 'undefined' && require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof GrantError ? error.message : error);
    process.exit(1);
  });
}
