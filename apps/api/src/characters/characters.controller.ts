import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ImportCharacterRequest, type PublicUser, UpdateHpRequest } from '@dnd-lm/contracts';
import { CurrentUser } from '../auth/current-user.decorator';
import { CampaignMemberGuard, type MemberRequest } from '../campaigns/campaign-member.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { type CharacterView, CharactersService } from './characters.service';
import { readPdfFormFields } from './pdf-form';
import { mapWotcCharacterSheet } from './wotc-sheet';

/**
 * A character sheet is a handful of pages. The cap is enforced by multer before
 * the body is read into memory, so an oversized upload never allocates.
 */
const MAX_SHEET_BYTES = 8 * 1024 * 1024;

/** Only the four fields we use — `@types/multer` would be a dependency for one alias. */
type UploadedPdf = { buffer: Buffer; mimetype: string; size: number };

export type PdfImportResult = {
  character: CharacterView;
  /** What the sheet held that a `CharacterSheet` has no room for (FR-401, D-3). */
  ignored: string[];
};

@Controller('campaigns/:campaignId/characters')
@UseGuards(CampaignMemberGuard)
export class CharactersController {
  constructor(private readonly characters: CharactersService) {}

  /** The campaign comes from the route, which is what the guard checked. */
  @Post('import')
  import(
    @Param('campaignId') campaignId: string,
    @CurrentUser() user: PublicUser,
    @Body(new ZodValidationPipe(ImportCharacterRequest)) body: ImportCharacterRequest,
  ): Promise<CharacterView> {
    return this.characters.import(user.id, campaignId, body);
  }

  /**
   * The same import, from a form-fillable character sheet PDF (M4.7). The PDF is
   * parsed into the *same* `ImportCharacterRequest` the JSON route takes, so both
   * paths cross one schema and a PDF can no more smuggle a derived value past
   * `.strict()` than a hand-written body can (D-3).
   */
  @Post('import-pdf')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_SHEET_BYTES, files: 1 } }))
  async importPdf(
    @Param('campaignId') campaignId: string,
    @CurrentUser() user: PublicUser,
    @UploadedFile() file: UploadedPdf | undefined,
    /**
     * Set only after a `LEVEL_MISMATCH`, and only to the level the refusal named.
     * The echo is the point: it cannot be set usefully without having seen the
     * number, so importing anyway is a decision rather than a blind retry.
     */
    @Query('confirmLevel') confirmLevel?: string,
  ): Promise<PdfImportResult> {
    if (!file) {
      throw new BadRequestException({ code: 'NO_FILE', message: 'Attach a PDF as `file`.' });
    }
    const confirmed = confirmLevel === undefined ? undefined : Number.parseInt(confirmLevel, 10);
    if (confirmed !== undefined && !Number.isInteger(confirmed)) {
      throw new BadRequestException({ code: 'BAD_CONFIRM_LEVEL' });
    }
    const fields = await readPdfFormFields(new Uint8Array(file.buffer));
    const { request, ignored } = mapWotcCharacterSheet(fields, confirmed);
    return { character: await this.characters.import(user.id, campaignId, request), ignored };
  }

  @Get()
  list(@Param('campaignId') campaignId: string): Promise<CharacterView[]> {
    return this.characters.listForCampaign(campaignId);
  }

  /**
   * Owner or host. Without this there is no way to undo an import at all — and a
   * PDF import that read a sheet wrong would otherwise be permanent.
   */
  @Delete(':characterId')
  @HttpCode(204)
  async remove(
    @Param('campaignId') campaignId: string,
    @Param('characterId') characterId: string,
    @CurrentUser() user: PublicUser,
    @Req() request: MemberRequest,
  ): Promise<void> {
    const role = request.membershipRole;
    await this.characters.remove(
      characterId,
      user.id,
      campaignId,
      role === 'host' || role === 'admin',
    );
  }

  /** Ownership is checked here, at the point of mutation (FR-105). */
  @Patch(':characterId/hp')
  updateHp(
    @Param('campaignId') campaignId: string,
    @Param('characterId') characterId: string,
    @CurrentUser() user: PublicUser,
    @Body(new ZodValidationPipe(UpdateHpRequest)) body: UpdateHpRequest,
  ): Promise<CharacterView> {
    return this.characters.updateHp(characterId, user.id, campaignId, body);
  }
}
