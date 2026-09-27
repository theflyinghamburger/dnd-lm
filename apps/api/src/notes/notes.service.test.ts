import { describe, expect, it } from 'vitest';
import { estimateTokens } from '../dm/context';
import { capNotes, type RetrievedNote } from './notes.service';

const n = (slug: string, chars: number): RetrievedNote => ({
  slug,
  title: slug,
  body: 'x'.repeat(chars - slug.length),
});

describe('capNotes (M8.2, FR-609)', () => {
  it('keeps the highest-ranked prefix that fits, whole notes only', () => {
    // 40 chars = 10 tokens each.
    const ranked = [n('a', 40), n('b', 40), n('c', 40)];
    const kept = capNotes(ranked, 25);
    expect(kept.map((k) => k.slug)).toEqual(['a', 'b']);
    expect(kept.every((k, i) => k === ranked[i])).toBe(true); // untouched, not truncated
  });

  it('stops at the first note that overflows rather than skipping past it', () => {
    expect(capNotes([n('a', 40), n('big', 400), n('c', 4)], 20).map((k) => k.slug)).toEqual(['a']);
  });

  it('counts title + body with the context layer estimator and admits an exact fit', () => {
    const note = n('exact', 40);
    expect(capNotes([note], estimateTokens(note.title + note.body))).toEqual([note]);
    expect(capNotes([note], estimateTokens(note.title + note.body) - 1)).toEqual([]);
  });
});
