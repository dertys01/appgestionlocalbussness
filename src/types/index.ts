import type { ElementType } from 'react';

export interface Product {
  id: string;
  user_id: string;
  name: string;
  sku: string | null;
  price_buy: number;
  price_sell: number;
  stock_qty: number;
  min_stock_level: number;
  category: string | null;
  /**
   * Unité de vente : `pce`, `kg`, `L`, `botte`, `sachet`…
   *
   * Affichage seulement — la quantité est un nombre dans cette unité. Un produit
   * vendu en sachet et au kilo doit être deux produits, sinon il faudrait deux
   * stocks et un facteur de conversion.
   */
  unit: string;
  /** false = archivé : invisible en caisse, conservé pour l'historique */
  is_active: boolean;
  archived_at: string | null;
  /** Fournisseur principal ; null tant qu'aucun n'est choisi. */
  supplier_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Fournisseur : d'où vient la marchandise. Ne porte aucun montant d'achat ni
 * aucune échéance — ce n'est pas une comptabilité fournisseurs, et le relevé
 * de prix papier suffit dans l'informel.
 */
export interface Supplier {
  id: string;
  user_id: string;
  name: string;
  phone: string | null;
  address: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface Sale {
  id: string;
  user_id: string;
  total_amount: number;
  /** 'credit' = marchandise cédée, argent dû. Comptabilisée au règlement. */
  payment_method: 'cash' | 'momo' | 'credit';
  /** FALSE pour une vente à crédit non encaissée : le stock est parti, l'argent non. */
  settled: boolean;
  /** Ce qui est réellement rentré. Égal au prix sauf vente à crédit. */
  amount_received: number;
  /** Numéro normalisé du client, renseigné sur les ventes à crédit. */
  client_phone?: string | null;
  note: string | null;
  client_name: string | null;
  created_at: string;
}

export interface SaleItem {
  id: string;
  sale_id: string;
  product_id: string;
  product_name: string;
  quantity: number;
  unit_price: number;
  subtotal: number;
}

export interface StockLog {
  id: string;
  user_id: string;
  product_id: string;
  product_name: string;
  movement_type: 'sale' | 'restock' | 'adjustment';
  quantity_change: number;
  stock_before: number;
  stock_after: number;
  reference_id: string | null;
  created_at: string;
}

export interface BusinessMember {
  id: string;
  owner_id: string;
  member_id: string;
  member_name: string;
  role: string;
  created_at: string;
}

export interface ActivityLog {
  id: string;
  business_owner_id: string;
  actor_id: string;
  actor_email: string;
  actor_name: string | null;
  action: string;
  description: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

// ── SaaS ──────────────────────────────────────────────────────

export type Plan = 'free' | 'starter' | 'pro';

export interface Organization {
  id: string;
  name: string;
  slug: string;
  logo_url: string | null;
  plan: Plan;
  timezone: string;
  currency: string;
  onboarding_done: boolean;
  ifu: string | null;
  address: string | null;
  invoice_counter: number;
  /**
   * Domaine d'activité : 'retail' (caisse comptoir) ou 'restaurant'
   * (salle, tables, commande ouverte). Ne décide que des modules affichés —
   * jamais d'un droit ni d'un quota (src/lib/modules.ts).
   */
  domain: 'retail' | 'restaurant';
  created_at: string;
  updated_at: string;
}

export interface Subscription {
  id: string;
  org_id: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  plan: Plan;
  status: 'active' | 'trialing' | 'past_due' | 'canceled' | 'unpaid';
  current_period_end: string | null;
  created_at: string;
  updated_at: string;
}

export interface PlanLimits {
  products: number;       // max nb produits (Infinity = illimité)
  employees: number;      // max nb employés
  salesHistoryDays: number; // jours d'historique accessible
  exportCsv: boolean;
  reports: boolean;
  forecast: boolean;
}

// Panier POS
export interface CartItem {
  product: Product;
  quantity: number;
  /**
   * Prix unitaire convenu. `null` = prix catalogue inchangé.
   *
   * Dans un marché de rue, « c'est le dernier prix » est la règle : bloquer la
   * modification d'un prix n'est pas une protection, c'est un blocage qui
   * pousse la vente hors de l'application. Le prix catalogue reste enregistré
   * côté serveur (`sale_items.list_price`), donc la remise est traçable.
   */
  unitPrice: number | null;
}

/**
 * Navigation du tableau de bord.
 *
 * Ces types vivent ici plutôt que dans `page.tsx` : la sidebar, les onglets et
 * la page les partagent tous. Un type importé depuis une page forcerait la
 * sidebar à importer la coquille qui la rend elle-même.
 */
export type Tab =
  | 'dashboard'
  | 'pos'
  | 'inventory'
  | 'sales'
  | 'debts'
  | 'reports'
  | 'forecast'
  | 'team'
  | 'floor'
  | 'settings';

/** Sous-vue de l'onglet Rapports. */
export type ReportView = 'sales' | 'profit' | 'expenses';

export interface NavItem {
  key: Tab;
  label: string;
  icon: ElementType;
  locked: boolean;
}
