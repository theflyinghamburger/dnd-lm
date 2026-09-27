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
 * A multiclass character is a list of class levels (M4.2 + the PDF import).
 * The character's *level* is their sum and is therefore derived, never stored —
 * the same rule as every other derived value (FR-401, D-3).
 */
export const CharacterClass = z.object({
  name: z.string().min(1).max(40),
  level: z.int().min(MIN_LEVEL).max(MAX_LEVEL),
});
export type CharacterClass = z.infer<typeof CharacterClass>;

/**
 * A named attack line. `damage` stays a string ("1d8+2 Slashing") because the
 * sheet is a record of what the character *has*, not a roll: the dice service
 * parses an expression when someone actually rolls it (FR-301).
 */
export const Attack = z.object({
  name: z.string().min(1).max(60),
  attackBonus: z.int().min(-20).max(30).optional(),
  damage: z.string().max(60).optional(),
  notes: z.string().max(160).optional(),
});
export type Attack = z.infer<typeof Attack>;

/** Level 0 is a cantrip. Everything past the name is optional: sources vary. */
export const Spell = z.object({
  name: z.string().min(1).max(80),
  level: z.int().min(0).max(9),
  prepared: z.boolean().default(false),
  source: z.string().max(40).optional(),
  castingTime: z.string().max(40).optional(),
  range: z.string().max(40).optional(),
  components: z.string().max(40).optional(),
  duration: z.string().max(40).optional(),
  notes: z.string().max(200).optional(),
});
export type Spell = z.infer<typeof Spell>;

/**
 * The character's level: the sum of their class levels. Single-class is the
 * one-element case, not a special case.
 */
export function characterLevel(classes: readonly CharacterClass[]): number {
  return classes.reduce((total, entry) => total + entry.level, 0);
}

/** "Fighter 3", "Artificer 5 / Wizard 2" — always carries the levels, so it reads alone. */
export function classLine(classes: readonly CharacterClass[]): string {
  return classes.map((entry) => `${entry.name} ${entry.level}`).join(' / ');
}

/**
 * `strict()` is the point of D-3: an import carrying `passivePerception` or a
 * homebrew field is rejected outright rather than silently ignored, so a player
 * cannot smuggle a derived value past the server.
 */
export const CharacterSheet = z
  .object({
    classes: z.array(CharacterClass).min(1).max(MAX_LEVEL),
    /**
     * Flavour the DM narrates with. Short scalars only, deliberately: the long
     * prose a sheet also carries (features, actions, languages) is player-editable
     * text that would land unwrapped in the state layer, so it stays out (M4.7).
     */
    race: z.string().max(40).optional(),
    background: z.string().max(60).optional(),
    /** "5d8 + 2d6". A record of what the character has, not a rollable expression. */
    hitDice: z.string().max(40).optional(),
    senses: z.string().max(80).optional(),
    abilityScores: AbilityScores,
    skillProficiencies: z.array(z.enum(SKILL_IDS as [Skill, ...Skill[]])).default([]),
    saveProficiencies: z.array(z.enum(ABILITIES)).default([]),
    maxHp: z.int().min(1).max(999),
    currentHp: z.int().min(0).max(999).optional(),
    armorClass: z.int().min(1).max(40),
    speed: z.int().min(0).max(200).default(30),
    inventory: z.array(InventoryItem).max(200).default([]),
    currency: Currency.default({ cp: 0, sp: 0, gp: 0, pp: 0 }),
    attacks: z.array(Attack).max(40).default([]),
    spells: z.array(Spell).max(400).default([]),
  })
  .strict()
  .refine((sheet) => characterLevel(sheet.classes) <= MAX_LEVEL, {
    message: `total level across all classes must not exceed ${MAX_LEVEL}`,
    path: ['classes'],
  });
export type CharacterSheet = z.infer<typeof CharacterSheet>;

/**
 * Turns a stored `characters.sheet` row into a `CharacterSheet` (M4.7).
 *
 * Every read path used to cast — `row.sheet as CharacterSheet` — which asserts a
 * shape nobody checked. This parses instead, so a corrupt row fails here naming
 * the field rather than throwing from inside `deriveSheet`, and it reshapes the
 * one legacy layout that predates `classes[]`.
 *
 * It is also the migration. The orchestrator's HP and inventory writes round-trip
 * through this, so a row in the old shape is rewritten in the new one the first
 * time it is touched — no data migration and no one-shot script.
 *
 * ponytail: delete the legacy branch once no row has a `className` key —
 *   select count(*) from characters where sheet ? 'className';
 */
export function parseStoredSheet(raw: unknown): CharacterSheet {
  if (raw !== null && typeof raw === 'object' && 'className' in raw && !('classes' in raw)) {
    const { className, level, ...rest } = raw as Record<string, unknown>;
    return CharacterSheet.parse({
      ...rest,
      classes: [{ name: className, level: level ?? MIN_LEVEL }],
    });
  }
  return CharacterSheet.parse(raw);
}

export type DerivedSheet = {
  /** Derived from `classes`, never stored — the same rule as every modifier below. */
  level: number;
  /** "Artificer 5 / Wizard 2". Display only; `classes` stays the truth. */
  className: string;
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
  const level = characterLevel(sheet.classes);
  const bonus = proficiencyBonus(level);

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
    level,
    className: classLine(sheet.classes),
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

/**
 * The campaign is a route parameter, not a body field: that is the only place
 * `CampaignMemberGuard` can see it, and a body that could name a different
 * campaign than the route would be an authorization hole waiting to happen.
 */
export const ImportCharacterRequest = z.object({
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
