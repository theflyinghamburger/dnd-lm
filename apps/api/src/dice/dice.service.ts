import { randomInt } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { DiceExpression, RollModifier } from '@dnd-lm/contracts';

export type RolledDice = {
  /** Every die rolled, including both d20s under advantage (FR-301). */
  dice: number[];
  /** Which die actually counted; equals `dice` unless advantage applied. */
  kept: number;
  total: number;
};

/**
 * The only source of randomness in the system (FR-301, invariant 3).
 *
 * `crypto.randomInt` is a CSPRNG with rejection sampling, so the distribution
 * is uniform rather than skewed by a modulo — and each process seeds from the
 * OS, so two API instances cannot produce a correlated stream the way
 * `Math.random` would.
 */
@Injectable()
export class DiceService {
  roll(expression: DiceExpression, modifiers: RollModifier[]): RolledDice {
    const dice: number[] = [];
    const rolls = expression.advantage === 'none' ? expression.count : 2;
    for (let i = 0; i < rolls; i += 1) dice.push(randomInt(1, expression.sides + 1));

    const kept =
      expression.advantage === 'adv'
        ? Math.max(...dice)
        : expression.advantage === 'dis'
          ? Math.min(...dice)
          : dice.reduce((sum, die) => sum + die, 0);

    const bonus = modifiers.reduce((sum, modifier) => sum + modifier.value, 0);
    return { dice, kept, total: kept + bonus };
  }
}
