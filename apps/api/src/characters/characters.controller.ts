import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ImportCharacterRequest, type PublicUser, UpdateHpRequest } from '@dnd-lm/contracts';
import { CurrentUser } from '../auth/current-user.decorator';
import { CampaignMemberGuard } from '../campaigns/campaign-member.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { type CharacterView, CharactersService } from './characters.service';

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

  @Get()
  list(@Param('campaignId') campaignId: string): Promise<CharacterView[]> {
    return this.characters.listForCampaign(campaignId);
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
