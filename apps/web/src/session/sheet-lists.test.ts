import { describe, expect, it } from 'vitest';
import { Spell, parseDiceExpression } from '@dnd-lm/contracts';
import { attackRoll, levelName, spellsByLevel } from './sheet-lists';

describe('attackRoll', () => {
  /** Every bonus the schema permits must land in the grammar the server parses. */
  it('maps every legal attack bonus onto a d20 the dice grammar accepts', () => {
    for (let bonus = -20; bonus <= 30; bonus++) {
      const parsed = parseDiceExpression(attackRoll(bonus)!);
      expect(parsed).toEqual({
        ok: true,
        expression: { count: 1, sides: 20, modifier: bonus, advantage: 'none' },
      });
    }
  });

  it('has nothing to roll when the sheet stored no bonus', () => {
    expect(attackRoll(undefined)).toBeNull();
  });
});

describe('spellsByLevel', () => {
  const spell = (name: string, level: number) => Spell.parse({ name, level });

  it('groups by level, lowest first, keeping sheet order inside a level', () => {
    const groups = spellsByLevel([
      spell('Shield', 1),
      spell('Fireball', 3),
      spell('Fire Bolt', 0),
      spell('Magic Missile', 1),
    ]);
    expect(groups.map(([level, list]) => [level, list.map((s) => s.name)])).toEqual([
      [0, ['Fire Bolt']],
      [1, ['Shield', 'Magic Missile']],
      [3, ['Fireball']],
    ]);
  });

  it('drops no spell at the schema maximum of 400', () => {
    const many = Array.from({ length: 400 }, (_, i) => spell(`S${i}`, i % 10));
    const groups = spellsByLevel(many);
    expect(groups.map(([level]) => level)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(groups.flatMap(([, list]) => list)).toHaveLength(400);
  });

  it('is empty for a character with no spells', () => {
    expect(spellsByLevel([])).toEqual([]);
  });

  it('names cantrips', () => {
    expect([levelName(0), levelName(1), levelName(9)]).toEqual(['Cantrips', 'Level 1', 'Level 9']);
  });
});
