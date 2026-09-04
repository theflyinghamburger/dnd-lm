import { Module, forwardRef } from '@nestjs/common';
import { SessionModule } from '../session/session.module';
import { DmContextReader } from './context';
import { DmOrchestrator, DmProviderSource, DM_PROVIDER_SOURCE } from './orchestrator';

/**
 * The DM module (M6). It imports the session module for its service, and the
 * session module imports this one (forward-referenced) for the orchestrator
 * its gateway consumes — the cycle Nest needs to break, broken once.
 */
@Module({
  imports: [forwardRef(() => SessionModule)],
  providers: [
    DmContextReader,
    DmOrchestrator,
    { provide: DM_PROVIDER_SOURCE, useClass: DmProviderSource },
  ],
  exports: [DmOrchestrator, DM_PROVIDER_SOURCE],
})
export class DmModule {}
