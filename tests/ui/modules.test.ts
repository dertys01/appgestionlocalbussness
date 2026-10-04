import { describe, expect, it } from 'vitest';

import {
  DOMAIN_MODULES,
  normalizeDomain,
  getEnabledModules,
  isModuleEnabled,
  fallbackTab,
  type Domain,
} from '@/lib/modules';

/**
 * Le domaine d'activité décide des modules rendus. Ces tests verrouillent la
 * propriété qui compte : un restaurant ne doit jamais voir un module du
 * commerce, et l'inverse non plus. Ils sont volontairement côté fonction pure
 * — la navigation est filtrée par exactement cette liste.
 */
describe('domaines d\'activité', () => {
  it('normalise une valeur inconnue vers le commerce', () => {
    expect(normalizeDomain('restaurant')).toBe('restaurant');
    expect(normalizeDomain('retail')).toBe('retail');
    // Colonne absente avant la migration, valeur exotique, null : le commerce
    // est le seul choix qui ne casse rien.
    expect(normalizeDomain(undefined)).toBe('retail');
    expect(normalizeDomain(null)).toBe('retail');
    expect(normalizeDomain('grossiste')).toBe('retail');
  });

  it('donne un repli qui existe toujours', () => {
    for (const d of Object.keys(DOMAIN_MODULES) as Domain[]) {
      expect(DOMAIN_MODULES[d].length).toBeGreaterThan(0);
      expect(getEnabledModules(d)).toContain(fallbackTab(d));
    }
  });

  it('partage les modules communs aux deux domaines', () => {
    for (const t of ['dashboard', 'pos', 'inventory', 'sales', 'team'] as const) {
      expect(isModuleEnabled('retail', t)).toBe(true);
      expect(isModuleEnabled('restaurant', t)).toBe(true);
    }
  });

  it('les réglages appartiennent aux deux domaines', () => {
    // La garde de page.tsx renvoie sur l'Accueil tout onglet absent de la
    // liste du domaine. Sans `settings` ici, le bouton Paramètres changeait
    // l'onglet puis était annoncé dans la même passe de rendu : l'écran des
    // réglages — et la bascule de domaine qui s'y trouve — étaient
    // inatteignables. Trouvé en recette navigateur le 04/10/2026.
    expect(isModuleEnabled('retail', 'settings')).toBe(true);
    expect(isModuleEnabled('restaurant', 'settings')).toBe(true);
    for (const d of ['retail', 'restaurant'] as const) {
      expect(getEnabledModules(d)).toContain('settings');
    }
  });

  it('le repli n\'est jamais les réglages', () => {
    // Si `settings` devenait le premier module de la liste, un onglet hors
    // domaine ouvrirait les réglages au lieu de l'accueil.
    for (const d of ['retail', 'restaurant'] as const) {
      expect(fallbackTab(d)).toBe('dashboard');
    }
  });

  it('n\'a aucun module propre au commerce en restaurant', () => {
    // forecast est le seul module propre au commerce aujourd'hui ; il ne doit
    // jamais apparaître en restaurant.
    expect(isModuleEnabled('retail', 'forecast')).toBe(true);
    expect(isModuleEnabled('restaurant', 'forecast')).toBe(false);
    expect(getEnabledModules('restaurant')).not.toContain('forecast');
  });

  it('ne renvoie jamais le tableau interne (mutabilité)', () => {
    // Le tableau renvoyé doit être une copie : un appelant qui le pousse dans
    // un cache ou le concatène ne doit pas réécrire la définition des modules.
    const a = getEnabledModules('restaurant');
    a.push('forecast');
    expect(getEnabledModules('restaurant')).not.toContain('forecast');
    expect(DOMAIN_MODULES.restaurant).not.toContain('forecast');
  });

  it('exclut tout onglet hors domaine', () => {
    const modules = getEnabledModules('restaurant');
    const tous: string[] = ['dashboard', 'pos', 'inventory', 'sales', 'debts', 'reports', 'forecast', 'team'];
    for (const t of tous) {
      expect(modules.includes(t as never)).toBe(isModuleEnabled('restaurant', t as never));
    }
  });
});