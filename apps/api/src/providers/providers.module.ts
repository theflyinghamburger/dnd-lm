import { Module } from '@nestjs/common';
import { ProviderSecrets } from './provider-secrets.service';

/**
 * Provider connections (M7). M7.2 contributes the key crypto; M7.3 adds URL
 * validation and M7.4 the admin surface — the module is the shelf they share.
 */
@Module({
  providers: [ProviderSecrets],
  exports: [ProviderSecrets],
})
export class ProvidersModule {}
