-- ============================================================
-- migration_restaurant_price_trace.sql — prix catalogue figé sur la ligne de salle
-- À exécuter APRÈS migration_restaurant_finitions.sql
-- ============================================================
--
-- POURQUOI : `restaurant_order_items.unit_price` est écrit par le client (RLS
-- FOR ALL pour tout membre de l'équipe), et `close_table_order()` facture CE
-- prix. Un caissier pouvait donc insérer une ligne à 1 F et faire encaisser
-- 1 F — la recette prétendait le contraire, la base ne l'empêchait pas.
--
-- La parade est celle du comptoir (migration_price_override.sql) : le prix
-- catalogue est FIGÉ sur la ligne au moment de l'insertion, dans `list_price`.
-- Une concession reste possible — un patron peut offrir un plat — mais elle
-- devient VISIBLE (unit_price < list_price), au lieu de disparaître.
--
-- On n'interdit PAS unit_price < list_price : bloquer empêcherait d'offrir un
-- plat, comme bloquer la vente à perte empêcherait de solder un stock. C'est la
-- traçabilité qui protège, pas le verrou.
--
-- Rejouable : IF NOT EXISTS / DROP TRIGGER IF EXISTS / CREATE OR REPLACE.
-- ============================================================

ALTER TABLE restaurant_order_items
  ADD COLUMN IF NOT EXISTS list_price numeric(12,2);

COMMENT ON COLUMN restaurant_order_items.list_price IS
  'Prix catalogue du produit, figé à l''insertion de la ligne. Rendu visible '
  'quand unit_price lui est inférieur : la concession reste traçable.';

CREATE OR REPLACE FUNCTION restaurant_order_items_set_list_price()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  SELECT p.price_sell INTO NEW.list_price
    FROM products p
   WHERE p.id = NEW.product_id;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION restaurant_order_items_set_list_price() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION restaurant_order_items_set_list_price() TO authenticated, service_role;

DROP TRIGGER IF EXISTS restaurant_order_items_list_price ON restaurant_order_items;
CREATE TRIGGER restaurant_order_items_list_price
  BEFORE INSERT ON restaurant_order_items
  FOR EACH ROW EXECUTE FUNCTION restaurant_order_items_set_list_price();
