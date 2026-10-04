/**
 * Catalogue d'exemple, par domaine.
 *
 * Le premier écran d'une application doit parler le métier de celui qui le lit.
 * Un maquis qui se voit proposer « Samsung Galaxy A15 » comprend tout de suite que
 * le logiciel n'a pas été fait pour lui — et il ne va pas plus loin.
 *
 * Ce catalogue est donc écrit deux fois, dans les deux activités : des plats et
 * leurs ingrédients pour un restaurant, de l'épicerie et de la quincaillerie pour
 * un commerce. Les prix sont en FCFA et les unités sont celles qu'on utilise
 * réellement au Bénin (le riz au kilo, l'huile au litre, l'attiéké en portion,
 * la piledji en botte) — c'est cette unité qui décide si la caisse sait compter
 * 2,5 kg ou 2500 g.
 *
 * Chaque article porte un SKU `DEMO-xx`. Ce n'est pas un détail : c'est ce qui
 * permet de les retrouver, et de les retirer d'un clic quand le commerçant n'en
 * veut pas — sans lui faire parcourir le stock pour les supprimer à la main.
 */

import type { Domain } from '@/lib/modules';

/** Préfixe des SKU d'exemple : leur présence signale un catalogue de démo. */
export const DEMO_PREFIX = 'DEMO-';

/** Une ligne du catalogue d'exemple. */
export interface StarterArticle {
  name: string;
  category: string;
  unit: string;
  /** Prix d'achat unitaire — sert à la marge et au coût de matière. */
  priceBuy: number;
  priceSell: number;
  stock: number;
  minStock: number;
  /**
   * Ingrédients d'un plat, pour le restaurant : c'est ce qui remplit l'onglet
   * Recettes. Sans elle, un maquis découvre le module vide et ne voit pas ce
   * qu'il peut en faire.
   */
  recipe?: { ingredient: string; quantity: number }[];
}

/**
 * Épicerie, quincaillerie, boutique de quartier.
 *
 * Le prix d'achat n'est pas décoratif : la marge du rapport de rentabilité se
 * calcule dessus. Des prix d'achat à zéro donneraient 100 % de marge partout et
 * un rapport qui ne veut rien dire. Les fourchettes sont celles du marché
 * courant à Cotonou et Porto-Novo — un commerçant qui les reconnaît est enclin à
 * corriger les siennes, ce qui est exactement le but.
 */
const RETAIL: StarterArticle[] = [
  // ─── Épicerie ───
  { name: 'Riz parfumé 25 kg', category: 'Épicerie', unit: 'sac', priceBuy: 17500, priceSell: 21000, stock: 24, minStock: 6 },
  { name: 'Riz blanc', category: 'Épicerie', unit: 'kg', priceBuy: 400, priceSell: 1200, stock: 50, minStock: 10 },
  { name: 'Huile végétale 5 L', category: 'Épicerie', unit: 'bidon', priceBuy: 6250, priceSell: 7500, stock: 18, minStock: 6 },
  { name: 'Sucre en poudre 1 kg', category: 'Épicerie', unit: 'kg', priceBuy: 700, priceSell: 950, stock: 40, minStock: 10 },
  { name: 'Farine de blé 50 kg', category: 'Épicerie', unit: 'sac', priceBuy: 19500, priceSell: 24000, stock: 8, minStock: 3 },
  { name: 'Sel de cuisine 1 kg', category: 'Épicerie', unit: 'kg', priceBuy: 150, priceSell: 300, stock: 30, minStock: 8 },
  { name: 'Huile de palme 5 L', category: 'Épicerie', unit: 'bidon', priceBuy: 5800, priceSell: 7000, stock: 12, minStock: 4 },
  { name: 'Sardines en boîte', category: 'Épicerie', unit: 'boîte', priceBuy: 1100, priceSell: 1450, stock: 60, minStock: 20 },

  // ─── Boissons ───
  { name: 'Jus concentrate 33 cl', category: 'Boissons', unit: 'canette', priceBuy: 450, priceSell: 700, stock: 96, minStock: 24 },
  { name: 'Eau minérale 50 cl', category: 'Boissons', unit: 'bouteille', priceBuy: 100, priceSell: 200, stock: 120, minStock: 36 },
  { name: 'Café soluble 100 g', category: 'Boissons', unit: 'pce', priceBuy: 1800, priceSell: 2400, stock: 15, minStock: 5 },
  { name: 'Thé vert 25 sachets', category: 'Boissons', unit: 'pce', priceBuy: 950, priceSell: 1400, stock: 22, minStock: 6 },
  { name: 'Lait en poudre 400 g', category: 'Boissons', unit: 'pce', priceBuy: 2800, priceSell: 3500, stock: 10, minStock: 4 },

  // ─── Ménage et hygiène ───
  { name: 'Détergent poudre 1 kg', category: 'Ménage', unit: 'kg', priceBuy: 1100, priceSell: 1500, stock: 25, minStock: 8 },
  { name: 'Savon de ménage 400 g', category: 'Hygiène', unit: 'pce', priceBuy: 350, priceSell: 550, stock: 48, minStock: 12 },
  { name: 'Rouleau de sacs poubelle', category: 'Ménage', unit: 'rouleau', priceBuy: 1500, priceSell: 2200, stock: 12, minStock: 4 },

  // ─── Quincaillerie ───
  { name: 'Ciment 50 kg', category: 'Quincaillerie', unit: 'sac', priceBuy: 4500, priceSell: 5500, stock: 40, minStock: 10 },
  { name: 'Ampoule LED 9 W', category: 'Quincaillerie', unit: 'pce', priceBuy: 400, priceSell: 750, stock: 60, minStock: 20 },
  { name: 'Peinture 5 L', category: 'Quincaillerie', unit: 'pot', priceBuy: 12000, priceSell: 15500, stock: 6, minStock: 2 },
];

/**
 * Maquis, restaurant de quartier, cantine.
 *
 * Deux familles, et c'est volontaire : les INGRÉDIENTS (riz, huile, oignon) sont
 * des produits comme les autres — on en achète au sac et on en revend au poids —
 * et les PLATS sont des produits aussi, dont la recette est le coût de matière.
 * C'est ainsi que fonctionne un maquis : l'ingrédient est au stock, le plat est à
 * la carte.
 *
 * Les recettes sont le vrai apport de ce catalogue : elles ouvrent l'onglet
 * Recettes avec de la matière, donc une marge par plat qui se calcule seule.
 */
const RESTAURANT: StarterArticle[] = [
  // ─── Ingrédients ───
  { name: 'Riz blanc', category: 'Ingrédients', unit: 'kg', priceBuy: 400, priceSell: 1200, stock: 50, minStock: 10 },
  { name: 'Huile végétale 1 L', category: 'Ingrédients', unit: 'L', priceBuy: 900, priceSell: 1200, stock: 19, minStock: 6 },
  { name: 'Poulet entier', category: 'Ingrédients', unit: 'pce', priceBuy: 2800, priceSell: 3500, stock: 12, minStock: 4 },
  { name: 'Poisson tilapia', category: 'Ingrédients', unit: 'kg', priceBuy: 1200, priceSell: 2000, stock: 8, minStock: 3 },
  { name: 'Attiéké', category: 'Ingrédients', unit: 'kg', priceBuy: 900, priceSell: 1500, stock: 15, minStock: 5 },
  { name: 'Banane plantain', category: 'Ingrédients', unit: 'kg', priceBuy: 400, priceSell: 800, stock: 20, minStock: 6 },
  { name: 'Tomate', category: 'Ingrédients', unit: 'kg', priceBuy: 500, priceSell: 900, stock: 12, minStock: 4 },
  { name: 'Oignon', category: 'Ingrédients', unit: 'kg', priceBuy: 350, priceSell: 700, stock: 15, minStock: 5 },
  { name: 'Piment', category: 'Ingrédients', unit: 'kg', priceBuy: 2000, priceSell: 3500, stock: 3, minStock: 1 },

  // ─── Plats ───
  {
    name: 'Riz gras', category: 'Plats', unit: 'portion', priceBuy: 0, priceSell: 2000, stock: 0, minStock: 0,
    recipe: [
      { ingredient: 'Riz blanc', quantity: 0.3 },
      { ingredient: 'Huile végétale 1 L', quantity: 0.03 },
    ],
  },
  {
    name: 'Poulet braisé', category: 'Plats', unit: 'pce', priceBuy: 0, priceSell: 4500, stock: 0, minStock: 0,
    recipe: [
      { ingredient: 'Poulet entier', quantity: 1 },
      { ingredient: 'Oignon', quantity: 0.05 },
      { ingredient: 'Piment', quantity: 0.01 },
    ],
  },
  {
    name: 'Attiéké poisson', category: 'Plats', unit: 'portion', priceBuy: 0, priceSell: 2500, stock: 0, minStock: 0,
    recipe: [
      { ingredient: 'Attiéké', quantity: 0.2 },
      { ingredient: 'Poisson tilapia', quantity: 0.12 },
      { ingredient: 'Tomate', quantity: 0.05 },
      { ingredient: 'Oignon', quantity: 0.03 },
    ],
  },
  {
    name: 'Alloco (banane plantain)', category: 'Plats', unit: 'portion', priceBuy: 0, priceSell: 1000, stock: 0, minStock: 0,
    recipe: [{ ingredient: 'Banane plantain', quantity: 0.15 }],
  },

  // ─── Boissons ───
  { name: 'Jus de bissap', category: 'Boissons', unit: 'verre', priceBuy: 150, priceSell: 500, stock: 40, minStock: 10 },
  { name: 'Jus concentrate 33 cl', category: 'Boissons', unit: 'canette', priceBuy: 450, priceSell: 700, stock: 48, minStock: 12 },
  { name: 'Eau minérale 50 cl', category: 'Boissons', unit: 'bouteille', priceBuy: 100, priceSell: 200, stock: 60, minStock: 18 },
  { name: 'Eau de piment', category: 'Boissons', unit: 'verre', priceBuy: 50, priceSell: 200, stock: 60, minStock: 15 },
];

/** Le catalogue d'exemple du domaine. Toujours une copie : l'appelant peut trier. */
export function starterCatalog(domain: unknown): StarterArticle[] {
  return domain === 'restaurant' ? RESTAURANT.map((a) => ({ ...a })) : RETAIL.map((a) => ({ ...a }));
}

/** Nombre d'articles Load And Go — c'est ce que le bouton annonce. */
export function starterCount(domain: unknown): number {
  return starterCatalog(domain).length;
}

/** Les plats du catalogue : ceux qui portent une recette. */
export function starterPlats(domain: unknown): StarterArticle[] {
  return starterCatalog(domain).filter((a) => a.recipe && a.recipe.length > 0);
}

/** Catégories du catalogue, dans l'ordre d'apparition — les puces du filtre. */
export function starterCategories(domain: unknown): string[] {
  return [...new Set(starterCatalog(domain).map((a) => a.category))];
}

/** Le SKU d'exemple d'un article, à son rang dans le catalogue. */
export function starterSku(index: number): string {
  return `${DEMO_PREFIX}${String(index + 1).padStart(2, '0')}`;
}

/** Un SKU est-il un exemple ? Base de la bannière « retirez les exemples ». */
export function isDemoSku(sku: string | null | undefined): boolean {
  return typeof sku === 'string' && sku.toUpperCase().startsWith(DEMO_PREFIX);
}

/**
 * Exemples d'un seul article, pour les champs de saisie.
 *
 * Un placeholder qui dit « Samsung Galaxy A05 » alors qu'on vend du riz fait
 * perdre le commerçant une seconde à chaque fiche — et le faitaraketer que le
 * logiciel suppose qu'il vend des téléphones. Les exemples suivent le domaine.
 */
export interface FieldExamples {
  product: string;
  sku: string;
  category: string;
  supplier: string;
}

const EXAMPLES: Record<Domain, FieldExamples> = {
  retail: {
    product: 'Riz parfumé 25 kg',
    sku: 'RIZ-25',
    category: 'Épicerie, boissons, quincaillerie',
    supplier: 'Grossiste Adjara',
  },
  restaurant: {
    product: 'Riz gras',
    sku: 'PLAT-RIZ-GRAS',
    category: 'Plats, boissons, ingrédients',
    supplier: 'Marché de Tokplégbé',
  },
};

export function fieldExamples(domain: unknown): FieldExamples {
  return domain === 'restaurant' ? { ...EXAMPLES.restaurant } : { ...EXAMPLES.retail };
}