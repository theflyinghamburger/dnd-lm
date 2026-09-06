import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ImportCharacterRequest } from '@dnd-lm/contracts';
import { PREGENS } from './pregens';

/**
 * #61: the lobby's chooser reads `fixtures/pregens/` directly. The risk the
 * glob carries is silence — a wrong pattern matches nothing, compiles to an
 * empty object, and builds green. So this asserts against the directory on
 * disk, which is also what `apps/api/test/pregens.test.ts` reads.
 */
const dir = join(process.cwd(), 'fixtures/pregens');
const files = readdirSync(dir).filter((name) => name.endsWith('.json'));

describe('the pregens the lobby offers', () => {
  it('is every fixture on disk, and not an empty glob', () => {
    expect(PREGENS).toHaveLength(files.length);
    expect(files.length).toBeGreaterThanOrEqual(4);
  });

  it('parses each one as the request body the API accepts', () => {
    for (const pregen of PREGENS) {
      expect(() => ImportCharacterRequest.parse(pregen)).not.toThrow();
      expect(pregen.name.length).toBeGreaterThan(0);
    }
  });

  it('offers them in a stable order, by name', () => {
    expect(PREGENS.map((p) => p.name)).toEqual([...PREGENS.map((p) => p.name)].sort());
  });
});
