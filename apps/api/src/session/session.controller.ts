import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { CreateSessionRequest, type SessionSnapshot } from '@dnd-lm/contracts';
import { CampaignMemberGuard, CampaignRoles } from '../campaigns/campaign-member.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { SessionService } from './session.service';

/** Sessions live under a campaign, so the membership guard covers both routes. */
@Controller('campaigns/:campaignId/sessions')
@UseGuards(CampaignMemberGuard)
export class SessionController {
  constructor(private readonly sessions: SessionService) {}

  @Post()
  @CampaignRoles('host', 'admin')
  create(
    @Param('campaignId') campaignId: string,
    @Body(new ZodValidationPipe(CreateSessionRequest)) body: CreateSessionRequest,
  ): Promise<SessionSnapshot> {
    return this.sessions.create(campaignId, body.scene_id ?? null);
  }

  @Get()
  list(@Param('campaignId') campaignId: string): Promise<SessionSnapshot[]> {
    return this.sessions.listForCampaign(campaignId);
  }
}
