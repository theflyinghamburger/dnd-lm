import { Inject, Injectable } from '@nestjs/common';
import {
  TRIGGER_REGISTRY,
  type Roster,
  type TriggerDefinition,
  buildRoster,
} from '@dnd-lm/contracts';
import { eq } from 'drizzle-orm';
import { DB, type Db } from '../db/db.module';
import { campaigns, memberships, users } from '../db/schema';

type CampaignContext = { registry: TriggerDefinition[]; roster: Roster };

/**
 * The registry and roster a message is parsed against (M3.2).
 *
 * Resolved once per campaign and held in memory. Never re-read per message —
 * routing runs on every line of table talk, and a database round trip there
 * would put the p95 chat budget (NFR-101) at the mercy of the connection pool.
 * Invalidation is explicit: settings changes and membership changes call it.
 *
 * ponytail: an in-process Map, so a second API instance would serve a stale
 * registry until its own invalidation. Multi-instance is Phase 3 (D-1), which
 * is also when this becomes a Redis-backed cache with pub/sub invalidation.
 */
@Injectable()
export class SessionContextService {
  private readonly cache = new Map<string, CampaignContext>();

  constructor(@Inject(DB) private readonly db: Db) {}

  invalidate(campaignId: string): void {
    this.cache.delete(campaignId);
  }

  async forCampaign(campaignId: string): Promise<CampaignContext> {
    const cached = this.cache.get(campaignId);
    if (cached) return cached;

    const [campaign] = await this.db
      .select({ settings: campaigns.settings })
      .from(campaigns)
      .where(eq(campaigns.id, campaignId))
      .limit(1);

    const members = await this.db
      .select({
        userId: memberships.userId,
        displayName: users.displayName,
        role: memberships.role,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.campaignId, campaignId));

    const context: CampaignContext = {
      registry: resolveRegistry(campaign?.settings),
      // NPCs stay empty until M8 gives campaigns notes to resolve them from;
      // `@npc Klarg` therefore tells the player the NPC is unknown, which is
      // rule 4's answer and not a special case.
      roster: buildRoster(members, []),
    };
    this.cache.set(campaignId, context);
    return context;
  }
}

/**
 * Static definitions merged with `campaigns.settings.triggers`, a map of
 * definition id to enabled. A disabled trigger is *removed*, so the parser
 * cannot tell it from an unknown tag — which is rule 7 exactly.
 */
export function resolveRegistry(settings: unknown): TriggerDefinition[] {
  const overrides = (settings as { triggers?: Record<string, boolean> } | null)?.triggers ?? {};
  return TRIGGER_REGISTRY.filter(
    (definition) => overrides[definition.id] ?? definition.defaultEnabled,
  );
}
