import { resolve } from 'node:path';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // NestJS dependency injection reads `design:paramtypes`, which esbuild (and so
  // vitest's default transform) does not emit. SWC does.
  plugins: [
    swc.vite({
      jsc: {
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
        target: 'es2022',
      },
      module: { type: 'es6' },
    }),
  ],
  // Tests read contracts from source so `pnpm test` needs no build step.
  resolve: {
    alias: { '@dnd-lm/contracts': resolve(import.meta.dirname, 'packages/contracts/src/index.ts') },
  },
  test: {
    include: ['{apps,packages}/*/src/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    testTimeout: 20_000,
    /**
     * The integration suites share one database and each one TRUNCATEs it in
     * `beforeEach`, so running two files at once has them deleting each other's
     * rows and colliding on `users_email_key`. Serial by file is the fix; the
     * whole suite is a few seconds, so there is nothing to win by parallelising
     * it. Per-file databases would be the alternative, and are not worth it.
     */
    fileParallelism: false,
  },
});
