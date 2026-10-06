/**
 * Chargement et retrait du catalogue d'exemple.
 *
 * Deux opérations, toutes deux en base : c'est ce qui les rend sûres. Un
 * `insert` du navigateur passe par la RLS des produits — un patron ou un manager
 * seulement, dans SA boutique — et ne peut rien écrire ailleurs. Une fonction
 * SQL serait plus discrète mais ouvrirait une surface d'attaque de plus pour un
 * appel que le navigateur a déjà le droit de faire.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  DEMO_PREFIX,
  isDemoSku,
  starterCatalog,
  starterSku,
  type StarterArticle,
} from '@/lib/starterCatalog';

/** Ce qu'une ligne du catalogue produit une fois en base. */
interface LigneBase {
  id: string;
  name: string;
  sku: string | null;
}

/**
 * Charge le catalogue d'exemple du domaine.
 *
 * Les recettes suivent les produits : un plat sans ingrédient n'existe pas dans
 * l'onglet Recettes. L'ordre compte — d'abord les articles, ensuite les
 * recettes, qui ont besoin de l'identifiant de l'ingrédient. D'où deux allers-
 *-retours plutôt qu'un seul.
 *
 * @returns le nombre d'articles réellement écrits, ou une phrase d'erreur.
 */
export async function loadStarterCatalog(
  supabase: SupabaseClient,
  ownerId: string,
  domain: unknown
): Promise<{ charges: number; recettes: number; options: number } | { erreur: string }> {
  const catalogue: StarterArticle[] = starterCatalog(domain);

  // Un catalogue déjà présent ne se réécrit pas : deux passages sur le même
  // écran d'accueil créeraient des doublons en double.
  const dejaLa = await supabase
    .from('products')
    .select('id, name, sku')
    .eq('user_id', ownerId)
    .like('sku', `${DEMO_PREFIX}%`);
  if (dejaLa.error) return { erreur: dejaLa.error.message };
  if ((dejaLa.data ?? []).length > 0) return { charges: 0, recettes: 0, options: 0 };

  const ecrit = await supabase
    .from('products')
    .insert(
      catalogue.map((a, i) => ({
        user_id: ownerId,
        name: a.name,
        category: a.category,
        unit: a.unit,
        sku: starterSku(i),
        price_buy: a.priceBuy,
        price_sell: a.priceSell,
        stock_qty: a.stock,
        min_stock_level: a.minStock,
        // Actif même quand le stock est à zéro : un plat à la carte n'a pas de
        // « stock » propre, et le retirer de la carte parce qu'il n'a pas de
        // réserve le ferait disparaître du menu.
        is_active: true,
      }))
    )
    .select('id, name, sku');
  if (ecrit.error) return { erreur: ecrit.error.message };

  const lignes = (ecrit.data ?? []) as LigneBase[];
  const parNom = new Map<string, string>();
  for (const l of lignes) parNom.set(l.name.toLowerCase(), l.id);

  // Les recettes : plat par plat, ingrédient par ingrédient. Les identifiants
  // viennent tous du même lot d'insertion, d'où la table nom → id.
  let recettes = 0;
  const ingredients: {
    dish_id: string;
    ingredient_id: string;
    quantity: number;
  }[] = [];

  for (const a of catalogue) {
    if (!a.recipe) continue;
    const dish = parNom.get(a.name.toLowerCase());
    if (!dish) continue;
    for (const ing of a.recipe) {
      const ingredient = parNom.get(ing.ingredient.toLowerCase());
      if (!ingredient) continue;
      ingredients.push({
        dish_id: dish,
        ingredient_id: ingredient,
        quantity: ing.quantity,
      });
      recettes += 1;
    }
  }

  // add_recipe_ingredient est une fonction : elle refuse le cycle (un plat dans
  // lui-même) et vérifie que l'ingrédient est bien un produit de la boutique.
  // Le client ne pourrait pas l'écrire directement sans ces contrôles.
  for (const ing of ingredients) {
    const r = await supabase.rpc('add_recipe_ingredient', {
      p_dish_id: ing.dish_id,
      p_ingredient_id: ing.ingredient_id,
      p_quantity: ing.quantity,
    });
    if (r.error) {
      // Un ingrédient refusé n'annule pas le catalogue : les produits sont
      // déjà écrits et servent. On ne remonte que le compte exact.
      recettes -= 1;
    }
  }

  // Les options des plats, comme les recettes : sans elles, la fiche d'un plat
  // affiche « Aucune option pour ce plat » et le serveur ne voit jamais ce que
  // l'application sait faire d'une double portion. Elles sont écrites après les
  // recettes, dans le même temps logique : le catalogue est « prêt à servir ».
  let options = 0;
  const optionsEcrites: {
    owner_id: string;
    product_id: string;
    name: string;
    extra_price: number;
  }[] = [];
  for (const a of catalogue) {
    if (!a.options?.length) continue;
    const dish = parNom.get(a.name.toLowerCase());
    if (!dish) continue;
    for (const o of a.options) {
      // owner_id, comme dans RecipesModule : la policy « modifiers_write »
      // le compare à get_business_owner_id(). Sans lui, la colonne NOT NULL
      // sans défaut et le with_check rejettent l'écriture en 403 — et le
      // catalogue d'exemple se charge, complet et muet, SANS SES OPTIONS.
      optionsEcrites.push({ owner_id: ownerId, product_id: dish, name: o.name, extra_price: o.extra });
    }
  }
  if (optionsEcrites.length > 0) {
    const r = await supabase.from('product_modifiers').insert(optionsEcrites);
    if (r.error) {
      // Même règle qu'un ingrédient refusé : le reste du catalogue tient debout.
      options = 0;
    } else {
      options = optionsEcrites.length;
    }
  }

  return { charges: lignes.length, recettes, options };
}

/**
 * Retire le catalogue d'exemple.
 *
 * Trois temps, dans cet ordre : les RECETTES d'abord, puis les produits, puis —
 * pour ceux qui ont été vendus — l'archivage.
 *
 * L'ordre n'est pas un détail. recipe_ingredients porte une clé étrangère vers
 * products : sans cette première passe, le DELETE des produits échoue en bloc,
 * et le repli « archiver » laisse les lignes en base. La bannière compte alors
 * toujours les exemples, et le commerçant ne peut plus jamais s'en débarrasser —
 * c'est-à-dire une promesse faite à l'écran et tenue seulement à moitié.
 *
 * Un article vendu n'est pas supprimé : le supprimer effacerait l'historique
 * d'une vente réelle. Il est archivé, donc invisible à la caisse, et la
 * bannière ne le compte plus.
 *
 * @returns le nombre supprimé, le nombre archivé, ou une phrase d'erreur.
 */
export async function removeStarterCatalog(
  supabase: SupabaseClient,
  ownerId: string
): Promise<{ supprimes: number; archives: number } | { erreur: string }> {
  const { data, error } = await supabase
    .from('products')
    .select('id')
    .eq('user_id', ownerId)
    .like('sku', `${DEMO_PREFIX}%`)
    .neq('is_active', false);
  if (error) return { erreur: error.message };

  const ids = ((data ?? []) as { id: string }[]).map((l) => l.id);
  if (ids.length === 0) return { supprimes: 0, archives: 0 };

  // ─── 1. Les recettes des plats retirés.
  // La policy recipes_write est un FOR ALL can_manage_products() : la
  // suppression directe est permise au patron, c'est le même geste que la
  // modifier dans l'écran Recettes.
  for (let i = 0; i < ids.length; i += 100) {
    const lot = ids.slice(i, i + 100);
    const r = await supabase.from('recipe_ingredients').delete().in('dish_id', lot);
    // Une erreur ici n'est pas bloquante : elle veut dire qu'il n'y avait pas
    // de recette, ou que le retrait des produits échouera et qu'on archivera.
    void r.error;
    const ing = await supabase.from('recipe_ingredients').delete().in('ingredient_id', lot);
    void ing.error;
  }

  // ─── 2. Les options des plats retirés.
  // La clé étrangère est en ON DELETE CASCADE, donc les options partent avec le
  // produit — mais un plat VENDU est archivé, pas supprimé, et ses options
  // resteraient attachées à un produit invisible. C'est le même piège que pour
  // les recettes, et la même raison de passer avant.
  for (let i = 0; i < ids.length; i += 100) {
    const lot = ids.slice(i, i + 100);
    const r = await supabase.from('product_modifiers').delete().in('product_id', lot);
    void r.error;
  }

  // ─── 3. Les produits.
  //
  // Les recettes d'abord (1), les options ensuite (2), les produits enfin : les
  // deux premières tables portent une clé étrangère vers products, et le DELETE
  // échouerait en bloc sans ces deux passages préalables.
  let supprimes = 0;
  let archives = 0;
  for (let i = 0; i < ids.length; i += 50) {
    const lot = ids.slice(i, i + 50);
    const r = await supabase.from('products').delete().in('id', lot).select('id');
    if (r.error) {
      for (const id of lot) {
        const a = await supabase.rpc('archive_product', { p_product_id: id });
        if (!a.error) archives += 1;
      }
    } else {
      supprimes += (r.data ?? []).length;
    }
  }

  return { supprimes, archives };
}

/** Le catalogue d'exemple est-il présent ? Base de la bannière de l'écran Stock. */
export async function hasStarterCatalog(
  supabase: SupabaseClient,
  ownerId: string
): Promise<number> {
  const { count, error } = await supabase
    .from('products')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', ownerId)
    .like('sku', `${DEMO_PREFIX}%`);
  if (error) return 0;
  return count ?? 0;
}

export { isDemoSku };