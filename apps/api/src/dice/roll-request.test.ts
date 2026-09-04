import { CharacterSheet, deriveSheet } from '@dnd-lm/contracts';
import { describe, expect, it } from 'vitest';
import { resolveRollRequest } from './roll-request';

const derived = deriveSheet(
  CharacterSheet.parse({
    className: 'Cleric',
    level: 5,
    abilityScores: { str: 10, dex: 12, con: 14, int: 10, wis: 16, cha: 8 },
    skillProficiencies: ['perception'],
    saveProficiencies: ['wis'],
    maxHp: 38,
    armorClass: 16,
  }),
);

const resolve = (raw: string, sheet = derived) => {
  const result = resolveRollRequest(raw, sheet);
  if (!result.ok) throw new Error(result.error);
  return result;
};

describe('resolveRollRequest', () => {
  it('resolves a skill from the current derived sheet with full provenance (FR-303)', () => {
    const { expression, modifiers, label } = resolve('perception');
    expect(expression).toEqual({ count: 1, sides: 20, modifier: 0, advantage: 'none' });
    expect(label).toBe('Perception');
    expect(modifiers).toEqual([
      { source: 'Wisdom', value: 3 },
      { source: 'Proficiency', value: 3 },
    ]);
  });

  it('omits proficiency when the character is not proficient', () => {
    expect(resolve('stealth').modifiers).toEqual([{ source: 'Dexterity', value: 1 }]);
  });

  it('accepts a display name and a slug alike', () => {
    expect(resolve('Sleight of Hand').label).toBe('Sleight of Hand');
    expect(resolve('sleight_of_hand').label).toBe('Sleight of Hand');
  });

  it('resolves a saving throw', () => {
    expect(resolve('wis save').modifiers).toEqual([
      { source: 'Wisdom', value: 3 },
      { source: 'Proficiency', value: 3 },
    ]);
    expect(resolve('save con').modifiers).toEqual([{ source: 'Constitution', value: 2 }]);
  });

  it('carries advantage on a named roll', () => {
    expect(resolve('perception adv').expression.advantage).toBe('adv');
    expect(resolve('wis save dis').expression.advantage).toBe('dis');
  });

  it('records a source for a raw expression bonus, so every number is attributable', () => {
    expect(resolve('1d20+5').modifiers).toEqual([{ source: 'Expression', value: 5 }]);
    expect(resolve('2d6').modifiers).toEqual([]);
  });

  it('refuses a named roll with no character rather than guessing a modifier', () => {
    const result = resolveRollRequest('perception', null);
    expect(result.ok).toBe(false);
  });

  it('still allows a raw expression with no character', () => {
    expect(resolveRollRequest('1d20', null).ok).toBe(true);
  });

  it('refuses nonsense with an explanation', () => {
    for (const raw of ['', 'juggling', '4d6kh3', '1d7']) {
      expect(resolveRollRequest(raw, derived).ok).toBe(false);
    }
  });
});
