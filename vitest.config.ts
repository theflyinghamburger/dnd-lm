import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Tests read contracts from source so `pnpm test` needs no build step.
  resolve: {
    alias: { '@dnd-lm/contracts': resolve(import.meta.dirname, 'packages/contracts/src/index.ts') },
  },
  test: {
    include: ['{apps,packages}/*/src/**/*.test.ts'],
  },
});
