import { Module } from '@nestjs/common';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { RouterModule } from '../router/router.module';
import { NotesAdminController } from './notes-admin.controller';
import { NotesAdminService } from './notes-admin.service';

/** M8.5 — host CRUD over campaign notes. Separate from M8.2's read-only `NotesModule`. */
@Module({
  imports: [CampaignsModule, RouterModule],
  controllers: [NotesAdminController],
  providers: [NotesAdminService],
})
export class NotesAdminModule {}
