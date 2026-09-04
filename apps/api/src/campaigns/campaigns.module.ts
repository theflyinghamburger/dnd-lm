import { Module } from '@nestjs/common';
import { CampaignMemberGuard } from './campaign-member.guard';
import { CampaignsController, InvitesController } from './campaigns.controller';
import { CampaignsService } from './campaigns.service';
import { MembershipService } from './membership.service';

@Module({
  controllers: [CampaignsController, InvitesController],
  providers: [CampaignsService, MembershipService, CampaignMemberGuard],
  exports: [MembershipService, CampaignMemberGuard],
})
export class CampaignsModule {}
