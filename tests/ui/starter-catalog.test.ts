import { describe, expect, it } from 'vitest';

import {
  DEMO_PREFIX,
  isDemoSku,
  starterCatalog,
  starterCategories,
  starterCount,
  starterPlats,
  starterSku,
  fieldExamples,
} from '@/lib/starterCatalog';

/**
 * Catalogue d'exemple — le premier écran d'une application parle le métier de
 * celui qui le lit.
 *
 * Un maquis qui se voit proposer « Samsung Galaxy A15 » comprend que le logiciel
 * n'est pas pour lui, et il n'ira pas plus loin. Ces tests verrouillent deux
 * choses : aucun article ne mentionne de téléphone, et les recettes sont réelles
 * (un ingrédient cité existe dans le même catalogue — sans quoi l'onglet
 * Recettes se charge à vide et le module paraît mort).
 */

describe('Catalogue d\'exemple — restauration', () => {
  const cat = starterCatalog('restaurant');

  it('ne contient aucun article de téléphonie', () => {
    const texte = JSON.stringify(cat).toLowerCase();
    for (const mot of ['samsung', 'iphone', 'smartphone', 'telephone', 'téléphone', 'galaxy', 'laptop']) {
      expect(texte, `le catalogue restaurant ne doit pas parler de ${mot}`).not.toContain(mot);
    }
  });

  it('ne contient aucun article de téléphonie non plus pour le commerce', () => {
    const texte = JSON.stringify(starterCatalog('retail')).toLowerCase();
    for (const mot of ['samsung', 'iphone', 'smartphone', 'telephone', 'galaxy']) {
      expect(texte).not.toContain(mot);
    }
  });

  it('décrit des plats et leurs ingrédients, pas des produits en vrac', () => {
    const categories = starterCategories('restaurant');
    expect(categories).toContain('Plats');
    expect(categories).toContain('Ingrédients');
    expect(starterPlats('restaurant').length).toBeGreaterThanOrEqual(4);
  });

  it('chaque recette ne cite que des ingrédients du catalogue', () => {
    const noms = new Set(cat.map((a) => a.name));
    for (const plat of starterPlats('restaurant')) {
      for (const ing of plat.recipe ?? []) {
        expect(noms, `${plat.name} cite ${ing.ingredient}, absent du catalogue`).toContain(
          ing.ingredient
        );
      }
    }
  });

  it('un plat a un prix de vente et pas de prix d\'achat', () => {
    for (const plat of starterPlats('restaurant')) {
      expect(plat.priceSell).toBeGreaterThan(0);
      // Le prix d'achat d'un plat, c'est sa RECETTE : le saisir en plus
      // donnerait deux coûts de matière concurrents, et la marge à deux têtes.
      expect(plat.priceBuy).toBe(0);
    }
  });

  it('les ingrédients ont un prix d\'achat, sans quoi la marge vaut toujours 100 %', () => {
    for (const ing of cat.filter((a) => !a.recipe)) {
      expect(ing.priceBuy, `${ing.name} n'a pas de prix d'achat`).toBeGreaterThan(0);
      expect(ing.priceSell).toBeGreaterThan(ing.priceBuy);
    }
  });

  it('les quantités de recette sont positives et cohérentes', () => {
    for (const plat of starterPlats('restaurant')) {
      for (const ing of plat.recipe ?? []) {
        expect(ing.quantity).toBeGreaterThan(0);
        // Un kilo de riz dans une portion de riz gras : c'est le genre
        // d'erreur qu'un catalogue d'exemple ne doit pas donner en exemple.
        expect(ing.quantity).toBeLessThanOrEqual(1);
      }
    }
  });

  it('tient dans le quota du plan gratuit', () => {
    // check_product_limit() refuse la 31e ligne en plan gratuit : un catalogue
    // d'exemple plus long que le quota rendrait l'assistant inutilisable.
    expect(starterCount('restaurant')).toBeLessThanOrEqual(30);
    expect(starterCount('retail')).toBeLessThanOrEqual(30);
  });

  it('les deux domaines ont des catalogues différents', () => {
    const commerce = starterCatalog('retail').map((a) => a.name);
    const resto = starterCatalog('restaurant').map((a) => a.name);
    expect(commerce).not.toEqual(resto);
  });

  it('un domaine inconnu retombe sur le commerce, comme le reste de l\'application', () => {
    expect(starterCatalog(undefined)).toEqual(starterCatalog('retail'));
    expect(starterCatalog('bricolage')).toEqual(starterCatalog('retail'));
  });
});

describe('Catalogue d\'exemple — repérage', () => {
  it('tous les articles reçoivent un SKU d\'exemple', () => {
    const skus = starterCatalog('restaurant').map((_, i) => starterSku(i));
    expect(skus.every((s) => s.startsWith(DEMO_PREFIX))).toBe(true);
    // Un SKU dupliqué ferait compter deux fois la bannière de retrait.
    expect(new Set(skus).size).toBe(skus.length);
  });

  it('reconnaît un SKU d\'exemple, quelle que soit la casse', () => {
    expect(isDemoSku('DEMO-01')).toBe(true);
    expect(isDemoSku('demo-01')).toBe(true);
    expect(isDemoSku('RIZ-25')).toBe(false);
    expect(isDemoSku('')).toBe(false);
    expect(isDemoSku(null)).toBe(false);
    expect(isDemoSku(undefined)).toBe(false);
  });

  it('les exemples des champs de saisie suivent le domaine', () => {
    const commerce = fieldExamples('retail');
    const resto = fieldExamples('restaurant');
    expect(resto.product).not.toBe(commerce.product);
    expect(resto.category.toLowerCase()).toContain('plat');
    expect(commerce.category.toLowerCase()).toContain('épicerie');
    // Le texte lui-même ne doit rien laisser supposer d'un métier unique.
    for (const e of [commerce, resto]) {
      const t = JSON.stringify(e).toLowerCase();
      expect(t).not.toContain('samsung');
      expect(t).not.toContain('iphone');
    }
  });
});