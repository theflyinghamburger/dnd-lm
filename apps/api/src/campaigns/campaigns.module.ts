import { Module } from '@nestjs/common';
import { CampaignMemberGuard } from './campaign-member.guard';
import { CampaignsController, InvitesController } from './campaigns.controller';
import { CampaignsService } from './campaigns.service';

@Module({
  controllers: [CampaignsController, InvitesController],
  providers: [CampaignsService, CampaignMemberGuard],
})
export class CampaignsModule {}
