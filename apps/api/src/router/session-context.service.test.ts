import { TRIGGER_REGISTRY } from '@dnd-lm/contracts';
import { describe, expect, it } from 'vitest';
import { readAliases } from '../notes/notes.service';
import { resolveChapter, resolveRegistry } from './session-context.service';

describe('resolveRegistry', () => {
  it('returns every default-enabled definition when a campaign has no overrides', () => {
    expect(resolveRegistry(null).map((d) => d.id)).toEqual(TRIGGER_REGISTRY.map((d) => d.id));
    expect(resolveRegistry({}).map((d) => d.id)).toEqual(TRIGGER_REGISTRY.map((d) => d.id));
  });

  it('removes a disabled trigger rather than flagging it (rule 7)', () => {
    const ids = resolveRegistry({ triggers: { dm_mention: false } }).map((d) => d.id);
    expect(ids).not.toContain('dm_mention');
    expect(ids).toContain('npc_mention');
  });

  it('ignores overrides for definitions that do not exist', () => {
    expect(resolveRegistry({ triggers: { made_up: true } })).toHaveLength(TRIGGER_REGISTRY.length);
  });

  it('survives settings of the wrong shape', () => {
    expect(resolveRegistry('nonsense')).toHaveLength(TRIGGER_REGISTRY.length);
    expect(resolveRegistry({ triggers: null })).toHaveLength(TRIGGER_REGISTRY.length);
  });
});

describe('resolveChapter (M8.4)', () => {
  it('reads settings.progression.chapter and treats absent or junk as 0', () => {
    expect(resolveChapter({ progression: { chapter: 3 } })).toBe(3);
    for (const junk of [null, {}, { progression: null }, { progression: { chapter: -1 } }]) {
      expect(resolveChapter(junk)).toBe(0);
    }
    expect(resolveChapter({ progression: { chapter: 1.5 } })).toBe(0);
    expect(resolveChapter({ progression: { chapter: '2' } })).toBe(0);
  });
});

describe('readAliases (M8.4)', () => {
  it('keeps string entries and drops everything else without throwing', () => {
    expect(readAliases({ aliases: ['Iarno', 7, null, 'Glasstaff'] })).toEqual([
      'Iarno',
      'Glasstaff',
    ]);
    expect(readAliases({ aliases: 'Iarno' })).toEqual([]);
    expect(readAliases({})).toEqual([]);
    expect(readAliases(null)).toEqual([]);
  });
});
