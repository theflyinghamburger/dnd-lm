import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import {
  type CampaignSummary,
  CreateCampaignRequest,
  CreateInviteRequest,
  type InviteResponse,
  type PublicUser,
} from '@dnd-lm/contracts';
import { CurrentUser } from '../auth/current-user.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CampaignMemberGuard, CampaignRoles, type MemberRequest } from './campaign-member.guard';
import { CampaignsService } from './campaigns.service';

@Controller('campaigns')
export class CampaignsController {
  constructor(private readonly campaigns: CampaignsService) {}

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
