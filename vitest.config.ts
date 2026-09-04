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
  },
});
