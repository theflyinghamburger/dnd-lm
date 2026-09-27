import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UnprocessableEntityException,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { CampaignSource, PublicUser } from '@dnd-lm/contracts';
import { CurrentUser } from '../auth/current-user.decorator';
import { CampaignMemberGuard, CampaignRoles } from '../campaigns/campaign-member.guard';
import { looksLikePdf } from '../characters/pdf-form';
import { SourcesService } from './sources.service';

/**
 * A campaign book is tens of MB. Multer enforces this before the body is
 * buffered, so an oversized upload is a 413 that never allocates.
 */
const MAX_SOURCE_BYTES = 32 * 1024 * 1024;

/** Only the fields we use — `@types/multer` would be a dependency for one alias. */
type UploadedPdf = { buffer: Buffer; originalname: string; mimetype: string; size: number };

const notAPdf = () =>
  new UnprocessableEntityException({ code: 'NOT_A_PDF', message: 'That file is not a PDF.' });

/** Host-or-admin on every route: the book is DM material (NFR-302). */
@Controller('campaigns/:campaignId/sources')
@UseGuards(CampaignMemberGuard)
@CampaignRoles('host', 'admin')
export class SourcesController {
  constructor(private readonly sources: SourcesService) {}

  /**
   * The trust boundary (architecture.md §11, invariant 7), strongest check
   * first: multer's size and file-count limits, then the `%PDF-` magic bytes,
   * then the declared MIME — client-supplied, so never the only check.
   */
  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_SOURCE_BYTES, files: 1 } }))
  upload(
    @Param('campaignId') campaignId: string,
    @CurrentUser() user: PublicUser,
    @UploadedFile() file: UploadedPdf | undefined,
  ): Promise<CampaignSource> {
    if (!file) {
      throw new BadRequestException({ code: 'NO_FILE', message: 'Attach a PDF as `file`.' });
    }
    if (!looksLikePdf(file.buffer)) throw notAPdf();
    if (file.mimetype !== 'application/pdf') throw notAPdf();
    return this.sources.upload(campaignId, user.id, {
      // Display only; capped so a pathological name cannot bloat every list response.
      filename: file.originalname.slice(0, 255),
      buffer: file.buffer,
    });
  }

  @Get()
  list(@Param('campaignId') campaignId: string): Promise<CampaignSource[]> {
    return this.sources.list(campaignId);
  }

  @Get(':id')
  get(
    @Param('campaignId') campaignId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CampaignSource> {
    return this.sources.get(campaignId, id);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(
    @Param('campaignId') campaignId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.sources.remove(campaignId, id);
  }
}
