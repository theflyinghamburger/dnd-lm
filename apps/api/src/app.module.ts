import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { CampaignsModule } from './campaigns/campaigns.module';
import { DbModule } from './db/db.module';
import { HealthController } from './health.controller';
import { SessionModule } from './session/session.module';

@Module({
  imports: [DbModule, AuthModule, CampaignsModule, SessionModule],
  controllers: [HealthController],
})
export class AppModule {}
