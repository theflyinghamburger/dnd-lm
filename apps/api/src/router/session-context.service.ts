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
import { NotesService } from '../notes/notes.service';

type CampaignContext = { registry: TriggerDefinition[]; roster: Roster };

/**
 * The registry and roster a message is parsed against (M3.2).
 *
 * Resolved once per campaign and held in memory. Never re-read per message —
 * routing runs on every line of table talk, and a database round trip there
 * would put the p95 chat budget (NFR-101) at the mercy of the connection pool.
 * Invalidation is explicit: settings, membership and note writes call it.
 *
 * ponytail: an in-process Map, so a second API instance would serve a stale
 * registry until its own invalidation. Multi-instance is Phase 3 (D-1), which
 * is also when this becomes a Redis-backed cache with pub/sub invalidation.
 */
@Injectable()
export class SessionContextService {
  private readonly cache = new Map<string, CampaignContext>();

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly notes: NotesService,
  ) {}

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

    const npcs = await this.notes.npcs(campaignId, resolveChapter(campaign?.settings));

    const context: CampaignContext = {
      registry: resolveRegistry(campaign?.settings),
      roster: buildRoster(members, npcs),
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

/** `settings.progression.chapter`; absent or junk reads 0 — the fewest NPCs, never more (FR-608). */
export function resolveChapter(settings: unknown): number {
  const chapter = (settings as { progression?: { chapter?: unknown } } | null)?.progression
    ?.chapter;
  return Number.isInteger(chapter) && (chapter as number) >= 0 ? (chapter as number) : 0;
}
