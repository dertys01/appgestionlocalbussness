import { test, expect } from '@playwright/test';

/**
 * Fumée E2E sur les pages publiques — sans backend.
 *
 * Ce que ces tests protègent : qu'un déploiement ne parte pas avec une page
 * blanche, une erreur de build, ou un formulaire de connexion cassé. C'est le
 * filet minimal qui manquait en CI : les tests Vitest rendent les composants en
 * jsdom, jamais l'application entière servie par Next.
 */

test('la page d’accueil publique se rend', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('La caisse qui suit vos ventes');
});

test('la page tarifs présente les trois formules', async ({ page }) => {
  await page.goto('/tarifs');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Un plan pour chaque étape');
  await expect(page.getByRole('heading', { name: 'Gratuit' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Starter' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Pro' })).toBeVisible();
});

test('la page de connexion expose le formulaire', async ({ page }) => {
  await page.goto('/connexion');
  await expect(page.locator('#login-email')).toBeVisible();
  await expect(page.locator('#login-mdp')).toBeVisible();
  // Scopé au formulaire : un onglet « Se connecter » porte le même libellé.
  await expect(page.locator('form').getByRole('button', { name: 'Se connecter' })).toBeVisible();
});

test('la page d’inscription expose le formulaire', async ({ page }) => {
  await page.goto('/register');
  await expect(page.locator('#reg-boutique')).toBeVisible();
  await expect(page.locator('#reg-email')).toBeVisible();
});
