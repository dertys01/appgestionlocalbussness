import '@testing-library/jest-dom/vitest';
import { FORMULES_TEST } from './formules.fixture';

/**
 * Configuration des formules pour les tests.
 *
 * Les prix et quotas viennent de `NEXT_PUBLIC_PLANS_CONFIG` — jamais du code
 * (dépôt public). Les tests ont donc leurs propres valeurs, posées AVANT que
 * `src/lib/utils/plans.ts` ne soit importé par un test : elles sont
 * volontairement quelconques (et non celles de l'offre réelle) pour qu'un
 * test qui passerait ici ne devine jamais la stratégie tarifaire.
 *
 * Un test qui veut vérifier un plafond lit `PLAN_LIMITS` — il ne répète pas
 * le nombre dans son assertion.
 */
process.env.NEXT_PUBLIC_PLANS_CONFIG = JSON.stringify(FORMULES_TEST);

/**
 * Environnement Supabase minimal : plusieurs modules serveur (routes API,
 * user-client) appellent `requireEnv('NEXT_PUBLIC_SUPABASE_URL')` au chargement.
 * Sans ces valeurs, importer une route API lèverait dans les tests. Les vraies
 * valeurs n'ont pas d'importance : `@supabase/supabase-js` est mocké dans les
 * tests de route, aucune requête réseau n'est faite.
 */
process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://test.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'test-anon-key';

/**
 * jsdom n'implémente pas `matchMedia`. Un composant qui s'en sert pour
 * distinguer le mobile du grand écran ne se retrouvait donc jamais dans sa
 * configuration mobile : ses tests ne validaient rien de ce chemin.
 *
 * Le défaut est un grand écran (1440 px), l'écran de référence de la recette.
 * Pour tester le mobile, réaffectez `window.matchMedia` avec `matchMediaPour`
 * — le restaureur est fourni pour ne rien laisser fuir d'un test à l'autre.
 */
export function matchMediaPour(largeur: number) {
  return (query: string) => ({
    matches: query.includes('1024') ? largeur >= 1024 : largeur >= 768,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  });
}

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  configurable: true,
  value: matchMediaPour(1440),
});
