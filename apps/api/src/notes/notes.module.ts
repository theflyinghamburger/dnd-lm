import { Module } from '@nestjs/common';
import { NotesService } from './notes.service';

/** M8.2 — campaign-note retrieval. Read-only: no controller until M8.5. */
@Module({
  providers: [NotesService],
  exports: [NotesService],
})
export class NotesModule {}
