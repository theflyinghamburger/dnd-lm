import { Module } from '@nestjs/common';
import { RouterModule } from '../router/router.module';
import { CampaignMemberGuard } from './campaign-member.guard';
import { CampaignsController, InvitesController } from './campaigns.controller';
import { CampaignsService } from './campaigns.service';
import { MembershipService } from './membership.service';

@Module({
  imports: [RouterModule],
  controllers: [CampaignsController, InvitesController],
  providers: [CampaignsService, MembershipService, CampaignMemberGuard],
  exports: [MembershipService, CampaignMemberGuard],
})
export class CampaignsModule {}
