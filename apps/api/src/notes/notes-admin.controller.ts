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
import {
  type CampaignNote,
  type CampaignNoteSummary,
  CreateNoteRequest,
  UpdateNoteRequest,
} from '@dnd-lm/contracts';
import { CampaignMemberGuard, CampaignRoles } from '../campaigns/campaign-member.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { NotesAdminService } from './notes-admin.service';

/**
 * M8.5 — the notes a host prepares a campaign with (FR-611). A note carries
 * `dm`-level content, so **reads** are host-or-admin as well as writes: a
 * player who can `GET` a note has read the module's spoilers (FR-105).
 *
 * The guard and role list sit on the class, not on each route, so a route
 * added here later is host-or-admin unless someone deliberately says otherwise.
 */
@Controller('campaigns/:campaignId/notes')
@UseGuards(CampaignMemberGuard)
@CampaignRoles('host', 'admin')
export class NotesAdminController {
  constructor(private readonly notes: NotesAdminService) {}

  @Get()
  list(@Param('campaignId') campaignId: string): Promise<CampaignNoteSummary[]> {
    return this.notes.list(campaignId);
  }

  @Post()
  create(
    @Param('campaignId') campaignId: string,
    @Body(new ZodValidationPipe(CreateNoteRequest)) body: CreateNoteRequest,
  ): Promise<CampaignNote> {
    return this.notes.create(campaignId, body);
  }

  @Get(':slug')
  get(@Param('campaignId') campaignId: string, @Param('slug') slug: string): Promise<CampaignNote> {
    return this.notes.get(campaignId, slug);
  }

  @Patch(':slug')
  update(
    @Param('campaignId') campaignId: string,
    @Param('slug') slug: string,
    @Body(new ZodValidationPipe(UpdateNoteRequest)) body: UpdateNoteRequest,
  ): Promise<CampaignNote> {
    return this.notes.update(campaignId, slug, body);
  }

  @Delete(':slug')
  @HttpCode(204)
  remove(@Param('campaignId') campaignId: string, @Param('slug') slug: string): Promise<void> {
    return this.notes.remove(campaignId, slug);
  }
}
