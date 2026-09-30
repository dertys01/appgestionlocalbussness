-- ============================================================
-- CORRECTIF MARGE — create_sale() ne figeait pas le coût
-- À exécuter dans Supabase SQL Editor
--
-- SYMPTÔME
--   Rapports → Rentabilité affiche « coût des marchandises 0 F », une marge
--   brute égale au chiffre d'affaires, un taux de 100 % et un tiret « — »
--   dans la colonne % de chaque produit.
--
-- CAUSE
--   sale_items.unit_cost est à NULL sur toutes les ventes.
--
--   L'ordre d'application des migrations masque le problème :
--     · migration_sales_rpc.sql     définit create_sale()
--     · migration_profitability.sql AJOUTE la colonne unit_cost, remplit
--                                  l'existant, et pose un trigger qui interdit
--                                  de la modifier ensuite
--
--   La deuxième migration ne redéfinit pas create_sale(). Or la version de
--   create_sale() déployée à l'époque écrivait déjà invoice_number mais pas
--   encore unit_cost. Chaque vente depuis lors a donc inséré une ligne sans
--   coût — et le trigger de figeage a ensuite interdit toute correction, ce
--   qui est le comportement voulu pour une comptabilité mais masque ici un
--   déploiement incomplet.
--
--   Ce n'est pas une erreur de saisie : un produit sans prix d'achat donnerait
--   0, jamais NULL. Le NULL prouve que la colonne n'était pas fournie.
--
-- CORRECTIF — deux parties
--   1. Ce fichier : remplir unit_cost des lignes existantes, puis recréer le
--      trigger de figeage.
--   2. migration_sales_rpc.sql, à réappliquer juste après : il redéfinit
--      create_sale() pour qu'il fige désormais le coût.
--
-- ⚠ L'étape 1 utilise le prix d'achat d'AUJOURD'HUI, pas celui du jour de la
--   vente : le historique devient approximatif. Acceptable pour des ventes de
--   test du jour. Sur une boutique avec de l'antériorité, il faut ressaisir
--   les coûts historiques.
-- ============================================================

-- ─── 1. Remplissage des coûts manquants ───────────────────
-- Le trigger interdit toute modification d'un coût déjà figé ; il refuse donc
-- aussi le remplissage des lignes vides. On le retire, on remplit, on le recrée.

DROP TRIGGER IF EXISTS sale_items_freeze_cost ON sale_items;

UPDATE sale_items si
   SET unit_cost = p.price_buy,
       product_id_archived = COALESCE(si.product_id_archived, si.product_id)
  FROM products p
 WHERE p.id = si.product_id
   AND si.unit_cost IS NULL;

-- Un produit supprimé (archivé puis retiré du catalogue) ne laisse plus de
-- ligne à rejoindre : sa vente historique reste sans coût, donc comptée à
-- 100 % de marge. Le signaler vaut mieux qu'un zéro silencieux.
--
-- SELECT p.name, count(*) AS ventes_sans_cout
--   FROM sale_items si
--   LEFT JOIN products p ON p.id = si.product_id
--  WHERE si.unit_cost IS NULL
--  GROUP BY p.name;

DROP TRIGGER IF EXISTS sale_items_freeze_cost ON sale_items;
CREATE TRIGGER sale_items_freeze_cost
  BEFORE UPDATE ON sale_items
  FOR EACH ROW EXECUTE FUNCTION freeze_sale_item_cost();

-- ─── 2. create_sale() doit de nouveau figer le coût ───────
-- Réappliquez migration_sales_rpc.sql juste après ce fichier. Il est
-- idempotent (CREATE OR REPLACE partout) et redéfinit create_sale() avec
-- l'insertion de unit_cost qui manquait à la version déployée.
--
-- Vérification après coup :
--
--   SELECT count(*) FILTER (WHERE unit_cost IS NULL) AS sans_cout,
--          count(*) AS total
--     FROM sale_items;
