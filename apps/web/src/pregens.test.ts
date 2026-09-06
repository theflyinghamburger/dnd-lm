import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ImportCharacterRequest } from '@dnd-lm/contracts';
import { PREGENS, byName } from './pregens';

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
    // The six M4.2 shipped. A floor rather than an equality would let the
    // directory lose fixtures with the chooser silently offering fewer seats.
    expect(files).toHaveLength(6);
  });

  it('parses each one as the request body the API accepts', () => {
    for (const pregen of PREGENS) {
      expect(() => ImportCharacterRequest.parse(pregen)).not.toThrow();
      expect(pregen.name.length).toBeGreaterThan(0);
    }
  });

  it('offers them in a stable order, by the comparator the UI uses', () => {
    expect(PREGENS).toEqual([...PREGENS].sort(byName));
  });
});

/**
 * `pregens.ts` is the web app's first *value* import from `@dnd-lm/contracts`;
 * everything else is `import type`. Contracts builds to CommonJS, and vite's
 * dev server does not pre-bundle a linked workspace package — so without the
 * `optimizeDeps` entry the named export is not found and the whole app fails to
 * load. `vite build` and vitest both resolve it fine, which is why nothing else
 * here can see the breakage. A source scan is the only check that can.
 */
describe('the dev server can resolve a value import from contracts', () => {
  it('pre-bundles @dnd-lm/contracts', () => {
    const config = readFileSync(join(import.meta.dirname, '../vite.config.ts'), 'utf8');
    expect(config).toMatch(/optimizeDeps:\s*{\s*include:\s*\[[^\]]*'@dnd-lm\/contracts'/);
  });
});
