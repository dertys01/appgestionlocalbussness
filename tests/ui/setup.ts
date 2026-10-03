import '@testing-library/jest-dom/vitest';

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
