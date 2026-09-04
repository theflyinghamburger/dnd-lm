/**
 * The MVP dice grammar (M4.4): `NdM`, an optional `+K` or `-K`, and an optional
 * `adv` / `dis`. Nothing else.
 *
 * Parsing is here so the composer can reject a bad expression before send.
 * Rolling is *not* — this package has no access to a CSPRNG and no business
 * having one. Every die is rolled server-side (FR-301), which is a property of
 * where the code lives rather than a rule someone has to remember.
 */
import { z } from 'zod';

export const MAX_DICE = 100;
export const DIE_SIZES = [2, 3, 4, 6, 8, 10, 12, 20, 100] as const;

export const DiceExpression = z.object({
  count: z.int().min(1).max(MAX_DICE),
  sides: z.union([
    z.literal(2),
    z.literal(3),
    z.literal(4),
    z.literal(6),
    z.literal(8),
    z.literal(10),
    z.literal(12),
    z.literal(20),
    z.literal(100),
  ]),
  modifier: z.int().min(-999).max(999),
  advantage: z.enum(['none', 'adv', 'dis']),
});
export type DiceExpression = z.infer<typeof DiceExpression>;

export type DiceParseResult =
  { ok: true; expression: DiceExpression } | { ok: false; error: string };

const GRAMMAR = /^(\d+)d(\d+)\s*(?:([+-])\s*(\d+))?\s*(adv|dis)?$/i;

/**
 * Rejects anything outside the grammar with a message rather than growing a
 * general expression language — `2d6+1d4`, parentheses and keep-highest are all
 * refusals, on purpose.
 */
export function parseDiceExpression(raw: string): DiceParseResult {
  const text = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  const match = GRAMMAR.exec(text);
  if (!match) {
    return {
      ok: false,
      error: 'Expected something like "1d20", "2d6+3" or "1d20+5 adv".',
    };
  }

  const [, rawCount, rawSides, sign, rawModifier, advantage] = match;
  const count = Number(rawCount);
  const sides = Number(rawSides);

  if (count < 1 || count > MAX_DICE) {
    return { ok: false, error: `Roll between 1 and ${MAX_DICE} dice.` };
  }
  if (!(DIE_SIZES as readonly number[]).includes(sides)) {
    return { ok: false, error: `d${sides} is not a die this game uses.` };
  }

  const magnitude = rawModifier === undefined ? 0 : Number(rawModifier);
  const modifier = sign === '-' ? -magnitude : magnitude;

  // Advantage is a d20 mechanic; on 3d6 it has no meaning and silently
  // dropping it would misreport what was rolled.
  if (advantage && (count !== 1 || sides !== 20)) {
    return { ok: false, error: 'Advantage and disadvantage apply to a single d20 only.' };
  }

  return {
    ok: true,
    expression: {
      count,
      sides: sides as DiceExpression['sides'],
      modifier,
      advantage: (advantage as 'adv' | 'dis' | undefined) ?? 'none',
    },
  };
}

export const formatExpression = (expression: DiceExpression): string => {
  const modifier =
    expression.modifier === 0
      ? ''
      : expression.modifier > 0
        ? `+${expression.modifier}`
        : `${expression.modifier}`;
  const advantage = expression.advantage === 'none' ? '' : ` ${expression.advantage}`;
  return `${expression.count}d${expression.sides}${modifier}${advantage}`;
};
