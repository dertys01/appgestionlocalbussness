import { defineConfig, devices } from '@playwright/test';

/**
 * E2E Playwright — fumée sur les pages publiques.
 *
 * Volontairement limité à ce qui se teste SANS backend : la landing, /tarifs,
 * /connexion, /register. Ces pages se rendent sans session ni base, donc la
 * suite tourne en CI avec un build « leurre » (URL/clé factices). Les parcours
 * authentifiés (caisse, dettes…) exigent un vrai projet Supabase et des comptes
 * de test : ils restent dans qa/*.mjs, lancés à la main.
 *
 * Le serveur est démarré par Playwright sur un port dédié, avec le build déjà
 * produit (`next start`).
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: 'http://localhost:3100',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'npm run start -- -p 3100',
    url: 'http://localhost:3100',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
