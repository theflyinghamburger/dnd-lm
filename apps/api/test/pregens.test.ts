import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CharacterSheet, deriveSheet } from '@dnd-lm/contracts';

// vitest runs from the workspace root.
const dir = join(process.cwd(), 'fixtures/pregens');
const files = readdirSync(dir).filter((name) => name.endsWith('.json'));

/** A pregen that does not import is a fixture that fails in the demo (M4.2). */
describe('pregen fixtures', () => {
  it('ships four to six of them', () => {
    expect(files.length).toBeGreaterThanOrEqual(4);
    expect(files.length).toBeLessThanOrEqual(6);
  });

  it.each(files)('%s parses as an importable sheet and derives cleanly', (file) => {
    const body = JSON.parse(readFileSync(join(dir, file), 'utf8')) as {
      name: string;
      sheet: unknown;
    };
    expect(body.name.length).toBeGreaterThan(0);

    const sheet = CharacterSheet.parse(body.sheet);
    const derived = deriveSheet(sheet);
    expect(derived.proficiencyBonus).toBe(2);
    expect(derived.currentHp).toBe(sheet.maxHp);
    expect(derived.passivePerception).toBe(10 + derived.skillModifiers.perception);
  });
});
