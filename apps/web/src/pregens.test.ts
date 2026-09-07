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
const dir = join(import.meta.dirname, '../../../fixtures/pregens');
const files = readdirSync(dir).filter((name) => name.endsWith('.json'));

describe('the pregens the lobby offers', () => {
  it('is every fixture on disk, and not an empty glob', () => {
    expect(PREGENS).toHaveLength(files.length);
    // The six M4.2 shipped. A floor rather than an equality would let the
    // directory lose fixtures with the chooser silently offering fewer seats.
    expect(files).toHaveLength(6);
  });

  /**
   * Read from disk and parsed here, then compared. Re-parsing `PREGENS` would
   * assert nothing `pregens.ts` did not already assert at module scope — swap
   * its `.parse` for a cast and that version stays green. This pins the whole
   * path: the bytes on disk, through the schema, to what the chooser lists.
   */
  it('is those files, parsed through the schema the API accepts', () => {
    const fromDisk = files
      .map((file) =>
        ImportCharacterRequest.parse(JSON.parse(readFileSync(join(dir, file), 'utf8'))),
      )
      .sort(byName);

    expect(PREGENS).toEqual(fromDisk);
    for (const pregen of PREGENS) expect(pregen.name.length).toBeGreaterThan(0);
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

  /**
   * The same technique for the same reason: no assertion over `PREGENS` can
   * tell a `.parse` from a cast. Zod strips nothing from these six, so parsed
   * output is structurally identical to the JSON on disk — swapping the parse
   * for a cast was measured and left every value assertion green. The
   * difference only appears for a fixture that *fails* the schema, which AC-8
   * guarantees cannot exist. So the claim is about what the module does, not
   * about a value it produces, and a source scan is what can hold it.
   */
  it('validates the fixtures rather than casting them', () => {
    const source = readFileSync(join(import.meta.dirname, 'pregens.ts'), 'utf8');
    expect(source).toContain('ImportCharacterRequest.parse');
  });
});
