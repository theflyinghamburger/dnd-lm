import { parseDiceExpression } from '@dnd-lm/contracts';
import { describe, expect, it } from 'vitest';
import { DiceService } from './dice.service';

const service = new DiceService();
const expr = (raw: string) => {
  const parsed = parseDiceExpression(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.expression;
};

describe('DiceService', () => {
  it('is uniform across 10,000 d20 rolls', () => {
    const counts = new Array(21).fill(0) as number[];
    const trials = 10_000;
    for (let i = 0; i < trials; i += 1) {
      const face = service.roll(expr('1d20'), []).kept;
      counts[face] = (counts[face] ?? 0) + 1;
    }

    expect(counts[0]).toBe(0);
    const expected = trials / 20;
    for (let face = 1; face <= 20; face += 1) {
      // ±25% of expected. A biased generator (a modulo skew, a stuck bit)
      // fails this by a wide margin; fair dice pass it with huge slack.
      expect(counts[face]!).toBeGreaterThan(expected * 0.75);
      expect(counts[face]!).toBeLessThan(expected * 1.25);
      expect(counts[face]).toBeGreaterThan(0);
    }
    expect(counts.reduce((a, b) => a + b, 0)).toBe(trials);
  });

  it('never rolls outside the face range', () => {
    for (let i = 0; i < 2000; i += 1) {
      for (const die of service.roll(expr('3d6'), []).dice) {
        expect(die).toBeGreaterThanOrEqual(1);
        expect(die).toBeLessThanOrEqual(6);
      }
    }
  });

  it('sums multiple dice plus every modifier', () => {
    const result = service.roll(expr('3d6+2'), [
      { source: 'Strength', value: 3 },
      { source: 'Proficiency', value: 2 },
    ]);
    expect(result.dice).toHaveLength(3);
    expect(result.kept).toBe(result.dice.reduce((a, b) => a + b, 0));
    expect(result.total).toBe(result.kept + 5);
  });

  it('rolls both d20s under advantage and keeps the higher', () => {
    for (let i = 0; i < 500; i += 1) {
      const result = service.roll(expr('1d20 adv'), []);
      expect(result.dice).toHaveLength(2);
      expect(result.kept).toBe(Math.max(...result.dice));
      expect(result.total).toBe(result.kept);
    }
  });

  it('rolls both d20s under disadvantage and keeps the lower', () => {
    for (let i = 0; i < 500; i += 1) {
      const result = service.roll(expr('1d20 dis'), []);
      expect(result.dice).toHaveLength(2);
      expect(result.kept).toBe(Math.min(...result.dice));
    }
  });

  it('produces a different stream on every call — no fixed seed anywhere', () => {
    const first = Array.from({ length: 40 }, () => service.roll(expr('1d100'), []).kept);
    const second = Array.from({ length: 40 }, () => service.roll(expr('1d100'), []).kept);
    expect(first).not.toEqual(second);
  });
});
