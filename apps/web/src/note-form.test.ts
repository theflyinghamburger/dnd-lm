import { describe, expect, it } from 'vitest';
import { CreateNoteRequest, UpdateNoteRequest } from '@dnd-lm/contracts';
import { readChapter, readNoteForm } from './note-form';

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
};

const filled = {
  type: 'npc',
  title: 'Klarg',
  bodyMd: '# Klarg\nA bugbear.',
  spoilerLevel: 'dm',
  chapter: '2',
  status: 'draft',
};

describe('the note editor form (M8.5)', () => {
  it('reads a filled form into a payload both request schemas accept', () => {
    const fields = readNoteForm(form(filled));
    expect(fields).toEqual({ ...filled, chapter: 2 });
    expect(UpdateNoteRequest.safeParse(fields).success).toBe(true);
    expect(CreateNoteRequest.safeParse({ slug: 'klarg', ...fields }).success).toBe(true);
  });

  it('an empty chapter is ungated (null), not chapter 0', () => {
    expect(readNoteForm(form({ ...filled, chapter: '' })).chapter).toBeNull();
    expect(readNoteForm(form({ ...filled, chapter: '0' })).chapter).toBe(0);
  });

  it('leaves a bad chapter for the schema to refuse rather than guessing', () => {
    const fields = readNoteForm(form({ ...filled, chapter: '1.5' }));
    expect(UpdateNoteRequest.safeParse(fields).success).toBe(false);
  });

  it('an overflowing chapter is refused, not turned into null by JSON on the way', () => {
    // Number('1e999') is Infinity, and JSON.stringify(Infinity) is null: the
    // server would read "ungated" instead of refusing.
    const sent = JSON.parse(JSON.stringify(readNoteForm(form({ ...filled, chapter: '1e999' }))));
    expect(UpdateNoteRequest.safeParse(sent).success).toBe(false);
    expect(readChapter('1e999')).not.toBeNull();
    expect(readChapter('')).toBeNull();
    expect(readChapter(' 3 ')).toBe(3);
  });
});
