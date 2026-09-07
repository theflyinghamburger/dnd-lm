import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CharacterSheet, deriveSheet } from '@dnd-lm/contracts';
import type { PdfFormField } from './pdf-form';
import { mapWotcCharacterSheet, parseClassLine } from './wotc-sheet';

// vitest runs from the workspace root. The fixture is the form-field dump of a
// real D&D Beyond export (a multiclass Artificer 5 / Wizard 2 with 95 spells),
// with the published rules prose elided — every field the mapping reads is real.
const FIELDS = JSON.parse(
  readFileSync(join(process.cwd(), 'fixtures/character-sheets/wotc-form-fields.json'), 'utf8'),
) as PdfFormField[];

const without = (name: string) => FIELDS.filter((field) => field.name !== name);
const replacing = (name: string, value: string) =>
  FIELDS.map((field) => (field.name === name ? { ...field, value } : field));

describe('parseClassLine', () => {
  it('reads a single class', () => {
    expect(parseClassLine('Fighter 3')).toEqual([{ name: 'Fighter', level: 3 }]);
  });

  it('reads a multiclass line', () => {
    expect(parseClassLine('Artificer 5 / Wizard 2')).toEqual([
      { name: 'Artificer', level: 5 },
      { name: 'Wizard', level: 2 },
    ]);
  });

  /** The level is matched at the end, so a parenthesised subclass survives. */
  it('keeps a subclass with the class name', () => {
    expect(parseClassLine('Wizard (Evocation) 5')).toEqual([
      { name: 'Wizard (Evocation)', level: 5 },
    ]);
  });

  it('refuses a line with no level rather than guessing one', () => {
    expect(() => parseClassLine('Fighter')).toThrow(/Could not read/);
  });
});

describe('mapWotcCharacterSheet', () => {
  const { request, ignored } = mapWotcCharacterSheet(FIELDS);
  const sheet = request.sheet;

  it('reads the identity and the multiclass line', () => {
    expect(request.name).toBe('Varric Ironwright');
    expect(sheet.classes).toEqual([
      { name: 'Artificer', level: 5 },
      { name: 'Wizard', level: 2 },
    ]);
  });

  it('reads the ability scores as written', () => {
    expect(sheet.abilityScores).toEqual({ str: 6, dex: 14, con: 16, int: 20, wis: 14, cha: 10 });
  });

  /** Saves are marked with "•" and skills with "P" — any marker means proficient. */
  it('reads proficiencies from both marker styles', () => {
    expect(sheet.saveProficiencies).toEqual(['con', 'int']);
    expect(sheet.skillProficiencies).toEqual([
      'insight',
      'investigation',
      'perception',
      'persuasion',
    ]);
  });

  it('reads the combat numbers, parsing units off the speed', () => {
    expect(sheet.maxHp).toBe(57);
    expect(sheet.armorClass).toBe(18);
    expect(sheet.speed).toBe(30); // from "30 ft. (Walking)"
  });

  it('reads equipment with quantities', () => {
    expect(sheet.inventory).toContainEqual({
      name: 'Crossbow Bolts',
      quantity: 20,
      equipped: false,
    });
    // The sheet has no equipped column; assuming "yes" would arm the character.
    expect(sheet.inventory.every((item) => !item.equipped)).toBe(true);
  });

  it('reads coins, and there is no electrum to lose here', () => {
    expect(sheet.currency).toEqual({ cp: 0, sp: 0, gp: 33, pp: 0 });
  });

  it('reads the attack lines', () => {
    expect(sheet.attacks).toHaveLength(4);
    expect(sheet.attacks[0]).toEqual({
      name: 'Longsword',
      attackBonus: 1,
      damage: '1d8-2 Slashing',
      notes: 'Martial, Versatile, Sap',
    });
  });

  /**
   * The banners are separate fields, so the level of a spell is decided by where
   * it sits on the page. This is the assertion that pins that reading.
   */
  it('groups every spell under the banner above it', () => {
    expect(sheet.spells).toHaveLength(95);
    const byLevel = sheet.spells.reduce<Record<number, number>>((counts, spell) => {
      counts[spell.level] = (counts[spell.level] ?? 0) + 1;
      return counts;
    }, {});
    expect(byLevel).toEqual({ 0: 5, 1: 45, 2: 45 });

    const level = (name: string) => sheet.spells.find((spell) => spell.name === name)?.level;
    expect(level('Fire Bolt')).toBe(0); // first cantrip, top of page 6
    expect(level('Shield')).toBe(1);
    expect(level('Misty Step')).toBe(2); // last page, would be wrong if pages ran together
  });

  it('reads spell detail and tells prepared from merely known', () => {
    const shield = sheet.spells.find((spell) => spell.name === 'Shield');
    expect(shield).toMatchObject({
      level: 1,
      prepared: true,
      castingTime: '1R',
      components: 'V,S',
    });
    // "O" is known-but-unprepared, which every cantrip is.
    expect(sheet.spells.find((spell) => spell.name === 'Fire Bolt')?.prepared).toBe(false);
    expect(sheet.spells.filter((spell) => spell.prepared)).toHaveLength(4);
  });

  /** D-3: the file is full of modifiers and none of them may reach the sheet. */
  it('imports no derived value from the file', () => {
    const keys = Object.keys(sheet);
    expect(keys).not.toContain('level');
    expect(keys).not.toContain('className');
    expect(keys).not.toContain('proficiencyBonus');
    expect(keys).not.toContain('passivePerception');
    expect(keys).not.toContain('initiative');
    // `.strict()` is what enforces it, so the round trip must hold.
    expect(() => CharacterSheet.parse(sheet)).not.toThrow();
  });

  it('derives the same proficiency bonus the sheet states', () => {
    const derived = deriveSheet(sheet);
    expect(derived.level).toBe(7);
    expect(derived.className).toBe('Artificer 5 / Wizard 2');
    expect(derived.proficiencyBonus).toBe(3); // the file's own "ProfBonus" is +3
    // INT 20 (+5) with proficiency: the file says "ST Intelligence +8".
    expect(derived.saveModifiers.int).toBe(8);
    // WIS 14 (+2) with proficiency: the file says "Perception +5".
    expect(derived.skillModifiers.perception).toBe(5);
  });

  it('imports the short scalar fields', () => {
    expect(sheet.race).toBe('Custom Lineage');
    expect(sheet.background).toBe('Guild Artisan / Guild Merchant');
    expect(sheet.hitDice).toBe('5d8 + 2d6');
    expect(sheet.senses).toBe('Darkvision 60 ft.');
  });

  it('names what it could not carry across, and no longer names what it can', () => {
    const report = ignored.join(' | ');
    expect(report).toMatch(/features and traits/);
    expect(report).toMatch(/actions/);
    expect(report).toMatch(/proficiencies and languages/);
    expect(report).toMatch(/recomputed/);
    // These four have a home now; reporting them as lost would be a lie.
    expect(report).not.toMatch(/race/);
    expect(report).not.toMatch(/background/);
    expect(report).not.toMatch(/hit dice/);
    expect(report).not.toMatch(/senses/);
  });
});

describe('mapWotcCharacterSheet refusals', () => {
  it('refuses a PDF that is not a character sheet', () => {
    expect(() => mapWotcCharacterSheet(without('CharacterName'))).toThrow(/no character-sheet/);
  });

  it('refuses a sheet missing an ability score rather than defaulting it', () => {
    expect(() => mapWotcCharacterSheet(without('INT'))).toThrow(/no INT score/);
  });

  /**
   * The one place the file's own arithmetic is read. A class line we misparse
   * would import the character at the wrong level and quietly skew every roll,
   * so a disagreement is a refusal rather than a warning.
   */
  it('refuses when the stated proficiency bonus contradicts the parsed level', () => {
    expect(() => mapWotcCharacterSheet(replacing('CLASS LEVEL', 'Artificer 2'))).toThrow(
      /Refusing rather than importing at the wrong level/,
    );
  });

  it('carries the numbers the client needs to offer an override', () => {
    try {
      mapWotcCharacterSheet(replacing('CLASS LEVEL', 'Artificer 2'));
      expect.unreachable('should have refused');
    } catch (error) {
      expect((error as { response: Record<string, unknown> }).response).toMatchObject({
        code: 'LEVEL_MISMATCH',
        parsedLevel: 2,
        statedBonus: 3,
        derivedBonus: 2,
      });
    }
  });

  it('imports when the caller confirms the level it was shown', () => {
    const { request } = mapWotcCharacterSheet(replacing('CLASS LEVEL', 'Artificer 2'), 2);
    expect(request.sheet.classes).toEqual([{ name: 'Artificer', level: 2 }]);
  });

  /** A blind retry cannot succeed: the number has to match what was parsed. */
  it('still refuses when the confirmed level is not the parsed one', () => {
    expect(() => mapWotcCharacterSheet(replacing('CLASS LEVEL', 'Artificer 2'), 7)).toThrow(
      /Refusing rather than importing at the wrong level/,
    );
  });

  it('accepts a single-class sheet whose level still matches the bonus', () => {
    const { request } = mapWotcCharacterSheet(replacing('CLASS LEVEL', 'Artificer 7'));
    expect(request.sheet.classes).toEqual([{ name: 'Artificer', level: 7 }]);
  });
});
