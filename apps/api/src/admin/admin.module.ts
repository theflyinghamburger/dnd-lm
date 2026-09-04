import { Module } from '@nestjs/common';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { ProvidersModule } from '../providers/providers.module';
import { AdminGuard } from './admin.guard';
import { AdminProviderConnectionsController } from './provider-connections.controller';

/** The platform-admin REST surface (M7.4). One controller, one guard. */
@Module({
  imports: [CampaignsModule, ProvidersModule],
  controllers: [AdminProviderConnectionsController],
  providers: [AdminGuard],
})
export class AdminModule {}
