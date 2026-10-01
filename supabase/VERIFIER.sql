-- ============================================================
-- VÉRIFICATION — à coller dans Supabase SQL Editor après APPLY_MIGRATIONS.sql
-- ============================================================
-- Un script peut s'exécuter sans erreur en laissant des choses à moitié faites.
-- Ce fichier liste ce qui doit exister, et signale ce qui manque.
--
-- Attendu : une seule ligne, « OK ».
-- Si des lignes manquent, elles sont nommées en clair dans la colonne detail.
-- ============================================================

WITH attendus AS (
  -- Colonnes ajoutées par les dernières migrations
  SELECT 'sales.settled'              AS objet, 'colonne' AS type
  UNION ALL SELECT 'sales.client_phone',        'colonne'
  UNION ALL SELECT 'products.unit',             'colonne'
  UNION ALL SELECT 'sale_items.list_price',     'colonne'
  UNION ALL SELECT 'products.supplier_id',      'colonne'

  -- Tables
  UNION ALL SELECT 'customer_debts',            'table'
  UNION ALL SELECT 'credit_payments',           'table'
  UNION ALL SELECT 'suppliers',                 'table'
  UNION ALL SELECT 'employee_invitations',      'table'
  UNION ALL SELECT 'expenses',                  'table'

  -- Vue : bloque l'ALTER du poids si elle a disparu
  UNION ALL SELECT 'products_with_supplier',    'vue'

  -- Fonctions
  UNION ALL SELECT 'record_credit_sale',        'fonction'
  UNION ALL SELECT 'pay_customer_debt',         'fonction'
  UNION ALL SELECT 'get_customer_debts',        'fonction'
  UNION ALL SELECT 'normalize_phone',           'fonction'
  UNION ALL SELECT 'create_sale',               'fonction'
  UNION ALL SELECT 'get_product_profitability', 'fonction'
  UNION ALL SELECT 'get_cash_flow',             'fonction'
  UNION ALL SELECT 'redeem_invitation',         'fonction'
)
SELECT
  a.objet,
  a.type,
  CASE
    WHEN a.type = 'colonne' THEN
      CASE WHEN EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name = split_part(a.objet, '.', 1)
           AND column_name = split_part(a.objet, '.', 2)) THEN 'OK'
           ELSE 'MANQUANT' END
    WHEN a.type = 'table' THEN
      CASE WHEN to_regclass('public.' || a.objet) IS NOT NULL THEN 'OK'
           ELSE 'MANQUANT' END
    WHEN a.type = 'vue' THEN
      CASE WHEN EXISTS (SELECT 1 FROM pg_views
                         WHERE viewname = a.objet) THEN 'OK'
           ELSE 'MANQUANT' END
    ELSE
      CASE WHEN EXISTS (SELECT 1 FROM pg_proc
                         WHERE proname = a.objet) THEN 'OK'
           ELSE 'MANQUANT' END
  END AS etat
FROM attendus a
ORDER BY (a.type = 'colonne'), a.objet;


-- ============================================================
-- 2. Points de vigilance : des divergences silencieuses
-- ============================================================
-- Les 18 migrations se réappliquent sans erreur, mais un détail peut rester
-- incohérent sans que PostgreSQL ne signale rien. Ces quatre contrôles le
-- vérifient. Attendu : quatre lignes, toutes « OK ».
-- ============================================================

-- A. La vente au poids : le type doit être NUMERIC partout. Un integer ici
--    signifie que 1,5 kg sera refusé à la vente — l'erreur n'apparaîtra qu'en
--    caisse, pas à l'application de la migration.
SELECT 'poids : sale_items.quantity' AS controle,
       data_type AS valeur_attendue,
       CASE WHEN data_type = 'numeric' THEN 'OK' ELSE 'A CORRIGER' END AS etat
  FROM information_schema.columns
 WHERE table_name = 'sale_items' AND column_name = 'quantity'
UNION ALL
SELECT 'poids : products.stock_qty', data_type,
       CASE WHEN data_type = 'numeric' THEN 'OK' ELSE 'A CORRIGER' END
  FROM information_schema.columns
 WHERE table_name = 'products' AND column_name = 'stock_qty'
UNION ALL
-- B. La vue doit rester en security_invoker. En DEFINER, elle contourne la RLS
--    et expose le catalogue des autres boutiques.
SELECT 'vue : security_invoker',
       coalesce(array_to_string(c.reloptions, ','), '(aucune option)'),
       CASE WHEN coalesce(c.reloptions::text, '') LIKE '%security_invoker=true%'
            THEN 'OK' ELSE 'A CORRIGER' END
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relname = 'products_with_supplier' AND n.nspname = 'public'
UNION ALL
-- C. La dernière version de create_sale() doit accepter le crédit. Elle est
--    réécrite en entier par trois migrations : c'est l'ordre qui décide de la
--    version qui reste en base, et se tromper ne lève aucune erreur — la vente
--    passe, mais « 1,5 kg » ou le crédit sont refusés.
SELECT 'create_sale : version credit',
       CASE WHEN p.prosrc LIKE '%credit.internal%' THEN 'credit + decimal'
            ELSE 'ancienne version' END,
       CASE WHEN p.prosrc LIKE '%credit.internal%'
             AND p.prosrc LIKE '%list_price%'
            THEN 'OK' ELSE 'A CORRIGER' END
  FROM pg_proc p
 WHERE p.proname = 'create_sale'
 ORDER BY 3;
