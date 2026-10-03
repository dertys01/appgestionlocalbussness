-- ============================================================
-- MIGRATION : Synthèse des ventes
-- A exécuter dans Supabase SQL Editor
-- ============================================================
--
-- Rapports et Historique additionnaient les ventes côté JavaScript : ils
-- téléchargeaient sales + sale_items(*) sur TOUTE la période demandée, puis
-- faisaient les comptes dans le navigateur.
--
-- Le rendu, lui, était déjà borné — 20 lignes par page sur l'historique, lots
-- de 50 sur les charges. Ce qui n'avait aucune borne, c'est le téléchargement.
--
--   free     30 jours
--   starter  365 jours
--   pro      Infinity      <- et le programme bêta donne l'accès complet
--
-- Sur pro, la requête grandit sans limite pendant toute la vie de la boutique,
-- et c'est précisément le cas des boutiques bêta.
--
-- Les agrégats PostgREST sont refusés sur ce projet (PGRST123 « Use of
-- aggregate functions is not allowed ») : aucun contournement possible sans
-- SQL.
--
-- Deux précautions, et aucune n'est cosmétique :
--
--   · Base de calcul. Les rapports additionnent sales.total_amount, le prix
--     de vente. get_cash_flow() additionne amount_received, l'argent
--     réellement entré — les crédits y valent leur acompte. Les deux sont
--     justes : ils ne mesurent pas la même chose. Réutiliser get_cash_flow()
--     aurait changé les chiffres affichés à l'écran.
--
--   · Fuseau. Le client calcule les jours avec new Date().getDate(), donc
--     dans LE FUSEAU DU NAVIGATEUR, alors que SQL calcule dans celui de la
--     session. Décaler d'une case, c'est décaler les barres du graphique.
--     Le fuseau passe donc en paramètre.
-- ============================================================


-- ─── 1. Synthèse journalière ──────────────────────────────
-- Une ligne par jour de vente, et non une seule ligne de période : le client
-- regroupe ensuite en jours/semaines/mois avec la même bucketKey() qu'avant,
-- donc la forme du graphique ne bouge pas.
CREATE OR REPLACE FUNCTION get_sales_summary(
  p_from date,
  p_to   date,
  p_tz   text DEFAULT 'UTC'
)
RETURNS TABLE (
  day     date,
  revenue numeric,
  cash    numeric,
  momo    numeric,
  tx      bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    (s.created_at AT TIME ZONE p_tz)::date                       AS day,
    COALESCE(SUM(s.total_amount), 0)                             AS revenue,
    COALESCE(SUM(CASE WHEN s.payment_method = 'cash'
                      THEN s.total_amount ELSE 0 END), 0)        AS cash,
    COALESCE(SUM(CASE WHEN s.payment_method = 'momo'
                      THEN s.total_amount ELSE 0 END), 0)        AS momo,
    COUNT(*)                                                     AS tx
  FROM sales s
  -- Bornes exprimées en instants, pas en dates : une condition du type
  -- `(created_at AT TIME ZONE p_tz)::date BETWEEN` n'est pas sargable, elle
  -- forcerait Postgres à relire toute la table du client — on aurait déplacé
  -- le coût sans le supprimer. Ces deux bornes décrivent exactement la même
  -- période que le GROUP BY, transition d'heure d'été comprise.
  WHERE s.created_at >= (p_from::timestamp AT TIME ZONE p_tz)
    AND s.created_at <  ((p_to + 1)::timestamp AT TIME ZONE p_tz)
  GROUP BY 1
  ORDER BY 1;
$$;

REVOKE ALL ON FUNCTION get_sales_summary(date, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION get_sales_summary(date, date, text) TO authenticated;
GRANT EXECUTE ON FUNCTION get_sales_summary(date, date, text) TO service_role;


-- ─── 2. Produits les plus vendus ──────────────────────────
-- Le top 6 par quantité, calculé sur sale_items : c'est ce que faisait
-- côte client `sort().slice(0, 6)` en parcourant toutes les lignes de vente.
CREATE OR REPLACE FUNCTION get_top_products(
  p_from  date,
  p_to    date,
  p_tz    text DEFAULT 'UTC',
  p_limit int  DEFAULT 6
)
RETURNS TABLE (
  product_name text,
  qty          numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT si.product_name,
         COALESCE(SUM(si.quantity), 0) AS qty
  FROM sale_items si
  JOIN sales s ON s.id = si.sale_id
  WHERE s.created_at >= (p_from::timestamp AT TIME ZONE p_tz)
    AND s.created_at <  ((p_to + 1)::timestamp AT TIME ZONE p_tz)
  GROUP BY si.product_name
  -- Clé de départage : deux produits ex aequo affichaient un ordre arbitraire
  -- côté client, qui changeait d'un rendu à l'autre.
  ORDER BY COALESCE(SUM(si.quantity), 0) DESC, si.product_name
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 6), 1), 100);
$$;

REVOKE ALL ON FUNCTION get_top_products(date, date, text, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION get_top_products(date, date, text, int) TO authenticated;
GRANT EXECUTE ON FUNCTION get_top_products(date, date, text, int) TO service_role;


-- Pas de garde de plan sur ces deux fonctions, contrairement à
-- get_cash_flow() : elles n'additionnent que des lignes que l'appelant peut
-- déjà SELECTer sous RLS. Le plafond de plan sur les rapports reste appliqué
-- à l'écran, comme il l'était avant — ajouter la garde ici couperait
-- l'historique des ventes aux comptes gratuits, qui n'ont jamais été privés
-- de leur propre total.
--
-- ─── Note sur les REVOKE ───────────────────────────────────
-- Ils ciblent `anon` explicitement, pas seulement PUBLIC, et ce n'est pas de
-- la prudence en l'air. Supabase pose des privilèges par défaut DIRECTS sur
-- anon, authenticated et service_role (ALTER DEFAULT PRIVILEGES) : le grant
-- ne vient pas de PUBLIC. `REVOKE ... FROM PUBLIC` seul y laisse donc la clé
-- anonyme parfaitement capable d'appeler la fonction — ce qui est exactement
-- ce qui est arrivé en production aux 36 autres fonctions du schéma public,
-- malgré des REVOKE écrits partout dans les migrations. Vérifié en base le
-- 03/10/2026.
