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
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html', 'lcov'],
      // La couverture ne porte que sur le code applicatif : scripts d'outillage,
      // qa/, configs et fichiers générés ne sont pas « testés », les inclure
      // rendrait le chiffre absurde et le seuil impossible à défendre.
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.d.ts',
        'src/app/**/layout.tsx',
        'src/app/manifest.ts',
        'src/instrumentation.ts',
        'src/instrumentation-client.ts',
        'src/types/**',
      ],
      // Plancher mesuré au moment de la mise en place (45.8 % lignes / 74.9 %
      // branches / 58.7 % fonctions), posé un peu en dessous. Il n'augmente
      // pas la couverture : il empêche qu'elle RECULE sans qu'on le voie.
      thresholds: {
        lines: 44,
        statements: 44,
        functions: 55,
        branches: 70,
      },
    },
    // Budget de 15 s par test : les cas limites (POS de 43 produits, rendus
    // multiples sous load) dépassaient les 5 s par défaut alors que chaque
    // assertion, elle, a son propre waitFor (1 s) et passait. Le test lent
    // n'est pas le test faux — mais un test qui rate sur l'horloge plutôt que
    // sur l'assertion ne dit rien, et force à relancer pour rien.
    testTimeout: 15000,
  },
});
