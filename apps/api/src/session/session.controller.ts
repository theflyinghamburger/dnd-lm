import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CreateSessionRequest, type SessionSnapshot } from '@dnd-lm/contracts';
import { CampaignMemberGuard, CampaignRoles } from '../campaigns/campaign-member.guard';
import { CampaignsService } from '../campaigns/campaigns.service';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { SessionGateway } from './session.gateway';
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

/**
 * FR-102: a host removes a member (#79). It lives here rather than on
 * `CampaignsController` because the half that matters is the gateway's:
 * dropping the member's live sockets. The campaigns module cannot import this
 * one without a cycle.
 */
@Controller('campaigns/:campaignId/members')
@UseGuards(CampaignMemberGuard)
export class MembersController {
  constructor(
    private readonly campaigns: CampaignsService,
    private readonly gateway: SessionGateway,
  ) {}

  @Delete(':userId')
  @HttpCode(204)
  @CampaignRoles('host', 'admin')
  async remove(
    @Param('campaignId') campaignId: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
  ): Promise<void> {
    await this.campaigns.removeMember(campaignId, userId);
    // After the commit, so a socket reconnecting the instant it is dropped
    // meets a handshake that already sees no membership.
    this.gateway.evict(campaignId, userId);
  }
}
