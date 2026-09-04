/**
 * D&D 5e SRD 5.1 reference data (M4.1, D-2).
 *
 * ---------------------------------------------------------------------------
 * This work includes material from the System Reference Document 5.1 ("SRD
 * 5.1") by Wizards of the Coast LLC, available at
 * https://dnd.wizards.com/resources/systems-reference-document. The SRD 5.1 is
 * licensed under the Creative Commons Attribution 4.0 International License,
 * available at https://creativecommons.org/licenses/by/4.0/legalcode.
 * ---------------------------------------------------------------------------
 *
 * 2014 rules only. There is deliberately no ruleset-version column and no dual
 * fixtures: D-2 resolves spec-doc.md §16's first open question for the MVP.
 */

export const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;
export type Ability = (typeof ABILITIES)[number];

export const ABILITY_NAMES: Record<Ability, string> = {
  str: 'Strength',
  dex: 'Dexterity',
  con: 'Constitution',
  int: 'Intelligence',
  wis: 'Wisdom',
  cha: 'Charisma',
};

/** The 18 skills and their governing ability. */
export const SKILLS = {
  acrobatics: 'dex',
  animal_handling: 'wis',
  arcana: 'int',
  athletics: 'str',
  deception: 'cha',
  history: 'int',
  insight: 'wis',
  intimidation: 'cha',
  investigation: 'int',
  medicine: 'wis',
  nature: 'int',
  perception: 'wis',
  performance: 'cha',
  persuasion: 'cha',
  religion: 'int',
  sleight_of_hand: 'dex',
  stealth: 'dex',
  survival: 'wis',
} as const satisfies Record<string, Ability>;

export type Skill = keyof typeof SKILLS;
export const SKILL_IDS = Object.keys(SKILLS) as Skill[];

export const SKILL_NAMES: Record<Skill, string> = {
  acrobatics: 'Acrobatics',
  animal_handling: 'Animal Handling',
  arcana: 'Arcana',
  athletics: 'Athletics',
  deception: 'Deception',
  history: 'History',
  insight: 'Insight',
  intimidation: 'Intimidation',
  investigation: 'Investigation',
  medicine: 'Medicine',
  nature: 'Nature',
  perception: 'Perception',
  performance: 'Performance',
  persuasion: 'Persuasion',
  religion: 'Religion',
  sleight_of_hand: 'Sleight of Hand',
  stealth: 'Stealth',
  survival: 'Survival',
};

/** Names only for the MVP. Mechanical effects are Phase 3 (MVP.md §7). */
export const CONDITIONS = [
  'blinded',
  'charmed',
  'deafened',
  'exhaustion',
  'frightened',
  'grappled',
  'incapacitated',
  'invisible',
  'paralyzed',
  'petrified',
  'poisoned',
  'prone',
  'restrained',
  'stunned',
  'unconscious',
] as const;
export type Condition = (typeof CONDITIONS)[number];

export const MIN_LEVEL = 1;
export const MAX_LEVEL = 20;

/** SRD progression: +2 at level 1, rising every four levels to +6 at 17. */
export function proficiencyBonus(level: number): number {
  const clamped = Math.min(Math.max(Math.trunc(level), MIN_LEVEL), MAX_LEVEL);
  return 2 + Math.floor((clamped - 1) / 4);
}

/** The one rule the whole sheet hangs off: floor((score - 10) / 2). */
export function abilityModifier(score: number): number {
  return Math.floor((score - 10) / 2);
}
