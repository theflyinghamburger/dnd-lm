import { Module } from '@nestjs/common';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { SourcesController } from './sources.controller';
import { SourcesService } from './sources.service';

@Module({
  imports: [CampaignsModule],
  controllers: [SourcesController],
  providers: [SourcesService],
})
export class SourcesModule {}
