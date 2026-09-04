import { Module } from '@nestjs/common';
import { AdminModule } from './admin/admin.module';
import { AuthModule } from './auth/auth.module';
import { CampaignsModule } from './campaigns/campaigns.module';
import { CharactersModule } from './characters/characters.module';
import { DbModule } from './db/db.module';
import { DmModule } from './dm/dm.module';
import { HealthController } from './health.controller';
import { RouterModule } from './router/router.module';
import { ProvidersModule } from './providers/providers.module';
import { SessionModule } from './session/session.module';

@Module({
  imports: [
    DbModule,
    AuthModule,
    AdminModule,
    CampaignsModule,
    RouterModule,
    CharactersModule,
    SessionModule,
    ProvidersModule,
    DmModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
