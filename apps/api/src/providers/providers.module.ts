import { Module } from '@nestjs/common';
import { BaseUrlService } from './base-url.service';
import { ConnectionTestService } from './connection-test.service';
import { ProviderConnectionsService } from './connections.service';
import { ProviderSecrets } from './provider-secrets.service';
import { ProviderConnectionsController } from './providers.controller';

/**
 * Provider connections (M7). M7.2 contributes the key crypto; M7.3 adds URL
 * validation; M7.4 the host list, the admin surface (in `admin/`), and the
 * per-campaign selection. The module is the shelf they share.
 */
@Module({
  controllers: [ProviderConnectionsController],
  providers: [ProviderSecrets, BaseUrlService, ProviderConnectionsService, ConnectionTestService],
  exports: [ProviderSecrets, BaseUrlService, ProviderConnectionsService, ConnectionTestService],
})
export class ProvidersModule {}
