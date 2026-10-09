/**
 * Référence idempotente d'une vente (client_ref).
 *
 * Générée par la caisse AVANT l'appel à create_sale() : c'est elle qui permet
 * au serveur de reconnaître un rejeu et de renvoyer la vente existante au lieu
 * d'en créer une seconde (voir migration_offline_sales.sql).
 *
 * `crypto.randomUUID()` est disponible partout où IndexedDB l'est (contexte
 * sécurisé). Le repli couvre les cas résiduels : unicité suffisante par
 * boutique, sans dépendre d'une API absente.
 */
export function nouvelleRefVente(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'ref-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}
