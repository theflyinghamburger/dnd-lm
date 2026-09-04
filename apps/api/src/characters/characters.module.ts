import { Module } from '@nestjs/common';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { DiceService } from '../dice/dice.service';
import { CharactersController } from './characters.controller';
import { CharactersService } from './characters.service';

@Module({
  imports: [CampaignsModule],
  controllers: [CharactersController],
  providers: [CharactersService, DiceService],
  exports: [CharactersService, DiceService],
})
export class CharactersModule {}
