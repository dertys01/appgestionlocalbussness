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
import { loadStarterCatalog } from '@/lib/starterCatalog.client';

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

  /**
 * Trouvé en recette navigateur le 05/10/2026 : la fiche d'un plat affiche
 * « Aucune option pour ce plat » pour TOUS les plats du catalogue.
 *
 * Or c'est le geste le plus courant d'un maquis — « double portion »,
 * « sauce à part » — et le supplément est la seule chose qui montre que
 * l'addition sait compter une commande vraiment. Sans option, une moitié de
 * l'application restaurant est invisible au premier écran.
 */
describe('Catalogue d\'exemple — les options des plats', () => {
  const plats = starterPlats('restaurant');

  it('chaque plat du catalogue propose au moins une option', () => {
    for (const plat of plats) {
      expect(plat.options?.length ?? 0, `${plat.name} n'a aucune option`).toBeGreaterThan(0);
    }
  });

  it('propose des options RÉELLES pour un maquis, pas des mots generiques', () => {
    const noms = plats.flatMap((p) => (p.options ?? []).map((o) => o.name.toLowerCase()));
    expect(noms.some((n) => n.includes('portion'))).toBe(true);
    expect(noms.some((n) => n.includes('sauce'))).toBe(true);
  });

  it('donne des suppléments plausibles, sans dépassement absurde', () => {
    // Un supplément peut DÉPASSER le prix du plat : « riz gras » à 2 000 F
    // avec « avec poulet braisé » à +3 500 F donne une assiette à 5 500 F,
    // et c'est exactement ce qu'on commande dans un maquis. Ce qu'on refuse,
    // c'est le supplément qui transforme un plat en billet de 50 000 F — le
    // genre d'erreur de saisie qui traverse tous les tickets du restaurant.
    for (const plat of plats) {
      for (const o of plat.options ?? []) {
        expect(
          Math.abs(o.extra),
          `${plat.name} / ${o.name} : supplément hors de proportions`,
        ).toBeLessThanOrEqual(plat.priceSell * 2);
      }
    }
  });

  /**
 * Un supplément négatif fait échouer l'INSERT du lot ENTIER
 * (`product_modifiers_extra_price_check : extra_price >= 0`), et le restaurant
 * se retrouve alors sans aucune option — l'exact contraire de ce que le
 * catalogue est censé montrer. « Demi-poulet à −1 500 F » a fait le voyage
 * jusqu'ici : un supplément négatif n'est pas une remise, c'est un plat moins
 * cher, et ça s'écrit en prix.
 */
it('ne propose aucun supplément négatif', () => {
  for (const plat of plats) {
    for (const o of plat.options ?? []) {
      expect(o.extra, `${plat.name} / ${o.name} : supplément négatif`).toBeGreaterThanOrEqual(0);
    }
  }
});

it('ne met pas deux fois le même nom d\'option sur un même plat', () => {
    for (const plat of plats) {
      const noms = (plat.options ?? []).map((o) => o.name.toLowerCase());
      expect(new Set(noms).size, `${plat.name} a une option en double`).toBe(noms.length);
    }
  });

  it('le commerce n\'a pas d\'options : un quincaier ne vend pas de riz en double portion', () => {
    for (const a of starterCatalog('retail')) {
      expect(a.options ?? []).toHaveLength(0);
    }
  });
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

/**
 * Trouvé en recette navigateur le 06/10/2026.
 *
 * Le catalogue se chargeait complet, sans une erreur à l'écran — et SANS SES
 * OPTIONS : l'insert des modificateurs oubliait owner_id, la policy
 * « modifiers_write » le compare à get_business_owner_id() et RLS rejetait tout
 * en 403, silencieusement. Les définitions du catalogue étaient testées (elles
 * avaient bien des options) — c'est l'ÉCRITURE, elle, ne l'était pas. Ce test
 * exerce le vrai loader contre une base factice qui enregistre ce qu'on lui
 * envoie.
 */
describe("Catalogue d'exemple — l'écriture réelle en base", () => {
  it('écrit les options avec leur owner_id, sans quoi la RLS les rejette en 403', async () => {
    const ecrits: Array<{ table: string; rows: Array<Record<string, unknown>> }> = [];
    const base = {
      from: (table: string) => ({
        // Contrôle « déjà en place » : catalogue vide, on part de zéro.
        select: () => ({
          eq: () => ({ like: async () => ({ data: [], error: null }) }),
        }),
        insert: (rows: Array<Record<string, unknown>>) => {
          ecrits.push({ table, rows });
          if (table === 'products') {
            return {
              select: async () => ({
                data: rows.map((r, i) => ({ id: `p-${i}`, name: r.name as string, sku: r.sku })),
                error: null,
              }),
            };
          }
          // product_modifiers : insert attendu directement (await de l'objet).
          return { error: null };
        },
      }),
      rpc: async () => ({ data: null, error: null }),
    };

    const resultat = await loadStarterCatalog(
      base as unknown as Parameters<typeof loadStarterCatalog>[0],
      'org-1',
      'restaurant'
    );

    const options = ecrits.find((e) => e.table === 'product_modifiers');
    expect(options, "aucune option n'est même montée au client").toBeDefined();
    expect(options!.rows.length).toBeGreaterThan(0);
    for (const o of options!.rows) {
      expect(o.owner_id, `l'option « ${String(o.name)} » est écrite sans owner_id`).toBe('org-1');
      expect(o.product_id, `l'option « ${String(o.name)} » n'a pas de plat`).toBeTruthy();
      expect(typeof o.extra_price).toBe('number');
    }
    if ('charges' in resultat) {
      expect(resultat.charges).toBeGreaterThan(0);
      expect(resultat.recettes).toBeGreaterThan(0);
      expect(resultat.options).toBe(options!.rows.length);
    } else {
      throw new Error(resultat.erreur);
    }
  });
});