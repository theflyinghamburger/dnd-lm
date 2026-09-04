import { describe, expect, it } from 'vitest';
import { formatExpression, parseDiceExpression } from './dice';

const parse = (raw: string) => {
  const result = parseDiceExpression(raw);
  if (!result.ok) throw new Error(result.error);
  return result.expression;
};

describe('parseDiceExpression — the MVP grammar', () => {
  it.each([
    ['1d20', { count: 1, sides: 20, modifier: 0, advantage: 'none' }],
    ['2d6', { count: 2, sides: 6, modifier: 0, advantage: 'none' }],
    ['1d20+5', { count: 1, sides: 20, modifier: 5, advantage: 'none' }],
    ['3d8-2', { count: 3, sides: 8, modifier: -2, advantage: 'none' }],
    ['1d20 + 7', { count: 1, sides: 20, modifier: 7, advantage: 'none' }],
    ['1d20+5 adv', { count: 1, sides: 20, modifier: 5, advantage: 'adv' }],
    ['1D20 DIS', { count: 1, sides: 20, modifier: 0, advantage: 'dis' }],
    ['1d100', { count: 1, sides: 100, modifier: 0, advantage: 'none' }],
  ])('%s parses', (raw, expected) => {
    expect(parse(raw)).toEqual(expected);
  });

  it.each([
    ['2d6+1d4', 'two dice terms'],
    ['(1d20+5)*2', 'arithmetic'],
    ['4d6kh3', 'keep-highest'],
    ['1d7', 'a die this game does not use'],
    ['d20', 'an implicit count'],
    ['0d20', 'zero dice'],
    ['200d6', 'more dice than the cap'],
    ['1d20 advantage', 'a long-form keyword'],
    ['', 'nothing at all'],
    ['perception', 'a skill name'],
  ])('refuses %s (%s) rather than growing a language', (raw) => {
    expect(parseDiceExpression(raw).ok).toBe(false);
  });

  it('refuses advantage on anything but a single d20', () => {
    expect(parseDiceExpression('2d20 adv').ok).toBe(false);
    expect(parseDiceExpression('3d6 dis').ok).toBe(false);
  });

  it('always explains the refusal', () => {
    const result = parseDiceExpression('4d6kh3');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.length).toBeGreaterThan(10);
  });

  it('round-trips through formatExpression', () => {
    for (const raw of ['1d20', '2d6+3', '3d8-2', '1d20+5 adv']) {
      expect(parse(formatExpression(parse(raw)))).toEqual(parse(raw));
    }
  });
});
