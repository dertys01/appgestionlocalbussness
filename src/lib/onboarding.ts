/**
 * Assistant de premier lancement : les données, sans React.
 *
 * Objectif unique : une boutique neuve fait sa première vente en moins de 4
 * minutes. Tout ce qui n'y mène pas est reporté après — l'équipe, le
 * catalogue complet, l'abonnement.
 *
 * Le patron choisit parmi 4 activités, plus parlantes que les 2 domaines
 * techniques. Le domaine en est déduit : c'est toujours lui, et lui seul, qui
 * décide des modules (src/lib/modules.ts).
 */

import type { Domain } from '@/lib/modules';
import { starterSku } from '@/lib/starterCatalog';

export type BusinessType = 'epicerie' | 'boutique' | 'restaurant' | 'autre';

export const BUSINESS_TYPES: readonly BusinessType[] = ['epicerie', 'boutique', 'restaurant', 'autre'];

export const BUSINESS_LABELS: Record<BusinessType, string> = {
  epicerie: 'Épicerie / Alimentation',
  boutique: 'Boutique / Commerce général',
  restaurant: 'Maquis / Restaurant',
  autre: 'Autre',
};

export const BUSINESS_DESCRIPTIONS: Record<BusinessType, string> = {
  epicerie: 'Riz, huile, boissons, produits alimentaires…',
  boutique: 'GSM, électronique, prêt-à-porter, produits importés, articles divers…',
  restaurant: 'Plats, poulet braisé, boissons, restauration…',
  autre: '',
};

export function domainOf(type: BusinessType): Domain {
  return type === 'restaurant' ? 'restaurant' : 'retail';
}

/** Valeur inconnue ou absente → null : l'assistant reposera la question. */
export function normalizeBusinessType(raw: unknown): BusinessType | null {
  return BUSINESS_TYPES.includes(raw as BusinessType) ? (raw as BusinessType) : null;
}

/** Un produit d'exemple de l'assistant. */
export interface SampleProduct {
  name: string;
  category: string;
  unit: string;
  priceBuy: number;
  priceSell: number;
  stock: number;
  minStock: number;
}

/**
 * Trois produits par activité, pas davantage : on les voit tous sur un
 * téléphone sans défiler, et on comprend qu'il suffit d'en toucher un.
 *
 * Le STOCK n'est pas décoratif : create_sale() refuse de vendre au-delà du
 * stock. Un exemple à zéro ferait échouer la toute première vente sur
 * « Stock insuffisant » — la pire première impression possible.
 *
 * Le prix d'achat non plus : la marge du rapport de rentabilité se calcule
 * dessus, et un prix d'achat nul afficherait 100 % de marge.
 */
const SAMPLES: Record<BusinessType, SampleProduct[]> = {
  epicerie: [
    { name: 'Riz 25 kg', category: 'Épicerie', unit: 'sac', priceBuy: 17500, priceSell: 21000, stock: 10, minStock: 3 },
    { name: 'Huile 1L', category: 'Épicerie', unit: 'pce', priceBuy: 1000, priceSell: 1300, stock: 24, minStock: 6 },
    { name: 'Sucre 1 kg', category: 'Épicerie', unit: 'pce', priceBuy: 700, priceSell: 900, stock: 30, minStock: 8 },
  ],
  boutique: [
    { name: 'Téléphone / GSM', category: 'Téléphonie', unit: 'pce', priceBuy: 35000, priceSell: 45000, stock: 5, minStock: 2 },
    { name: 'Chargeur', category: 'Accessoires', unit: 'pce', priceBuy: 1500, priceSell: 3000, stock: 20, minStock: 5 },
    { name: 'Article divers', category: 'Divers', unit: 'pce', priceBuy: 500, priceSell: 1000, stock: 30, minStock: 5 },
  ],
  restaurant: [
    { name: 'Poulet braisé', category: 'Plats', unit: 'pce', priceBuy: 2800, priceSell: 4500, stock: 20, minStock: 5 },
    // Vendu au kilo : la caisse accepte « 0,5 », c'est la raison de l'unité.
    { name: 'Riz blanc (kg)', category: 'Plats', unit: 'kg', priceBuy: 400, priceSell: 1200, stock: 25, minStock: 5 },
    { name: 'Boisson', category: 'Boissons', unit: 'bouteille', priceBuy: 300, priceSell: 600, stock: 48, minStock: 12 },
  ],
  autre: [
    { name: 'Article 1', category: 'Divers', unit: 'pce', priceBuy: 700, priceSell: 1000, stock: 20, minStock: 5 },
    { name: 'Article 2', category: 'Divers', unit: 'pce', priceBuy: 1750, priceSell: 2500, stock: 20, minStock: 5 },
    { name: 'Article 3', category: 'Divers', unit: 'pce', priceBuy: 3500, priceSell: 5000, stock: 20, minStock: 5 },
  ],
};

/** Les exemples d'une activité. Toujours une copie. */
export function onboardingSamples(type: BusinessType): SampleProduct[] {
  return SAMPLES[type].map((s) => ({ ...s }));
}

/**
 * Lignes `products` prêtes à insérer.
 *
 * SKU `DEMO-xx` : les mêmes que le catalogue d'exemple, donc la bannière
 * « Retirer les articles d'exemple » de l'onglet Stock les retrouve et les
 * retire d'un clic, sans code de plus.
 */
export function sampleRows(type: BusinessType, ownerId: string) {
  return onboardingSamples(type).map((s, i) => ({
    user_id: ownerId,
    name: s.name,
    category: s.category,
    unit: s.unit,
    sku: starterSku(i),
    price_buy: s.priceBuy,
    price_sell: s.priceSell,
    stock_qty: s.stock,
    min_stock_level: s.minStock,
    is_active: true,
  }));
}

/**
 * Les écrans de l'assistant, dans l'ordre. La valeur est stockée dans
 * organizations.onboarding_step : un rechargement reprend là où on en était.
 *
 * 'first_sale' n'est PAS un écran de l'assistant : c'est la caisse, en mode
 * guidé, sans la navigation (page.tsx).
 */
export type OnboardingStep = 'welcome' | 'business' | 'samples' | 'first_sale' | 'congrats';

export const ONBOARDING_STEPS: readonly OnboardingStep[] = [
  'welcome', 'business', 'samples', 'first_sale', 'congrats',
];

/** Étape inconnue ou absente → le début. */
export function normalizeOnboardingStep(raw: unknown): OnboardingStep {
  return ONBOARDING_STEPS.includes(raw as OnboardingStep) ? (raw as OnboardingStep) : 'welcome';
}
