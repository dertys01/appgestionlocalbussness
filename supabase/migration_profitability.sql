-- ============================================================
-- MIGRATION PRODUITS ARCHIVÉS + MARGE — GestionLocal
-- À exécuter dans Supabase SQL Editor, après migration_roles.sql
--
-- 1. Archivage : la suppression définitive d'un produit est impossible dès
--    qu'il a été vendu (sale_items.product_id et stock_logs.product_id
--    référencent products sans ON DELETE CASCADE). Le message d'erreur
--    proposait « désactivez-le », mais aucune colonne n'existait : le chemin
--    était un cul-de-sac. Un produit vendu était donc immortel.
--
-- 2. Coût au moment de la vente : la marge n'était calculable qu'en
--    recoupant le prix d'achat actuel par nom de produit — donc fausse dès
--    qu'un prix changeait. On fige le coût dans sale_items.
-- ============================================================

-- ─── 1. Archivage des produits ─────────────────────────────
ALTER TABLE products ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
ALTER TABLE products ADD COLUMN IF NOT EXISTS archived_at timestamptz;

-- Un produit ne peut être archivé que s'il n'a jamais été vendu : sinon on
-- perdrait la cohérence de l'historique.
CREATE OR REPLACE FUNCTION archive_product(p_product_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner  uuid := get_business_owner_id();
  v_sold   integer;
BEGIN
  IF NOT can_manage_products() THEN
    RAISE EXCEPTION 'Droits insuffisants' USING ERRCODE = '42501';
  END IF;

  SELECT count(*) INTO v_sold FROM sale_items WHERE product_id = p_product_id;
  IF v_sold > 0 THEN
    RAISE EXCEPTION 'Impossible d''archiver : ce produit apparaît dans % vente(s). '
      'Mettez son stock à 0 et renommez-le « % (épuisé) ».', v_sold,
      (SELECT name FROM products WHERE id = p_product_id)
      USING ERRCODE = '23503';
  END IF;

  UPDATE products
     SET is_active = false, archived_at = now()
   WHERE id = p_product_id AND user_id = v_owner;
END;
$$;

-- Restauration (l'UI d'archivage n'existe pas encore, mais la porte reste ouverte).
CREATE OR REPLACE FUNCTION restore_product(p_product_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := get_business_owner_id();
BEGIN
  IF NOT can_manage_products() THEN
    RAISE EXCEPTION 'Droits insuffisants' USING ERRCODE = '42501';
  END IF;

  UPDATE products
     SET is_active = true, archived_at = NULL
   WHERE id = p_product_id AND user_id = v_owner;
END;
$$;

REVOKE ALL ON FUNCTION archive_product(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION archive_product(uuid) TO authenticated;
REVOKE ALL ON FUNCTION restore_product(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION restore_product(uuid) TO authenticated;

-- ─── 2. Coût figé au moment de la vente ────────────────────
-- Sans ce snapshot, la marge d'hier se recalculait avec le prix d'achat
-- d'aujourd'hui : silencieusement fausse.
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS unit_cost numeric(12,2);
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS product_id_archived uuid;

-- Remplissage rétroactif des lignes existantes.
UPDATE sale_items si
   SET unit_cost = p.price_buy,
       product_id_archived = si.product_id
  FROM products p
 WHERE p.id = si.product_id AND si.unit_cost IS NULL;

-- Empêche de modifier un coût après coup (traçabilité comptable).
CREATE OR REPLACE FUNCTION freeze_sale_item_cost()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF OLD.unit_cost IS DISTINCT FROM NEW.unit_cost
     AND OLD.sale_id IS NOT NULL THEN
    RAISE EXCEPTION 'Le coût au moment de la vente est figé (produit %, vente %)',
      OLD.product_name, OLD.sale_id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS sale_items_freeze_cost ON sale_items;
CREATE TRIGGER sale_items_freeze_cost
  BEFORE UPDATE ON sale_items
  FOR EACH ROW EXECUTE FUNCTION freeze_sale_item_cost();

-- ─── 3. Rentabilité par produit ───────────────────────────
--
-- Fonction et non vue : une VUE PostgREST s'exécute avec les droits de son
-- propriétaire et contourne la RLS de products. Filtrer explicitement par
-- get_business_owner_id() serait le remède, mais cela casse dès qu'aucun
-- utilisateur n'est résolu (clé service role : auth.uid() est NULL, vue vide),
-- et oblige à dupliquer la règle de tenancy.
--
-- Une fonction SECURITY INVOKER s'exécute avec les droits de l'appelant :
-- PostgREST applique donc les policies RLS de products et de sale_items, qui
-- gèrent déjà l'isolation. Aucun filtre à maintenir ici.
--
-- ⚠ DROP avant CREATE : la signature de retour a changé (avg_sold_price,
--   discount_given, units_sold_at_loss pour le prix négocié). PostgreSQL refuse
--   en 42P13 de remplacer une fonction dont le type de retour diffère — les
--   paramètres OUT font partie de la signature. Le DROP doit précéder, sinon
--   le script s'interrompt et le reste de la migration n'est pas appliqué.
DROP FUNCTION IF EXISTS get_product_profitability();

CREATE FUNCTION get_product_profitability()
RETURNS TABLE (
  id                 uuid,
  name               text,
  category           text,
  unit_cost          numeric(12,2),
  unit_price         numeric(12,2),
  stock_qty          integer,
  units_sold         bigint,
  revenue            numeric,
  cost_of_goods      numeric,
  gross_profit       numeric,
  margin_pct         numeric,
  -- Prix moyen réellement encaissé. Diffère de unit_price (catalogue courant)
  -- dès qu'une vente a été négociée : c'est ce prix-là qui a rapporté.
  avg_sold_price     numeric(12,2),
  -- Total concédé sur le produit, en FCFA.
  discount_given     numeric,
  -- Volume vendu sous le prix d'achat, en unités. Non nul = du stock écoulé
  -- à perte, ce qu'un commerçant doit voir sans que la vente soit bloquée.
  units_sold_at_loss bigint,
  -- Montant cédé à crédit et non encore encaissé, sur ce produit. N'entre pas
  -- dans revenue ni gross_profit : la recette à l'encaissement est le choix
  -- prudent, sinon un commerçant qui prête verrait son chiffre d'affaires
  -- gonflé par une dette qu'il ne recouvrera peut-être jamais.
  unsettled_credit numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    p.id,
    p.name,
    p.category,
    COALESCE(p.price_buy, 0)                     AS unit_cost,
    p.price_sell                                 AS unit_price,
    p.stock_qty,
    -- FAIT PHYSIQUE : tout ce qui est sorti, y compris cédé à crédit. Prévisions
    -- s'en sert pour estimer la rotation, et la marchandise est bien partie.
    COALESCE(SUM(si.quantity), 0)                AS units_sold,
    -- FAIT FINANCIER : ce qui est réellement rentré, au prorata de l'acompte.
    --
    -- Une vente de 130 000 dont 50 000 sont versés compte pour 50 000. Pas
    -- 130 000 (le commerçant n'a pas encaissé le reste) ni 0 (il a bien reçu
    -- 50 000, sa caisse ne peut pas être en désaccord avec son chiffre
    -- d'affaires). C'est de la base de caisse, appliquée ligne par ligne.
    --
    -- Le ratio est NULLIF sur total_amount : une vente gratuite — prix 0 —
    -- donnerait une division par zéro, et ferait échouer toute la requête.
    -- COALESCE le ramène à 0, ce qui est correct : rien n'a été encaissé.
    COALESCE(SUM(si.subtotal * COALESCE(s.amount_received / NULLIF(s.total_amount, 0), 0)), 0)
                                                        AS revenue,
    -- Le coût suit la même clé. Reconnaître la recette sans son coût donnerait
    -- une marge qui monte à chaque vente à crédit, ce qui est l'inverse de la
    -- réalité : le coût de la marchandise est engagé dès qu'elle sort.
    COALESCE(SUM(si.unit_cost * si.quantity * COALESCE(s.amount_received / NULLIF(s.total_amount, 0), 0)), 0)
                                                        AS cost_of_goods,
    COALESCE(SUM((si.subtotal - si.unit_cost * si.quantity) * COALESCE(s.amount_received / NULLIF(s.total_amount, 0), 0)), 0)
                                                        AS gross_profit,
    -- Le taux de marge est insensible au prorata : le ratio s'annule. Une vente
    -- à moitié encaissée affiche donc le VRAI taux de marge du produit, et non un
    -- taux dégradé par un encaissement partiel. C'est ce qu'un commerçant veut
    -- savoir : « sur ce produit, je gagne combien ».
    CASE
      WHEN COALESCE(SUM(si.subtotal * COALESCE(s.amount_received / NULLIF(s.total_amount, 0), 0)), 0) > 0
        THEN ROUND(
          100 * SUM((si.subtotal - si.unit_cost * si.quantity) * COALESCE(s.amount_received / NULLIF(s.total_amount, 0), 0))
          / SUM(si.subtotal * COALESCE(s.amount_received / NULLIF(s.total_amount, 0), 0)), 1)
      ELSE NULL
    END                                          AS margin_pct,
    -- Prix moyen RÉALISÉ par unité : chiffre d'affaires encaissé divisé par
    -- quantité vendue. Sur une vente à moitié payée, c'est la moitié du prix
    -- catalogue — c'est ce que le client a réellement payé pour ces unités.
    CASE
      WHEN COALESCE(SUM(si.quantity), 0) > 0
        THEN ROUND(
          SUM(si.subtotal * COALESCE(s.amount_received / NULLIF(s.total_amount, 0), 0))
          / SUM(si.quantity), 2)
      ELSE NULL
    END                                          AS avg_sold_price,
    -- list_price est NULL sur les ventes antérieures au prix négocié : on
    -- traite l'absence comme « pas de remise » plutôt que de fausser l'écart.
    COALESCE(SUM(
      (COALESCE(si.list_price, si.unit_price) - si.unit_price) * si.quantity
    ), 0)                                        AS discount_given,
    COALESCE(SUM(si.quantity) FILTER (
      WHERE si.unit_cost IS NOT NULL AND si.unit_price < si.unit_cost
    ), 0)                                        AS units_sold_at_loss,
    -- Informatif : ce qui reste dû sur ce produit. N'entre dans aucun total.
    --
    -- ⚠ La parenthèse de SUM se ferme AVANT le FILTER : c'est SUM(expr) FILTER
    --   (WHERE ...), pas SUM(expr FILTER (WHERE ...)). La seconde forme est un
    --   « syntax error at or near "FILTER" » sans indication de ligne, et le
    --   message ne dit rien de la parenthèse mal placée. Compter les parenthèses ne suffit
    --   pas : elles sont équilibrées dans les deux écritures.
    COALESCE(SUM(si.subtotal * (1 - COALESCE(s.amount_received / NULLIF(s.total_amount, 0), 0)))
                 FILTER (WHERE NOT s.settled), 0) AS unsettled_credit
  FROM products p
  LEFT JOIN sale_items si ON si.product_id = p.id
  -- La jointure sur sales est nécessaire pour lire amount_received. LEFT JOIN
  -- et non INNER : les produits sans vente doivent apparaître avec des zéros.
  LEFT JOIN sales s ON s.id = si.sale_id
  -- VERROU DE PLAN. Le cadenas du menu ne protège rien : cette fonction est
  -- appelable directement en RPC, et l'appel ne respecte aucun plan côté
  -- client. Sans cette condition, un client en plan gratuit obtient sa
  -- rentabilité — prix d'achat, prix de vente, marge unitaire — en appelant
  -- depuis la console du navigateur. Il paie 0 F ce qui vaut 3 000 F/mois.
  --
  -- `SELECT true FROM require_feature('reports')` renvoie true si le plan
  -- suffit, et lève une exception sinon. require_feature est VOLATILE, donc le
  -- planificateur ne peut pas l'écarter ni la calculer une fois pour toutes.
  -- Voir migration_plan_gate.sql.
  WHERE p.is_active
    AND (SELECT true FROM require_feature('reports'))
  -- Les produits archivés restent hors du tableau de bord : leur historique
  -- est conservé en base, ils ne sont plus pilotés.
  GROUP BY p.id, p.name, p.category, p.price_buy, p.price_sell, p.stock_qty;
$$;

COMMENT ON FUNCTION get_product_profitability() IS
  'Rentabilité par produit. L''isolation repose sur la RLS de products (SECURITY INVOKER). '
  'sale_items.unit_cost, figé au moment de la vente, fait foi pour l''historique.';

REVOKE ALL ON FUNCTION get_product_profitability() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_product_profitability() TO authenticated;
GRANT EXECUTE ON FUNCTION get_product_profitability() TO service_role;
