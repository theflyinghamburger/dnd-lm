import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { CampaignsModule } from './campaigns/campaigns.module';
import { DbModule } from './db/db.module';
import { HealthController } from './health.controller';

@Module({
  imports: [DbModule, AuthModule, CampaignsModule],
  controllers: [HealthController],
})
export class AppModule {}
