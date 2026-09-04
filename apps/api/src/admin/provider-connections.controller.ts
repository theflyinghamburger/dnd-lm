import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { AdminConnection } from '@dnd-lm/contracts';
import {
  CreateConnectionRequest,
  ReplaceKeyRequest,
  UpdateConnectionRequest,
} from '@dnd-lm/contracts';
import { CurrentUser } from '../auth/current-user.decorator';
import type { PublicUser } from '@dnd-lm/contracts';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ProviderConnectionsService } from '../providers/connections.service';
import { AdminGuard } from './admin.guard';

/**
 * The admin surface of provider connections (M7.4, FR-805). Every route
 * requires the platform-admin role; nothing here is reachable by a plain
 * campaign host, whatever else that host may do.
 */
@Controller('admin/providers')
@UseGuards(AdminGuard)
export class AdminProviderConnectionsController {
  constructor(private readonly connections: ProviderConnectionsService) {}

  @Get()
  list(): Promise<AdminConnection[]> {
    return this.connections.listForAdmin();
  }

  @Get(':id')
  get(@Param('id') id: string): Promise<AdminConnection> {
    return this.connections.getForAdmin(id);
  }

  @Post()
  create(
    @CurrentUser() user: PublicUser,
    @Body(new ZodValidationPipe(CreateConnectionRequest)) body: CreateConnectionRequest,
  ): Promise<AdminConnection> {
    return this.connections.create(user.id, body);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateConnectionRequest)) body: UpdateConnectionRequest,
  ): Promise<AdminConnection> {
    return this.connections.update(id, body);
  }

  /** Replace key — M7.2's re-encrypt under a fresh nonce (NFR-305). */
  @Post(':id/key')
  @HttpCode(200)
  replaceKey(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ReplaceKeyRequest)) body: ReplaceKeyRequest,
  ): Promise<AdminConnection> {
    return this.connections.replaceKey(id, body.apiKey);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id') id: string): Promise<void> {
    return this.connections.delete(id);
  }
}
