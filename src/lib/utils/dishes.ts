/**
 * Les plats d'un restaurant, pour que la caisse ne les confonde pas avec des
 * articles.
 *
 * Le problème : un produit qui a une RECETTE est un plat. Un plat ne se stocke
 * pas — sa disponibilité vient de ses ingrédients, et c'est
 * `sale_items_consume_recipe` (base) qui refuse la vente si l'un d'eux manque,
 * en nommant l'ingrédient manquant. Or la caisse affichait « Rupture de stock »
 * pour tout plat, parce que le stock propre d'un plat est 0, sa valeur
 * naturelle. Un maquis ne pouvait donc rien servir au comptoir : les plats de
 * son propre catalogue d'exemple étaient tous bloqués.
 *
 * La règle est donc, des deux côtés, la même : un plat n'a pas de stock propre.
 * Ce module ne fait qu'apporter au client l'information que la base applique
 * déjà — la liste des produits qui ont une recette.
 *
 * Une seule requête, au montage. Les recettes changent rarement et un client qui
 * vient d'ajouter une recette voit le plat concerné Sellable dès l'écran suivant.
 */

/**
 * Le client Supabase n'a qu'une méthode utile ici : `from()` puis `select()`.
 * On ne veut pas dépendre du type exact du client (il change selon la version),
 * seulement de ce contrat minimal.
 */
type Fromable = {
  from: (table: string) => {
    select: (cols: string) => PromiseLike<{ data: unknown; error: unknown }>;
  };
};

/** Identifiants des produits qui sont des plats, pour un tenant donné. */
export async function loadDishIds(db: Fromable): Promise<Set<string>> {
  try {
    const { data, error } = await db.from('recipe_ingredients').select('dish_id');

    if (error) {
      // Un restaurant sans table de recettes n'est pas une erreur : le module
      // Recettes peut lui-même être absent de l'organisation. On rend un ensemble
      // vide et la caisse se comporte alors comme un commerce.
      return new Set();
    }

    const ids = new Set<string>();
    for (const row of (data ?? []) as { dish_id: string | null }[]) {
      if (row.dish_id) ids.add(row.dish_id);
    }
    return ids;
  } catch {
    // La liste des plats est un CONFORT, pas une condition de vente. Si elle ne
    // peut pas être lue, la caisse vend quand même — au prix d'un « Rupture de
    // stock » sur les plats, ce qu'un restaurateur constatera vite. Le pire
    // serait un rejet non capté qui casse le rendu entier de l'écran.
    return new Set();
  }
}