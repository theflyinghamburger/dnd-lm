import { describe, expect, it } from 'vitest';
import { CharacterSheet, deriveSheet } from './sheet';
import { ABILITIES, SKILL_IDS, abilityModifier, proficiencyBonus } from './srd';

const base = {
  className: 'Fighter',
  level: 5,
  abilityScores: { str: 16, dex: 14, con: 15, int: 10, wis: 12, cha: 8 },
  skillProficiencies: ['athletics', 'perception'],
  saveProficiencies: ['str', 'con'],
  maxHp: 44,
  armorClass: 18,
};

describe('abilityModifier', () => {
  // Property: the SRD rule, across the whole legal span, not three samples.
  it('is floor((score - 10) / 2) for every score from 1 to 30', () => {
    for (let score = 1; score <= 30; score += 1) {
      expect(abilityModifier(score)).toBe(Math.floor((score - 10) / 2));
    }
  });

  it('handles the odd/even boundary the way the table does', () => {
    expect([8, 9, 10, 11, 12].map(abilityModifier)).toEqual([-1, -1, 0, 0, 1]);
  });
});

describe('proficiencyBonus', () => {
  it('matches the SRD progression at every level', () => {
    const expected = [
      [1, 2],
      [2, 2],
      [3, 2],
      [4, 2],
      [5, 3],
      [6, 3],
      [7, 3],
      [8, 3],
      [9, 4],
      [10, 4],
      [11, 4],
      [12, 4],
      [13, 5],
      [14, 5],
      [15, 5],
      [16, 5],
      [17, 6],
      [18, 6],
      [19, 6],
      [20, 6],
    ] as const;
    for (const [level, bonus] of expected) expect(proficiencyBonus(level)).toBe(bonus);
  });

  it('clamps out-of-range levels rather than extrapolating', () => {
    expect(proficiencyBonus(0)).toBe(2);
    expect(proficiencyBonus(99)).toBe(6);
  });
});

describe('deriveSheet', () => {
  const sheet = CharacterSheet.parse(base);
  const derived = deriveSheet(sheet);

  it('derives every ability, save and skill', () => {
    expect(Object.keys(derived.abilityModifiers)).toHaveLength(ABILITIES.length);
    expect(Object.keys(derived.saveModifiers)).toHaveLength(ABILITIES.length);
    expect(Object.keys(derived.skillModifiers)).toHaveLength(SKILL_IDS.length);
    expect(SKILL_IDS).toHaveLength(18);
  });

  it('adds proficiency only where the sheet claims it', () => {
    expect(derived.proficiencyBonus).toBe(3);
    expect(derived.skillModifiers.athletics).toBe(3 + 3); // STR +3, proficient
    expect(derived.skillModifiers.acrobatics).toBe(2); // DEX +2, not proficient
    expect(derived.saveModifiers.str).toBe(3 + 3);
    expect(derived.saveModifiers.dex).toBe(2);
  });

  it('computes passive Perception and initiative from the same modifiers', () => {
    expect(derived.skillModifiers.perception).toBe(1 + 3); // WIS +1, proficient
    expect(derived.passivePerception).toBe(10 + 4);
    expect(derived.initiative).toBe(2);
  });

  it('defaults current HP to maximum and is pure', () => {
    expect(derived.currentHp).toBe(44);
    expect(deriveSheet(sheet)).toEqual(derived);
  });
});

describe('CharacterSheet import validation (D-3)', () => {
  it('rejects a derived value smuggled into the payload', () => {
    const result = CharacterSheet.safeParse({ ...base, passivePerception: 99 });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown skill', () => {
    expect(CharacterSheet.safeParse({ ...base, skillProficiencies: ['juggling'] }).success).toBe(
      false,
    );
  });

  it('rejects an out-of-range score or level', () => {
    expect(
      CharacterSheet.safeParse({ ...base, abilityScores: { ...base.abilityScores, str: 31 } })
        .success,
    ).toBe(false);
    expect(CharacterSheet.safeParse({ ...base, level: 21 }).success).toBe(false);
  });

  it('fills the optional inputs so a minimal sheet still derives', () => {
    const parsed = CharacterSheet.parse(base);
    expect(parsed.speed).toBe(30);
    expect(parsed.inventory).toEqual([]);
    expect(parsed.currency).toEqual({ cp: 0, sp: 0, gp: 0, pp: 0 });
  });
});
