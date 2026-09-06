import { ImportCharacterRequest } from '@dnd-lm/contracts';

/**
 * The six shipped pregens (M4.2, D-3), read from `fixtures/pregens/` itself.
 *
 * One copy: `apps/api/test/pregens.test.ts` asserts every file in that
 * directory imports and derives cleanly, and this is the same directory, so a
 * sheet the API vouches for is the sheet the lobby offers. A copy under
 * `apps/web` would be a second source of truth with nothing keeping the two in
 * step; a `GET /api/pregens` would be an endpoint for six static files.
 *
 * The path is three levels up — this module sits in `apps/web/src`. An
 * `import.meta.glob` that matches nothing is not an error in vite; it compiles
 * to an empty object and the build passes, which is why `pregens.test.ts`
 * asserts the count against the directory rather than trusting the glob.
 */
const modules = import.meta.glob('../../../fixtures/pregens/*.json', { eager: true }) as Record<
  string,
  { default: unknown }
>;

/**
 * Parsed with the schema the server's own pipe uses, not cast: a typo in a
 * fixture should fail here, in one place, rather than as a crash in the lobby.
 * This is not a second validation policy — the import is re-validated
 * server-side, and that answer is the one the UI shows on rejection.
 */
/** Exported so the test orders by the same rule the UI does, not by `Array.sort`'s. */
export const byName = (a: ImportCharacterRequest, b: ImportCharacterRequest): number =>
  a.name.localeCompare(b.name);

export const PREGENS: ImportCharacterRequest[] = Object.values(modules)
  .map((module) => ImportCharacterRequest.parse(module.default))
  .sort(byName);
