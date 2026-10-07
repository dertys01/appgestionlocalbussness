import { describe, expect, it } from 'vitest';

import {
  DOMAIN_MODULES,
  normalizeDomain,
  getEnabledModules,
  isModuleEnabled,
  fallbackTab,
  normalizeUiMode,
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
/**
 * Mode simple (Sprint 18) : un nouveau compte ne voit que Caisse, Produits,
 * Dettes, Ventes du jour et Accueil — plus les réglages, où se trouve le
 * retour au mode complet.
 */
describe('mode simple', () => {
  it('ne garde que l\'essentiel en commerce', () => {
    expect(getEnabledModules('retail', 'beginner')).toEqual(
      ['dashboard', 'pos', 'inventory', 'sales', 'debts', 'settings']
    );
  });

  it('garde la Salle d\'un maquis, pas ses Recettes', () => {
    const m = getEnabledModules('restaurant', 'beginner');
    expect(m).toContain('floor');
    expect(m).not.toContain('recipes');
    expect(m).not.toContain('reports');
    expect(m).not.toContain('team');
  });

  it('un mode inconnu ou absent vaut le mode complet', () => {
    // Une boutique en service avant la migration n'a pas la colonne : elle ne
    // doit pas perdre ses Rapports le jour du déploiement.
    for (const raw of [undefined, null, '', 'expert']) {
      expect(normalizeUiMode(raw)).toBe('full');
      expect(getEnabledModules('retail', raw)).toEqual(getEnabledModules('retail'));
    }
  });

  it('le repli reste l\'accueil, et les réglages restent atteignables', () => {
    for (const d of ['retail', 'restaurant'] as const) {
      expect(fallbackTab(d, 'beginner')).toBe('dashboard');
      expect(isModuleEnabled(d, 'settings', 'beginner')).toBe(true);
      expect(isModuleEnabled(d, 'reports', 'beginner')).toBe(false);
    }
  });
});
