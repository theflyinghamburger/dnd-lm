import { randomBytes } from 'node:crypto';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  type CampaignSummary,
  type CampaignTriggersResponse,
  type CreateCampaignRequest,
  type CreateInviteRequest,
  type InviteResponse,
  TRIGGER_REGISTRY,
  type UpdateTriggersRequest,
} from '@dnd-lm/contracts';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { DB, type Db } from '../db/db.module';
import { campaigns, invites, memberships } from '../db/schema';
import { SessionContextService } from '../router/session-context.service';

@Injectable()
export class CampaignsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly context: SessionContextService,
  ) {}

  /**
   * The owner is also a `host` membership row. Ownership is then never a
   * special case in the guard — one lookup answers every authorization question.
   */
  async create(userId: string, input: CreateCampaignRequest): Promise<CampaignSummary> {
    return this.db.transaction(async (tx) => {
      const [campaign] = await tx
        .insert(campaigns)
        .values({ ownerUserId: userId, name: input.name })
        .returning();
      if (!campaign) throw new Error('campaign insert returned no row');

      await tx.insert(memberships).values({
        campaignId: campaign.id,
        userId,
        role: 'host',
      });

      return {
        id: campaign.id,
        name: campaign.name,
        ownerUserId: campaign.ownerUserId,
        role: 'host',
        createdAt: campaign.createdAt.toISOString(),
      };
    });
  }

  async listForUser(userId: string): Promise<CampaignSummary[]> {
    const rows = await this.db
      .select({
        id: campaigns.id,
        name: campaigns.name,
        ownerUserId: campaigns.ownerUserId,
        role: memberships.role,
        createdAt: campaigns.createdAt,
      })
      .from(memberships)
      .innerJoin(campaigns, eq(campaigns.id, memberships.campaignId))
      .where(eq(memberships.userId, userId));

    return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
  }

  async get(campaignId: string, role: CampaignSummary['role']): Promise<CampaignSummary> {
    const [campaign] = await this.db
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, campaignId))
      .limit(1);
    if (!campaign) throw new NotFoundException({ code: 'CAMPAIGN_NOT_FOUND' });

    return {
      id: campaign.id,
      name: campaign.name,
      ownerUserId: campaign.ownerUserId,
      role,
      createdAt: campaign.createdAt.toISOString(),
    };
  }

  async createInvite(
    campaignId: string,
    userId: string,
    input: CreateInviteRequest,
  ): Promise<InviteResponse> {
    const token = randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + input.expiresInHours * 60 * 60 * 1000);
    await this.db
      .insert(invites)
      .values({ token, campaignId, role: input.role, createdBy: userId, expiresAt });
    return { token, campaignId, role: input.role, expiresAt: expiresAt.toISOString() };
  }

  /**
   * Single-use. The invite row is locked `FOR UPDATE` and marked spent in the
   * same transaction that creates the membership, so two clients racing the
   * same link cannot both consume it.
   */
  async acceptInvite(token: string, userId: string): Promise<CampaignSummary> {
    const summary = await this.db.transaction(async (tx) => {
      const [invite] = await tx
        .select()
        .from(invites)
        .where(and(eq(invites.token, token), isNull(invites.usedAt)))
        .limit(1)
        .for('update');

      if (!invite) throw new NotFoundException({ code: 'INVITE_INVALID' });
      if (invite.expiresAt <= new Date()) throw new BadRequestException({ code: 'INVITE_EXPIRED' });

      await tx
        .insert(memberships)
        .values({ campaignId: invite.campaignId, userId, role: invite.role })
        .onConflictDoNothing({ target: [memberships.campaignId, memberships.userId] });

      await tx
        .update(invites)
        .set({ usedAt: sql`now()`, usedBy: userId })
        .where(eq(invites.token, token));

      const [campaign] = await tx
        .select()
        .from(campaigns)
        .where(eq(campaigns.id, invite.campaignId))
        .limit(1);
      if (!campaign) throw new NotFoundException({ code: 'CAMPAIGN_NOT_FOUND' });

      return {
        id: campaign.id,
        name: campaign.name,
        ownerUserId: campaign.ownerUserId,
        role: invite.role,
        createdAt: campaign.createdAt.toISOString(),
      };
    });

    // The roster the router parses against just changed (M3.2).
    this.context.invalidate(summary.id);
    return summary;
  }

  async listTriggers(campaignId: string): Promise<CampaignTriggersResponse> {
    const [campaign] = await this.db
      .select({ settings: campaigns.settings })
      .from(campaigns)
      .where(eq(campaigns.id, campaignId))
      .limit(1);
    if (!campaign) throw new NotFoundException({ code: 'CAMPAIGN_NOT_FOUND' });

    const overrides =
      (campaign.settings as { triggers?: Record<string, boolean> } | null)?.triggers ?? {};

    return {
      triggers: TRIGGER_REGISTRY.map((definition) => ({
        id: definition.id,
        enabled: overrides[definition.id] ?? definition.defaultEnabled,
        entryProfile: definition.entryProfile,
        tag: definition.match?.tag ?? null,
      })),
    };
  }

  /**
   * Merges into `campaigns.settings.triggers` and invalidates the cached
   * registry. Unknown ids are dropped rather than stored, so a typo cannot
   * quietly persist as a setting that matches nothing.
   */
  async updateTriggers(
    campaignId: string,
    input: UpdateTriggersRequest,
  ): Promise<CampaignTriggersResponse> {
    const known = new Set(TRIGGER_REGISTRY.map((d) => d.id));
    const unknown = Object.keys(input.triggers).filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new BadRequestException({ code: 'UNKNOWN_TRIGGER', ids: unknown });
    }

    const [updated] = await this.db
      .update(campaigns)
      .set({
        settings: sql`${campaigns.settings} || jsonb_build_object(
          'triggers',
          coalesce(${campaigns.settings}->'triggers', '{}'::jsonb) || ${JSON.stringify(input.triggers)}::jsonb
        )`,
      })
      .where(eq(campaigns.id, campaignId))
      .returning({ id: campaigns.id });
    if (!updated) throw new NotFoundException({ code: 'CAMPAIGN_NOT_FOUND' });

    this.context.invalidate(campaignId);
    return this.listTriggers(campaignId);
  }
}
