-- ============================================================
-- MIGRATION RESTAURATION : RECETTES ET COÛT DE MATIÈRE
-- À exécuter dans Supabase SQL Editor, après migration_table_checkout.sql
--
-- LE PROBLÈME
--   L'application ne vend que des produits finis. « Poulet braisé » est un
--   produit à 4 500 F, et sa marge affichée est 4 500 − prix_achat. Or un
--   patron ne rachète pas de « poulet braisé » : il rachète du poulet, du riz,
--   de l'huile. Sans recette, sa rentabilité est une fiction — et c'est
--   précisément le KPI d'un restaurant.
--
-- CE QUE CELA CHANGE
--   Un produit peut avoir une RECETTE : une liste d'ingrédients, avec la
--   quantité nécessaire pour UNE portion. Le coût d'un plat devient la somme
--   des coûts de ses ingrédients, et il part de là pour chaque ingredient :
--
--     Riz blanc (recette : 300 g riz, 1 c. huile)
--       └─ Poulet braisé (recette : 150 g riz, 1 c. huile, 200 g poulet)
--
--   Le riz des deux est additionné : vendre un poulet consomme ce que les
--   deux plats demandent. Une recette peut donc contenir un autre plat.
--
-- MISE EN ŒUVRE — deux déclencheurs, pas une réécriture de create_sale()
--   1. sale_items_set_unit_cost   AVANT INSERT : le coût figé de la ligne est
--      le coût de la RECETTE quand le produit en a une, sinon le prix
--      d'achat. `unit_cost` étant figé à la vente, la rentabilité historique
--      reste vraie même si la recette change demain — c'est le principe déjà
--      posé par migration_profitability.sql, appliquée au plat.
--   2. sale_items_consume_ingredients APRÈS INSERT : les stocks
--      d'ingrédients sont décrémentés, et le journal écrit.
--
--   Pourquoi un déclencheur et non une nouvelle create_sale() ? Réécrire cette
--   fonction — 150 lignes, le cœur de la caisse — pour y ajouter deux lignes
--   serait le moyen le plus sûr de la casser. Le déclencheur s'exécute DANS la
--   transaction de la vente : s'il lève, tout est annulé, vente comprise. On
--   obtient l'atomicité recherchée sans toucher au chemin critique.
--
-- ⚠ CE QUE CELA NE FAIT PAS
--   Le stock d'un PLAT n'est pas décrémenté par la recette : un plat se
--   cuisine, il ne se stocke pas. C'est aussi pour cela que create_sale()
--   (migration_weighted_sales.sql) NE CONTRÔLE PAS et NE DÉCRÉMENTE PAS le
--   stock d'un produit qui a une recette : sa disponibilité vient d'ici, et son
--   propre stock n'est qu'un champ libre pour un patron qui veut suivre ses
--   plats en portions.
--
--   Ces deux règles ont d'abord été écrites séparément, et create_sale()
--   contredisait celle-ci : un plat à 0 — sa valeur naturelle — était refusé à
--   la vente. Trouvé en recette navigateur le 05/10/2026, sur un maquis neuf.
-- ============================================================

-- ─── 1. Les recettes ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS recipe_ingredients (
  dish_id       uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  ingredient_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  -- Quantité d'ingrédient pour UNE portion du plat.
  quantity      numeric(12,3) NOT NULL CHECK (quantity > 0),
  created_at    timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (dish_id, ingredient_id),
  -- Un plat ne peut pas être son propre ingrédient, direct ou indirect :
  -- « poulet braisé composé de poulet braisé » créerait une boucle infinie
  -- dans le calcul de coût. La détection du cycle DIRECT est ici ; celle des
  -- cycles INDIRECTS est faite par add_recipe_ingredient(), qui refuse une
  -- fermeture de boucle — une contrainte SQL ne peut pas remonter l'arbre.
  CONSTRAINT recipe_ingredients_no_self CHECK (dish_id <> ingredient_id)
);

CREATE INDEX IF NOT EXISTS idx_recipe_ingredients_dish
  ON recipe_ingredients(dish_id);
CREATE INDEX IF NOT EXISTS idx_recipe_ingredients_ingredient
  ON recipe_ingredients(ingredient_id);

-- ─── 2. RLS ─────────────────────────────────────────────────
ALTER TABLE recipe_ingredients ENABLE ROW LEVEL SECURITY;

-- Lecture : tout membre du tenant voit les recettes. C'est nécessaire au
-- calcul de coût affiché dans les rapports.
DROP POLICY IF EXISTS "recipes_read" ON recipe_ingredients;
CREATE POLICY "recipes_read" ON recipe_ingredients
  FOR SELECT USING (
    get_business_owner_id() IN (
      SELECT p.user_id FROM products p WHERE p.id = recipe_ingredients.dish_id
    )
  );

-- Écriture : patron ou manager, comme la salle. Un caissier peut vendre un
-- plat, il ne réécrit pas la carte.
DROP POLICY IF EXISTS "recipes_write" ON recipe_ingredients;
CREATE POLICY "recipes_write" ON recipe_ingredients
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM products p
       WHERE p.id = recipe_ingredients.dish_id
         AND p.user_id = get_business_owner_id()
         AND can_manage_products()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM products p
       WHERE p.id = recipe_ingredients.dish_id
         AND p.user_id = get_business_owner_id()
         AND can_manage_products()
    )
  );

-- ─── 3. Le coût d'un produit ────────────────────────────────
-- Récursif : un plat peut contenir un plat. La profondeur est bornée à 10
-- niveaux — au-delà, c'est une erreur de saisie, pas une recette.
--
-- SECURITY INVOKER : elle ne fait que lire products et recipe_ingredients,
-- dont les policies garantissent l'isolation. Une fonction SECURITY DEFINER
-- ici laisserait un restaurant lire les coûts d'un autre.
CREATE OR REPLACE FUNCTION product_cost(
  p_product_id uuid,
  p_depth      int DEFAULT 0
)
RETURNS numeric(12,2)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_cost   numeric(12,2);
  v_direct numeric(12,2);
BEGIN
  IF p_depth > 10 THEN
    -- Plutôt qu'une erreur, on s'arrête : une recette circulaire ne doit pas
    -- rendre la page Rentabilité inutilisable. Le coût renvoie alors 0 pour le
    -- niveau fautif, ce qui signale un problème sans bloquer la vente.
    RETURN 0;
  END IF;

  SELECT COALESCE(sum(r.quantity * product_cost(r.ingredient_id, p_depth + 1)), 0)
    INTO v_direct
    FROM recipe_ingredients r
   WHERE r.dish_id = p_product_id;

  IF v_direct > 0 THEN
    RETURN round(v_direct, 2);
  END IF;

  SELECT COALESCE(price_buy, 0) INTO v_cost FROM products WHERE id = p_product_id;
  RETURN round(COALESCE(v_cost, 0), 2);
END;
$$;

REVOKE ALL ON FUNCTION product_cost(uuid, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION product_cost(uuid, int) TO authenticated, service_role;

COMMENT ON FUNCTION product_cost(uuid, int) IS
  'Coût de revient d''une portion : somme des ingrédients (récursif) si le '
  'produit a une recette, sinon son prix d''achat. Profondeur bornée à 10 pour '
  'qu''une recette circulaire ne boucle pas.';

-- ─── 4. Coût figé sur la ligne de vente ─────────────────────
-- AVANT INSERT : remplace le prix d'achat par le coût de recette quand le
-- produit en a une. Sans ce déclencheur, la marge d'un plat resterait
-- 4 500 − prix_achat, c'est-à-dire exactement le problème qu'on voulait
-- résoudre.
CREATE OR REPLACE FUNCTION sale_items_set_unit_cost()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_recette numeric(12,2);
BEGIN
  IF NEW.unit_cost IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT product_cost(NEW.product_id) INTO v_recette;

  -- Un produit SANS recette rend price_buy : on ne touche à rien, c'est déjà
  -- ce que create_sale() a posé. Sans ce test, une vente de 0 F se verrait
  -- attribuer un coût arbitraire.
  IF v_recette > 0 THEN
    NEW.unit_cost := v_recette;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sale_items_apply_recipe_cost ON sale_items;
CREATE TRIGGER sale_items_apply_recipe_cost
  BEFORE INSERT ON sale_items
  FOR EACH ROW EXECUTE FUNCTION sale_items_set_unit_cost();

-- ─── 5. Décrément des ingrédients ───────────────────────────
-- APRÈS INSERT : chaque ingrédient de la recette part, et le journal est
-- écrit. Le trigger lève si un ingrédient manque — ce qui annule TOUTE la
-- vente, ligne d'en-tête comprise : commander 5 plats dont il manque le poulet
-- doit échouer, pas créer une vente sans plat.
--
-- Le même ingrédient peut apparaître dans deux plats vendus sur la même vente :
-- chaque déclencheur le décrémente. L'ordre n'a pas d'importance, l'addition
-- est commutative, et le verrou de ligne de chaque produit sérialise les
-- écritures concurrentes.
CREATE OR REPLACE FUNCTION sale_items_consume_ingredients()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_row     record;
  v_stock   numeric(12,3);
  v_nom     text;
  v_qte     numeric(12,3);
BEGIN
  FOR v_row IN
    SELECT ri.ingredient_id, ri.quantity * NEW.quantity AS needed
      FROM recipe_ingredients ri
     WHERE ri.dish_id = NEW.product_id
  LOOP
    SELECT p.stock_qty, p.name INTO v_stock, v_nom
      FROM products p
     WHERE p.id = v_row.ingredient_id
       -- RLS filtre ici : un ingrédient d'un autre restaurant est invisible et
       -- ne sera donc jamais décrémenté. C'est le comportement voulu.
       AND p.user_id = get_business_owner_id()
     FOR UPDATE;

    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    v_qte := v_row.needed;

    IF v_stock < v_qte THEN
      RAISE EXCEPTION 'Stock insuffisant pour l''ingrédient « % » (disponible : %, nécessaire : %)',
        v_nom, v_stock, v_qte USING ERRCODE = '23514';
    END IF;

    UPDATE products SET stock_qty = stock_qty - v_qte WHERE id = v_row.ingredient_id;

    INSERT INTO stock_logs (
      user_id, product_id, product_name, movement_type,
      quantity_change, stock_before, stock_after, reference_id
    )
    SELECT p.user_id, p.id, p.name, 'sale', -v_qte, v_stock, v_stock - v_qte, NEW.sale_id
      FROM products p
     WHERE p.id = v_row.ingredient_id;

  END LOOP;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sale_items_consume_recipe ON sale_items;
CREATE TRIGGER sale_items_consume_recipe
  AFTER INSERT ON sale_items
  FOR EACH ROW EXECUTE FUNCTION sale_items_consume_ingredients();

-- ─── 6. Écriture de recette, avec refus des cycles ──────────
-- Le client ne peut pas écrire directement : il doit passer par cette
-- fonction. Elle refuse l'ajout qui fermerait une boucle
-- (« poulet braisé » composé de « riz blanc » qui contient déjà le poulet
-- braisé), ce que la contrainte CHECK ne peut pas voir.
CREATE OR REPLACE FUNCTION add_recipe_ingredient(
  p_dish_id       uuid,
  p_ingredient_id uuid,
  p_quantity      numeric(12,3)
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
BEGIN
  v_owner := get_business_owner_id();
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Non authentifié' USING ERRCODE = '28000';
  END IF;

  IF NOT can_manage_products() THEN
    RAISE EXCEPTION 'Seul le patron ou un manager peut modifier une recette'
      USING ERRCODE = '42501';
  END IF;

  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'Quantité d''ingrédient invalide' USING ERRCODE = '22023';
  END IF;

  -- Les deux produits doivent exister ET être du tenant : un ingrédient d'un
  -- autre restaurant ne serait jamais décrémenté (RLS), et la marge mentirait.
  IF NOT EXISTS (SELECT 1 FROM products WHERE id = p_dish_id AND user_id = v_owner) THEN
    RAISE EXCEPTION 'Plat introuvable' USING ERRCODE = 'P0002';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM products WHERE id = p_ingredient_id AND user_id = v_owner) THEN
    RAISE EXCEPTION 'Ingrédient introuvable' USING ERRCODE = 'P0002';
  END IF;

  -- Cycle direct.
  IF p_dish_id = p_ingredient_id THEN
    RAISE EXCEPTION 'Un plat ne peut pas être son propre ingrédient' USING ERRCODE = '22023';
  END IF;

  -- Cycle indirect : l'ingrédient proposé CONTIENT-il déjà le plat ?
  -- Exemple : « poulet sauté » (plat) contient « poulet braisé ». Si on
  -- voulait ajouter « poulet braisé » à la recette de « poulet braisé » avec
  -- « poulet sauté » comme ingrédient, la boucle serait
  -- braisé → sauté → braisé.
  --
  -- On descend donc de l'ingrédient vers SES ingrédients (dish_id = a.id),
  -- et non l'inverse : remonter trouverait qui utilise l'ingrédient, ce qui
  -- répond à une autre question et laisse passer le cycle réel.
  IF EXISTS (
    WITH RECURSIVE arbre(id, prof) AS (
      SELECT p_ingredient_id, 0
      UNION ALL
      SELECT ri.ingredient_id, a.prof + 1
        FROM recipe_ingredients ri
        JOIN arbre a ON ri.dish_id = a.id
       WHERE a.prof < 10
    )
    SELECT 1 FROM arbre WHERE id = p_dish_id
  ) THEN
    RAISE EXCEPTION 'Cet ingrédient contient déjà ce plat : la recette formerait un cercle'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO recipe_ingredients (dish_id, ingredient_id, quantity)
  VALUES (p_dish_id, p_ingredient_id, p_quantity)
  ON CONFLICT (dish_id, ingredient_id)
  DO UPDATE SET quantity = EXCLUDED.quantity;
END;
$$;

REVOKE ALL ON FUNCTION add_recipe_ingredient(uuid, uuid, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION add_recipe_ingredient(uuid, uuid, numeric) TO authenticated;

-- ─── 7. Vue : marge par plat ────────────────────────────────
-- Le coût de recette et le prix de vente sur une seule ligne. C'est ce que
-- l'écran Recettes affiche, et ce qui distingue un restaurant d'un commerce :
-- le coût vient de la recette, pas d'un prix d'achat posé à la main.
-- DROP puis CREATE : la colonne `stock_qty` est insérée ENTRE price_sell et
-- unit_cost, et PostgreSQL refuse de réordonner les colonnes d'une vue
-- existante (« cannot change name of view column unit_cost to stock_qty »).
-- La vue ne porte aucun état : la recréer est sans risque.
DROP VIEW IF EXISTS recipe_costs;

CREATE VIEW recipe_costs
WITH (security_invoker = true)
AS
SELECT
  p.id,
  p.user_id,
  p.name,
  p.category,
  p.price_sell,
  -- stock_qty : la recette sert à deux choses — calculer la marge, et dire au
  -- patron « cet ingrédient ne suffit pas pour une portion ». Sans le stock,
  -- l'écran Recettes ne peut pas afficher l'alerte de rupture. La colonne a
  -- manque à la première version : l'écran affichait « column recipe_costs.
  -- stock_qty does not exist » puis, pire, un état vide « aucun plat ».
  p.stock_qty,
  p.unit,
  product_cost(p.id)                          AS unit_cost,
  round(p.price_sell - product_cost(p.id), 2) AS margin,
  CASE WHEN product_cost(p.id) > 0
       THEN round(100 * (p.price_sell - product_cost(p.id)) / p.price_sell, 1)
       ELSE NULL END                          AS margin_pct,
  (SELECT count(*) FROM recipe_ingredients r WHERE r.dish_id = p.id) AS ingredient_count
FROM products p
WHERE p.is_active;

COMMENT ON VIEW recipe_costs IS
  'Coût de revient et marge par produit. Le coût vient de la recette quand elle '
  'existe, du prix d''achat sinon. security_invoker : l''isolation reste celle '
  'des policies de products et recipe_ingredients.';

REVOKE ALL ON recipe_costs FROM anon;
GRANT SELECT ON recipe_costs TO authenticated, service_role;