import { Controller, Get } from '@nestjs/common';
import type { HostConnection } from '@dnd-lm/contracts';
import { ProviderConnectionsService } from './connections.service';

/**
 * The host-facing list (M7.4): enabled connections, redacted — enough to pick
 * a provider, nothing that could carry a URL or a key. Any authenticated user
 * may read it; the shape is the boundary, not a wider guard.
 */
@Controller('providers')
export class ProviderConnectionsController {
  constructor(private readonly connections: ProviderConnectionsService) {}

  @Get()
  list(): Promise<HostConnection[]> {
    return this.connections.listForHosts();
  }
}
