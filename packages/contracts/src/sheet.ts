/**
 * Character sheets (M4.2, M4.3).
 *
 * The stored sheet holds *inputs* only. Every derived value is recomputed on
 * read by `deriveSheet` and never persisted as truth (FR-401) — an imported
 * sheet's own idea of its modifiers is discarded, not trusted (D-3).
 */
import { z } from 'zod';
import {
  ABILITIES,
  type Ability,
  MAX_LEVEL,
  MIN_LEVEL,
  SKILLS,
  SKILL_IDS,
  type Skill,
  abilityModifier,
  proficiencyBonus,
} from './srd';

/** 1–30 covers the SRD's full legal span, including magical increases past 20. */
export const AbilityScore = z.int().min(1).max(30);

export const AbilityScores = z.object(
  Object.fromEntries(ABILITIES.map((ability) => [ability, AbilityScore])) as Record<
    Ability,
    typeof AbilityScore
  >,
);
export type AbilityScores = z.infer<typeof AbilityScores>;

export const InventoryItem = z.object({
  name: z.string().min(1).max(120),
  quantity: z.int().min(1).max(9999).default(1),
  equipped: z.boolean().default(false),
});
export type InventoryItem = z.infer<typeof InventoryItem>;

export const Currency = z.object({
  cp: z.int().min(0).default(0),
  sp: z.int().min(0).default(0),
  gp: z.int().min(0).default(0),
  pp: z.int().min(0).default(0),
});
export type Currency = z.infer<typeof Currency>;

/**
 * `strict()` is the point of D-3: an import carrying `passivePerception` or a
 * homebrew field is rejected outright rather than silently ignored, so a player
 * cannot smuggle a derived value past the server.
 */
export const CharacterSheet = z
  .object({
    className: z.string().min(1).max(40),
    level: z.int().min(MIN_LEVEL).max(MAX_LEVEL),
    abilityScores: AbilityScores,
    skillProficiencies: z.array(z.enum(SKILL_IDS as [Skill, ...Skill[]])).default([]),
    saveProficiencies: z.array(z.enum(ABILITIES)).default([]),
    maxHp: z.int().min(1).max(999),
    currentHp: z.int().min(0).max(999).optional(),
    armorClass: z.int().min(1).max(40),
    speed: z.int().min(0).max(200).default(30),
    inventory: z.array(InventoryItem).max(200).default([]),
    currency: Currency.default({ cp: 0, sp: 0, gp: 0, pp: 0 }),
  })
  .strict();
export type CharacterSheet = z.infer<typeof CharacterSheet>;

export type DerivedSheet = {
  proficiencyBonus: number;
  abilityModifiers: Record<Ability, number>;
  saveModifiers: Record<Ability, number>;
  skillModifiers: Record<Skill, number>;
  passivePerception: number;
  initiative: number;
  currentHp: number;
  maxHp: number;
  armorClass: number;
};

/** Pure. No clock, no randomness, no I/O — the same inputs always derive the same sheet. */
export function deriveSheet(sheet: CharacterSheet): DerivedSheet {
  const bonus = proficiencyBonus(sheet.level);

  const abilityModifiers = Object.fromEntries(
    ABILITIES.map((ability) => [ability, abilityModifier(sheet.abilityScores[ability])]),
  ) as Record<Ability, number>;

  const saveProficient = new Set(sheet.saveProficiencies);
  const saveModifiers = Object.fromEntries(
    ABILITIES.map((ability) => [
      ability,
      abilityModifiers[ability] + (saveProficient.has(ability) ? bonus : 0),
    ]),
  ) as Record<Ability, number>;

  const skillProficient = new Set(sheet.skillProficiencies);
  const skillModifiers = Object.fromEntries(
    SKILL_IDS.map((skill) => [
      skill,
      abilityModifiers[SKILLS[skill]] + (skillProficient.has(skill) ? bonus : 0),
    ]),
  ) as Record<Skill, number>;

  return {
    proficiencyBonus: bonus,
    abilityModifiers,
    saveModifiers,
    skillModifiers,
    passivePerception: 10 + skillModifiers.perception,
    initiative: abilityModifiers.dex,
    currentHp: sheet.currentHp ?? sheet.maxHp,
    maxHp: sheet.maxHp,
    armorClass: sheet.armorClass,
  };
}

export const CharacterRecord = z.object({
  id: z.string().min(1),
  campaignId: z.string().min(1),
  ownerUserId: z.string().min(1),
  name: z.string().min(1),
  sheet: CharacterSheet,
  stateVersion: z.int().nonnegative(),
});
export type CharacterRecord = z.infer<typeof CharacterRecord>;

export const ImportCharacterRequest = z.object({
  campaignId: z.string().min(1),
  name: z.string().min(1).max(80),
  sheet: CharacterSheet,
});
export type ImportCharacterRequest = z.infer<typeof ImportCharacterRequest>;

/**
 * The one player-side sheet mutation in the MVP (M4.6). Optimistic on the
 * character's own `stateVersion`, so two open tabs cannot silently overwrite
 * each other's healing.
 */
export const UpdateHpRequest = z.object({
  currentHp: z.int().min(0).max(999),
  expectedStateVersion: z.int().nonnegative(),
});
export type UpdateHpRequest = z.infer<typeof UpdateHpRequest>;
