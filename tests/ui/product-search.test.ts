import { describe, expect, it } from 'vitest';

import { lireEntier } from '@/lib/utils/nombres';
import {
  rechercher,
  normaliser,
  mots,
  distance,
  plusVendus,
} from '@/lib/utils/productSearch';

/**
 * Recherche du point de vente.
 *
 * Les produits ci-dessous sont ceux de la boutique de recette : les variantes
 * de mémoire et de stockage y sont indiscernables à l'œil (« A17 128/4 » contre
 * « A17 128/6 »), ce qui est exactement le cas pour lequel une recherche par
 * simple `includes()` ne rend aucun service.
 */
const CATALOGUE = [
  { id: 'a17-128-4', name: 'A17 128/4', price_buy: 84000, price_sell: 99000 },
  { id: 'a17-128-6', name: 'A17 128/6', price_buy: 93000, price_sell: 108000 },
  { id: 'a17-256-8', name: 'A17 256/8', price_buy: 123000, price_sell: 148000 },
  { id: 'a17-5g', name: 'A17 5G 256/8', price_buy: 130000, price_sell: 155000 },
  { id: 'a07-64', name: 'A07 64/4', price_buy: 55000, price_sell: 70000 },
  { id: 'note-15', name: 'Note 15 256/8', price_buy: 110000, price_sell: 135000 },
  { id: 'hp-1311', name: 'HP 15-fd1311TU / core ultra 5 / 512ssd / 8gb / Clavier Luminex / DOS', sku: 'HP1311', price_buy: 325000, price_sell: 370000 },
  { id: 'riz', name: 'RIZ', category: 'cereal', price_buy: 1200, price_sell: 1500 },
];

const noms = (q: string) => rechercher(CATALOGUE, q).map((r) => r.product.id);

describe('normaliser et mots', () => {
  it('minuscules, sans accent', () => {
    expect(normaliser('Café')).toBe('cafe');
    expect(normaliser('  A17 5G ')).toBe('a17 5g');
  });

  it('la barre oblique d’une variante n’est qu’un séparateur', () => {
    expect(mots('A17 128/6')).toEqual(['a17', '128', '6']);
  });

  it('lit les trois écritures d’un montant', () => {
    expect(lireEntier('150000')).toBe(150000);
    expect(lireEntier('150 000')).toBe(150000);
    expect(lireEntier('150.000')).toBe(150000);
    expect(lireEntier('1.349.400')).toBe(1349400);
    expect(lireEntier('')).toBeNull();
  });

  it('ne transforme pas un numéro de modèle en prix', () => {
    // « a17 » ne doit pas devenir 17 : sinon la recherche compare un nom de
    // téléphone aux prix de la boutique.
    expect(lireEntier('a17')).toBeNull();
    expect(lireEntier('1200.5')).toBeNull();
  });
});

describe('distance — le moteur des fautes de frappe', () => {
  it('compte les écarts', () => {
    expect(distance('abc', 'abc')).toBe(0);
    expect(distance('samsung', 'samsng')).toBe(1);
    expect(distance('cat', 'dog')).toBe(3);
  });

  it('s’arrête dès que la borne est dépassée', () => {
    expect(distance('abcdefgh', 'zz', 1)).toBeGreaterThan(1);
  });
});

describe('rechercher — trouver la bonne variante', () => {
  it('« 128/6 » tombe sur la bonne variante, pas sur 128/4', () => {
    expect(noms('128/6')[0]).toBe('a17-128-6');
  });

  it('« 128 » trouve les deux variantes mémoire', () => {
    const r = noms('128');
    expect(r).toContain('a17-128-4');
    expect(r).toContain('a17-128-6');
  });

  it('« a17 5g » trouve la 5G et pas les autres A17', () => {
    expect(noms('a17 5g')[0]).toBe('a17-5g');
  });

  it('le nom entier tapé trouve son produit', () => {
    expect(noms('Note 15 256/8')[0]).toBe('note-15');
  });
});

describe('rechercher — la faute de frappe ne doit pas rien renvoyer', () => {
  it('« samsng » trouve le Samsung', () => {
    // Sans cela, le caissier lit « aucun résultat » et conclut que le
    // produit est en rupture.
    const avecFaute = rechercher([{ name: 'Samsung A17 128/4' }], 'samsng');
    expect(avecFaute).toHaveLength(1);
  });

  it('« hp1311 » trouve par le code-barres', () => {
    expect(noms('HP1311')[0]).toBe('hp-1311');
  });

  it('le préfixe prime sur une correspondance plus loin', () => {
    const r = rechercher(
      [
        { name: 'Coque pour Samsung A17' },
        { name: 'Samsung A17 128/6' },
      ],
      'samsung a17',
    );
    // Le nom qui commence par la requête passe devant.
    expect(r[0].product.name).toBe('Samsung A17 128/6');
  });
});

describe('rechercher — deux chiffres ne sont jamais une faute de frappe', () => {
  it('« 6 » ne ramène pas « 4 » : à une distance d’édition de 1', () => {
    // Piège de caisse : la tolérance aux fautes rapprochait « 6 » de « 4 », et
    // « 128/6 » ramenait la 4 Go. L’écart de prix partait dans la mauvaise
    // caisse sans aucun signe à l'écran.
    expect(noms('128/6')).toEqual(['a17-128-6']);
    expect(noms('128/4')).toEqual(['a17-128-4']);
  });

  it('mais la faute reste tolérée sur un mot de plus de trois lettres', () => {
    // « notr » pour « Note » : une faute de frappe, pas une autre référence.
    expect(noms('notr')).toContain('note-15');
  });
});

describe('rechercher — le prix saisi trouve le produit', () => {
  it('« 1500 » trouve le RIZ, vendu 1 500', () => {
    expect(noms('1500')).toContain('riz');
  });

  it('« 110000 » trouve le Note 15, acheté 110 000', () => {
    expect(noms('110000')).toContain('note-15');
  });

  it('un nombre ne fait pas disparaître les produits par leur nom', () => {
    // « 128 » doit rester une recherche de mémoire, pas un prix.
    expect(noms('128').length).toBeGreaterThan(1);
  });
});

describe('rechercher — ce qui ne correspond pas est retiré', () => {
  it('unerequête sans rapport ne renvoie rien, plutôt que tout le catalogue', () => {
    expect(noms('volcan')).toHaveLength(0);
  });

  it('une requête vide renvoie tout le catalogue', () => {
    expect(rechercher(CATALOGUE, '')).toHaveLength(CATALOGUE.length);
  });
});

describe('rechercher — la catégorie reste trouvable', () => {
  it('« cereal » trouve le RIZ', () => {
    expect(noms('cereal')[0]).toBe('riz');
  });
});

describe('plusVendus', () => {
  it('classe du plus vendu au moins vendu', () => {
    expect(plusVendus({ a: 3, b: 10, c: 1 })).toEqual(['b', 'a', 'c']);
  });
});
