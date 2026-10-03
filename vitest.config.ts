import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Tests de composant React (Sprint 5.5).
 *
 * Ils complètent `tests/*.test.mts` — qui vérifient les fonctions pures — en
 * rendant réellement les composants dans jsdom. `include` est volontairement
 * restreint à `tests/ui` : les suites `node --test` existantes ne doivent pas
 * être récupérées par Vitest.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/ui/setup.ts'],
    include: ['tests/ui/**/*.test.{ts,tsx}'],
    css: false,
  },
});
