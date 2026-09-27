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
  return {
    type: text('type') as NoteFields['type'],
    title: text('title'),
    bodyMd: text('bodyMd'),
    spoilerLevel: text('spoilerLevel') as NoteFields['spoilerLevel'],
    chapter: readChapter(text('chapter')),
    status: text('status') as NoteFields['status'],
  };
}

/**
 * A chapter field: empty is `null`. A value `Number` cannot represent finitely
 * (`1e999`) is sent as its raw string, because `JSON.stringify(Infinity)` is
 * `null` and the server would read "ungated"/"cleared" instead of refusing it.
 */
export function readChapter(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : (trimmed as unknown as number);
}
