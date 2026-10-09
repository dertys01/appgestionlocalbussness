/**
 * Échappement HTML — la seule implémentation du dépôt.
 *
 * Il existait en double (print.ts et kitchen.ts), avec le même corps recopié :
 * deux copies, c'est deux occasions d'oublier un caractère le jour où l'une
 * bouge. Toute donnée saisie par l'utilisateur (nom de produit, de client, note)
 * passe par ici avant d'entrer dans un document HTML imprimé — sans quoi un nom
 * contenant du HTML exécuterait du JavaScript dans cette origine et pourrait
 * voler la session Supabase (stockée en localStorage).
 */
export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default: return c;
    }
  });
}
