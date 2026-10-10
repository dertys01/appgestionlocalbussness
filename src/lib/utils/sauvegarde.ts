import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Sauvegarde complète d'une boutique — export JSON de toutes ses données.
 *
 * Raison d'être : la base vit chez Supabase, mais un commerçant doit pouvoir
 * récupérer SES données (sauvegarde, migration, changement de compte). Les
 * exports existants sont par écran (inventaire, ventes, dettes) ; celui-ci est
 * le filet complet.
 *
 * Portée : les tables du tenant, lues avec la session de l'appelant — la RLS
 * garantit qu'on n'exporte QUE sa propre boutique. Les journaux techniques
 * (activity_logs, webhook_events, rate_limits) sont exclus : ce ne sont pas
 * des données de commerce.
 *
 * Pagination obligatoire : PostgREST plafonne à 1 000 lignes par requête. Sans
 * elle, un commerce actif exporterait 1 000 ventes sur 12 000, en silence.
 */

/** Tables du commerce exportées, dans un ordre lisible. */
const TABLES = [
  'products',
  'suppliers',
  'sales',
  'sale_items',
  'customer_debts',
  'credit_payments',
  'expenses',
  'expense_categories',
] as const;

const PAGE = 1000;
/** Garde-fou : au-delà, l'export est probablement une erreur, pas un besoin. */
const MAX_LIGNES = 500_000;

async function lireTout(supabase: SupabaseClient, table: string): Promise<unknown[]> {
  const tout: unknown[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from(table).select('*').range(from, from + PAGE - 1);
    if (error) throw new Error(`${table} : ${error.message}`);
    const lot = data ?? [];
    tout.push(...lot);
    if (lot.length < PAGE) break;
    if (tout.length >= MAX_LIGNES) break;
  }
  return tout;
}

export interface Sauvegarde {
  nom: string;
  contenu: string;
}

export async function construireSauvegarde(supabase: SupabaseClient): Promise<Sauvegarde> {
  const donnees: Record<string, unknown[]> = {};
  for (const t of TABLES) {
    donnees[t] = await lireTout(supabase, t);
  }
  const jour = new Date().toISOString().slice(0, 10);
  return {
    nom: `sauvegarde-gestionlocal-${jour}.json`,
    contenu: JSON.stringify(
      { version: 1, exporte_le: new Date().toISOString(), donnees },
      null,
      2,
    ),
  };
}

export function telechargerSauvegarde({ nom, contenu }: Sauvegarde): void {
  const blob = new Blob([contenu], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nom;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
