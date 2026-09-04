import { Module } from '@nestjs/common';
import { SessionContextService } from './session-context.service';

/**
 * Its own module because both the gateway (which reads the registry) and the
 * campaigns module (which invalidates it) depend on it — importing either from
 * the other would close a cycle.
 */
@Module({
  providers: [SessionContextService],
  exports: [SessionContextService],
})
export class RouterModule {}
