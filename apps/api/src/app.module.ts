import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { CampaignsModule } from './campaigns/campaigns.module';
import { CharactersModule } from './characters/characters.module';
import { DbModule } from './db/db.module';
import { HealthController } from './health.controller';
import { RouterModule } from './router/router.module';
import { SessionModule } from './session/session.module';

@Module({
  imports: [DbModule, AuthModule, CampaignsModule, RouterModule, CharactersModule, SessionModule],
  controllers: [HealthController],
})
export class AppModule {}
