-- ============================================================
-- MIGRATION RESTAURATION : CARTE PAR JOUR DE LA SEMAINE
-- À exécuter dans Supabase SQL Editor, après migration_restaurant_finitions.sql
--
-- `is_daily_special` (Sprint 16) est un drapeau simple : il dit « servi
-- aujourd'hui », et rien de plus. Un vrai restaurant ne sert pas le même plat
-- le mardi et le vendredi — le poisson le vendredi, la viande le samedi, le
-- poulet braisé tous les jours. Un simple booléen oblige le patron à
-- modifier la carte chaque matin, ce qu'il ne fera pas : la carte affichée
-- proposerait des plats qu'on ne cuisine pas.
--
-- menu_days : un tableau de jours de semaine, 0 = dimanche … 6 = samedi.
-- NULL = tous les jours — c'est le cas d'un plat de base, et le défaut, pour
-- qu'un plat créé depuis Stock (hors module restaurant) reste disponible sans
-- avoir à le configurer.
--
-- Le choix se fait dans l'interface par cases à cocher, jamais par une saisie
-- de nombres : un patron ne pense pas « 3, 4 et 5 ».
-- ============================================================

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS menu_days int[];

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'products_menu_days_valid'
  ) THEN
    ALTER TABLE products
      ADD CONSTRAINT products_menu_days_valid
      CHECK (menu_days IS NULL OR (
        cardinality(menu_days) BETWEEN 1 AND 7
        AND menu_days <@ ARRAY[0, 1, 2, 3, 4, 5, 6]
      ));
  END IF;
END;
$$;

COMMENT ON COLUMN products.menu_days IS
  'Jours de service, 0 = dimanche … 6 = samedi. NULL = tous les jours. '
  'Une carte qui propose un plat non servi est pire qu''une carte courte : '
  'le client commande ce qu''il voit.';

-- ─── Vue de la carte du jour ─────────────────────────────────
-- La salle ne liste QUE ce qui se cuisine aujourd'hui. Sans elle, chaque
-- commande du service passe par un filtre côté navigateur, et une tablesans
-- filtre — un export, un script, l'écran d'inventaire — proposerait à tort le
-- plat du mardi le mardi matin.
CREATE OR REPLACE VIEW restaurant_menu_today
WITH (security_invoker = true)
AS
SELECT
  p.id,
  p.user_id,
  p.name,
  p.category,
  p.price_sell,
  p.stock_qty,
  p.unit,
  p.is_daily_special,
  p.menu_days,
  -- NULL = tous les jours. extract(dow) donne 0 pour dimanche.
  (p.menu_days IS NULL
    OR (extract(dow FROM now())::int) = ANY (p.menu_days)) AS servi_aujourdhui,
  (SELECT count(*) FROM recipe_ingredients r WHERE r.dish_id = p.id) AS ingredient_count,
  product_cost(p.id) AS unit_cost
FROM products p
WHERE p.is_active;

COMMENT ON VIEW restaurant_menu_today IS
  'Carte du jour : les plats servis AUJOURD''HUI. security_invoker : '
  'l''isolation reste celle des policies de products.';

REVOKE ALL ON restaurant_menu_today FROM anon;
GRANT SELECT ON restaurant_menu_today TO authenticated, service_role;