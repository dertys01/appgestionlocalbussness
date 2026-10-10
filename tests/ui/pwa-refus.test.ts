import { describe, it, expect, afterEach } from 'vitest';

/**
 * Mémorisation du refus d'installer l'application.
 *
 * Le point important : si `localStorage` est indisponible (navigation privée,
 * stockage plein) ou que ses méthodes lèvent, RIEN ne doit planter — au pire
 * le refus n'est pas retenu.
 *
 * jsdom n'implémente pas `localStorage` : on le simule.
 */

import { lireRefus, marquerRefus, reinitialiserRefus } from '@/lib/pwa/refus';

function storageQuiMarche() {
  const store = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    },
  });
}
const sansStorage = () =>
  Object.defineProperty(window, 'localStorage', { configurable: true, value: undefined });
const storageQuiEchoue = () =>
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem() { throw new Error('privé'); },
      setItem() { throw new Error('plein'); },
      removeItem() { throw new Error('privé'); },
    },
  });

afterEach(() => { sansStorage(); });

describe('pwa/refus', () => {
  it('retient le refus', () => {
    storageQuiMarche();
    expect(lireRefus()).toBe(false);
    marquerRefus();
    expect(lireRefus()).toBe(true);
    reinitialiserRefus();
    expect(lireRefus()).toBe(false);
  });

  it('sans localStorage : ne plante pas, refus non retenu', () => {
    sansStorage();
    expect(() => marquerRefus()).not.toThrow();
    expect(lireRefus()).toBe(false);
    expect(() => reinitialiserRefus()).not.toThrow();
  });

  it('localStorage qui lève : ne plante pas', () => {
    storageQuiEchoue();
    expect(() => marquerRefus()).not.toThrow();
    expect(lireRefus()).toBe(false);
    expect(() => reinitialiserRefus()).not.toThrow();
  });
});
