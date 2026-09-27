import type { CampaignNote } from '@dnd-lm/contracts';

export type NoteFields = Pick<
  CampaignNote,
  'type' | 'title' | 'bodyMd' | 'spoilerLevel' | 'chapter' | 'status'
>;

/**
 * The note editor's form, read into the shape the API validates (M8.5). Pure,
 * so it is tested without a DOM. An empty chapter means "ungated" (`null`),
 * never 0 — 0 is a real chapter and would gate the note. Anything malformed is
 * passed through for the server's schema to refuse; the client keeps no second
 * copy of the rules.
 */
export function readNoteForm(form: FormData): NoteFields {
  const text = (name: string) => String(form.get(name) ?? '');
  const chapter = text('chapter').trim();
  return {
    type: text('type') as NoteFields['type'],
    title: text('title'),
    bodyMd: text('bodyMd'),
    spoilerLevel: text('spoilerLevel') as NoteFields['spoilerLevel'],
    chapter: chapter === '' ? null : Number(chapter),
    status: text('status') as NoteFields['status'],
  };
}
