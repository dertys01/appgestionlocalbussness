/**
 * Domaines d'activité : ce que l'application montre, et rien d'autre.
 *
 * Un même socle sert un commerce de détail (caisse comptoir) et un restaurant
 * (salle, tables, commande ouverte). On ne construit pas deux applications :
 * on choisit à l'inscription, et l'interface se limite aux modules du domaine.
 *
 * Règle d'or : un module d'un autre domaine n'est pas rendu — pas « masqué ».
 * Un `if (isRestaurant)` spreadé dans chaque écran ferait renaître le
 * fourre-tout qu'on veut éviter ; ici la liste des modules est l'unique
 * endroit qui décide.
 *
 * Le domaine n'est PAS une question de droits : RLS, plans, limites de
 * produits et tunnel Stripe sont identiques pour les deux. Il ne décide que
 * de l'affichage, ce qui rend la bascule (Réglages) sans risque.
 */

import type { Tab } from '@/types';

export type Domain = 'retail' | 'restaurant';

/** Onglets communs : ils servent les deux activités, inchangés. */
const COMMUN: Tab[] = ['dashboard', 'pos', 'inventory', 'sales', 'debts', 'reports', 'team'];

/** Modules propres au commerce : le prévisionnel. */
const RETAIL_ONLY: Tab[] = ['forecast'];

/**
 * Modules propres à la restauration.
 *
 * `floor` = la salle et la commande ouverte (Sprint 13). Cuisine et recettes
 * arrivent aux sprints 14 et 15 : la liste existe pour qu'un module de plus
 * soit une ligne, pas une refonte.
 */
const RESTAURANT_ONLY: Tab[] = ['floor', 'recipes'];

export const DOMAIN_MODULES: Record<Domain, Tab[]> = {
  retail: [...COMMUN, ...RETAIL_ONLY],
  restaurant: [...COMMUN, ...RESTAURANT_ONLY],
};

export const DOMAIN_LABELS: Record<Domain, string> = {
  retail: 'Commerce / Boutique',
  restaurant: 'Restaurant / Maquis',
};

export const DOMAIN_DESCRIPTIONS: Record<Domain, string> = {
  retail: 'Caisse comptoir, stock, ventes, dettes et rapports.',
  restaurant:
    'Caisse comptoir, stock, ventes et rapports — plus la salle, les tables, le ticket cuisine et les recettes.',
};

/** Domaine inconnu (colonne absente, valeur exotique) → commerce. */
export function normalizeDomain(raw: unknown): Domain {
  return raw === 'restaurant' ? 'restaurant' : 'retail';
}

/** Modules rendus pour un domaine. Toujours une copie : l'appelant peut trier. */
export function getEnabledModules(domain: unknown): Tab[] {
  return [...DOMAIN_MODULES[normalizeDomain(domain)]];
}

/**
 * Un onglet appartient-il au domaine ?
 *
 * Sert aux deux fois : filtrer la navigation, ET interdire qu'un onglet
 * d'un autre domaine s'affiche parce qu'un lien pointait dessus. `Tab`
 * acceptant des valeurs arbitraires, une simple absence dans la liste ne
 * protège rien si le rendu ne la consulte pas.
 */
export function isModuleEnabled(domain: unknown, tab: Tab): boolean {
  return getEnabledModules(domain).includes(tab);
}

/**
 * Onglet de repli quand l'onglet demandé n'appartient pas au domaine : le
 * premier module du domaine, jamais `undefined`.
 */
export function fallbackTab(domain: unknown): Tab {
  return getEnabledModules(domain)[0];
}