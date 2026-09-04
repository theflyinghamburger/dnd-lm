import {
  type DerivedSheet,
  type RollModifier,
  ABILITIES,
  ABILITY_NAMES,
  type Ability,
  SKILLS,
  SKILL_IDS,
  SKILL_NAMES,
  type Skill,
  type DiceExpression,
  parseDiceExpression,
} from '@dnd-lm/contracts';

export type ResolvedRoll =
  | { ok: true; expression: DiceExpression; label: string; modifiers: RollModifier[] }
  | { ok: false; error: string };

const normalize = (raw: string): string =>
  raw
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');

const skillFor = (token: string): Skill | undefined =>
  SKILL_IDS.find((skill) => skill === token || normalize(SKILL_NAMES[skill]) === token);

const abilityFor = (token: string): Ability | undefined =>
  ABILITIES.find((ability) => ability === token || normalize(ABILITY_NAMES[ability]) === token);

const d20 = (advantage: DiceExpression['advantage']): DiceExpression => ({
  count: 1,
  sides: 20,
  modifier: 0,
  advantage,
});

/**
 * Turns what a player typed into dice plus provenance (FR-302, FR-303).
 *
 * A named roll resolves against the character's *current* derived sheet, so a
 * modifier can never be stale or supplied by the client. A raw expression's
 * `+K` is recorded with a source too — every number in the total has to be
 * attributable, including a flat bonus a player asked for.
 */
export function resolveRollRequest(raw: string, derived: DerivedSheet | null): ResolvedRoll {
  const text = raw.trim();
  if (text.length === 0) return { ok: false, error: 'Roll what? Try "1d20" or "perception".' };

  // Advantage may be appended to a named roll as well: "perception adv".
  const advantageMatch = /\s+(adv|dis)$/i.exec(text);
  const advantage = (advantageMatch?.[1]?.toLowerCase() as 'adv' | 'dis' | undefined) ?? 'none';
  const bare = advantageMatch ? text.slice(0, advantageMatch.index) : text;
  const token = normalize(bare);

  const skill = skillFor(token);
  if (skill) {
    if (!derived) return { ok: false, error: 'Pick a character before rolling a skill.' };
    const ability = SKILLS[skill];
    const abilityBonus = derived.abilityModifiers[ability];
    const total = derived.skillModifiers[skill];

    const modifiers: RollModifier[] = [{ source: ABILITY_NAMES[ability], value: abilityBonus }];
    if (total !== abilityBonus) {
      modifiers.push({ source: 'Proficiency', value: total - abilityBonus });
    }
    return { ok: true, expression: d20(advantage), label: SKILL_NAMES[skill], modifiers };
  }

  const saveMatch = /^(?:(\w+)_save|save_(\w+))$/.exec(token);
  const saveAbility = abilityFor(saveMatch?.[1] ?? saveMatch?.[2] ?? '');
  if (saveAbility) {
    if (!derived) return { ok: false, error: 'Pick a character before rolling a save.' };
    const abilityBonus = derived.abilityModifiers[saveAbility];
    const total = derived.saveModifiers[saveAbility];

    const modifiers: RollModifier[] = [{ source: ABILITY_NAMES[saveAbility], value: abilityBonus }];
    if (total !== abilityBonus) {
      modifiers.push({ source: 'Proficiency', value: total - abilityBonus });
    }
    return {
      ok: true,
      expression: d20(advantage),
      label: `${ABILITY_NAMES[saveAbility]} save`,
      modifiers,
    };
  }

  const parsed = parseDiceExpression(text);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  return {
    ok: true,
    expression: parsed.expression,
    label: text,
    modifiers:
      parsed.expression.modifier === 0
        ? []
        : [{ source: 'Expression', value: parsed.expression.modifier }],
  };
}
