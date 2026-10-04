/**
 * La carte du jour.
 *
 * Un restaurant ne sert pas le poisson le mardi. Une carte qui propose un plat
 * non servi est pire qu'une carte courte : le client commande ce qu'il voit, et
 * la cuisine ne cuisine pas ce qui n'est pas au menu.
 *
 * La règle inverse compte autant : un client peut demander LE plat absent du
 * menu. Refuser la commande rendrait le serveur incapable de répondre « on peut,
 * on le prépare ». D'où le mode « toute la carte ».
 *
 * Fonction pure dans son propre module, et non dans le composant : la règle est
 * un jour de la semaine, donc la tester via le DOM la ferait dépendre de la
 * date du jour — verte trois jours sur sept. Le jour est un paramètre.
 */
export function platsServisAujourdhui<T extends { is_active?: boolean; menu_days?: number[] | null }>(
  products: T[],
  carteDuJour = true,
  jour = new Date().getDay(),
): T[] {
  return products.filter((p) => {
    // Un plat archivé est invisible partout : ce n'est pas une question de jour.
    if (p.is_active === false) return false;
    if (!carteDuJour) return true;
    // menu_days null = tous les jours : le défaut d'un plat créé depuis Stock.
    return p.menu_days == null || p.menu_days.includes(jour);
  });
}