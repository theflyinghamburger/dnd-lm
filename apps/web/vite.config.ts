import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  /**
   * `@dnd-lm/contracts` builds to CommonJS (apps/api is a CJS Nest app), and a
   * linked workspace package is not pre-bundled by default. Vite's dev server
   * then serves `dist/index.js` as-is, and `cjs-module-lexer` does not see
   * through its transitive `export *` re-exports: importing a *value* — as
   * `pregens.ts` does with `ImportCharacterRequest` — fails at module
   * evaluation and takes the whole app down. Pre-bundling converts it to ESM
   * with the named exports intact.
   *
   * `vite build` is unaffected (rollup resolves the interop itself), which is
   * why this is invisible to `pnpm build` and to vitest, which aliases
   * contracts to source.
   */
  optimizeDeps: { include: ['@dnd-lm/contracts'] },
  server: {
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
      '/ws': { target: 'http://localhost:3000', ws: true },
    },
  },
});
