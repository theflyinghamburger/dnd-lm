import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import {
  type CampaignDmSettings,
  type CampaignSummary,
  type CampaignTriggersResponse,
  CreateCampaignRequest,
  CreateInviteRequest,
  type InviteResponse,
  type PublicUser,
  type ProviderSettingsResponse,
  type RosterResponse,
  UpdateDmSettingsRequest,
  UpdateProviderRequest,
  UpdateTriggersRequest,
} from '@dnd-lm/contracts';
import { CurrentUser } from '../auth/current-user.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CampaignMemberGuard, CampaignRoles, type MemberRequest } from './campaign-member.guard';
import { SessionContextService } from '../router/session-context.service';
import { CampaignsService } from './campaigns.service';

@Controller('campaigns')
export class CampaignsController {
  constructor(
    private readonly campaigns: CampaignsService,
    private readonly context: SessionContextService,
  ) {}

  @Post()
  create(
    @CurrentUser() user: PublicUser,
    @Body(new ZodValidationPipe(CreateCampaignRequest)) body: CreateCampaignRequest,
  ): Promise<CampaignSummary> {
    return this.campaigns.create(user.id, body);
  }

  @Get()
  list(@CurrentUser() user: PublicUser): Promise<CampaignSummary[]> {
    return this.campaigns.listForUser(user.id);
  }

  @Get(':campaignId')
  @UseGuards(CampaignMemberGuard)
  get(
    @Param('campaignId') campaignId: string,
    @Req() req: MemberRequest,
  ): Promise<CampaignSummary> {
    return this.campaigns.get(campaignId, req.membershipRole ?? 'player');
  }

  @Post(':campaignId/invites')
  @UseGuards(CampaignMemberGuard)
  @CampaignRoles('host', 'admin')
  createInvite(
    @Param('campaignId') campaignId: string,
    @CurrentUser() user: PublicUser,
    @Body(new ZodValidationPipe(CreateInviteRequest)) body: CreateInviteRequest,
  ): Promise<InviteResponse> {
    return this.campaigns.createInvite(campaignId, user.id, body);
  }

  @Get(':campaignId/roster')
  @UseGuards(CampaignMemberGuard)
  roster(@Param('campaignId') campaignId: string): Promise<RosterResponse> {
    return this.context.forCampaign(campaignId).then((c) => c.roster);
  }

  @Get(':campaignId/triggers')
  @UseGuards(CampaignMemberGuard)
  listTriggers(@Param('campaignId') campaignId: string): Promise<CampaignTriggersResponse> {
    return this.campaigns.listTriggers(campaignId);
  }

  @Patch(':campaignId/triggers')
  @UseGuards(CampaignMemberGuard)
  @CampaignRoles('host', 'admin')
  updateTriggers(
    @Param('campaignId') campaignId: string,
    @Body(new ZodValidationPipe(UpdateTriggersRequest)) body: UpdateTriggersRequest,
  ): Promise<CampaignTriggersResponse> {
    return this.campaigns.updateTriggers(campaignId, body);
  }

  /**
   * The campaign's DM settings (M7.6): the selected provider plus the FR-506
   * knobs. Readable by any member — a player may see how the table is set up;
   * only a host or admin may write.
   */
  @Get(':campaignId/dm-settings')
  @UseGuards(CampaignMemberGuard)
  dmSettings(@Param('campaignId') campaignId: string): Promise<CampaignDmSettings> {
    return this.campaigns.getDmSettings(campaignId);
  }

  @Patch(':campaignId/dm-settings')
  @UseGuards(CampaignMemberGuard)
  @CampaignRoles('host', 'admin')
  updateDmSettings(
    @Param('campaignId') campaignId: string,
    @Body(new ZodValidationPipe(UpdateDmSettingsRequest)) body: UpdateDmSettingsRequest,
  ): Promise<CampaignDmSettings> {
    return this.campaigns.updateDmSettings(campaignId, body);
  }

  /**
   * FR-506: which provider connection the campaign's DM runs on (or none).
   * Host-or-admin on *this* campaign, like `triggers` — a host never sees or
   * edits a URL or a key, only picks from enabled connections (M7.4).
   */
  @Patch(':campaignId/provider')
  @UseGuards(CampaignMemberGuard)
  @CampaignRoles('host', 'admin')
  updateProvider(
    @Param('campaignId') campaignId: string,
    @Body(new ZodValidationPipe(UpdateProviderRequest)) body: UpdateProviderRequest,
  ): Promise<ProviderSettingsResponse> {
    return this.campaigns.setProvider(campaignId, body.providerConnectionId);
  }
}

@Controller('invites')
export class InvitesController {
  constructor(private readonly campaigns: CampaignsService) {}

  /** Deliberately not behind `CampaignMemberGuard` — accepting is how you become a member. */
  @Post(':token/accept')
  accept(@Param('token') token: string, @CurrentUser() user: PublicUser): Promise<CampaignSummary> {
    return this.campaigns.acceptInvite(token, user.id);
  }
}
