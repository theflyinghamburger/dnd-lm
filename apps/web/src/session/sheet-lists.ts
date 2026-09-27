import type { Spell } from '@dnd-lm/contracts';

/**
 * The raw expression an attack's bonus rolls as. `1d20±K` is already in the
 * dice grammar `resolveRollRequest` accepts, so no new format is invented
 * (#77). An attack with no stored bonus has nothing to roll: `null`.
 */
export function attackRoll(attackBonus: number | undefined): string | null {
  if (attackBonus === undefined) return null;
  return attackBonus < 0 ? `1d20-${-attackBonus}` : `1d20+${attackBonus}`;
}

/** Spells bucketed by level, lowest first, empty levels omitted, sheet order kept inside each. */
export function spellsByLevel(spells: readonly Spell[]): [level: number, spells: Spell[]][] {
  const buckets = new Map<number, Spell[]>();
  for (const spell of spells)
    buckets.set(spell.level, [...(buckets.get(spell.level) ?? []), spell]);
  return [...buckets].sort(([a], [b]) => a - b);
}

export const levelName = (level: number): string => (level === 0 ? 'Cantrips' : `Level ${level}`);
