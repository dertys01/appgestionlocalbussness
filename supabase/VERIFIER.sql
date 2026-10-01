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
  UNION ALL SELECT 'sales.amount_received',     'colonne'
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
  UNION ALL SELECT 'current_org_plan',          'fonction'
  UNION ALL SELECT 'require_feature',           'fonction'
  UNION ALL SELECT 'get_units_sold_since',      'fonction'

  -- Programme bêta
  UNION ALL SELECT 'beta_program',              'table'
  UNION ALL SELECT 'beta_access',               'table'
  UNION ALL SELECT 'beta_claim_slot',           'fonction'
  UNION ALL SELECT 'beta_record_access',        'fonction'
  UNION ALL SELECT 'beta_status',               'fonction'
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
SELECT 'poids : products.stock_qty' AS controle, data_type AS valeur_attendue,
       CASE WHEN data_type = 'numeric' THEN 'OK' ELSE 'A CORRIGER' END AS etat
  FROM information_schema.columns
 WHERE table_name = 'products' AND column_name = 'stock_qty'
UNION ALL
-- B. La vue doit rester en security_invoker. En DEFINER, elle contourne la RLS
--    et expose le catalogue des autres boutiques.
SELECT 'vue : security_invoker' AS controle,
       coalesce(array_to_string(c.reloptions, ','), '(aucune option)') AS valeur_attendue,
       CASE WHEN coalesce(c.reloptions::text, '') LIKE '%security_invoker=true%'
            THEN 'OK' ELSE 'A CORRIGER' END AS etat
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relname = 'products_with_supplier' AND n.nspname = 'public'
UNION ALL
-- C. La dernière version de create_sale() doit accepter le crédit. Elle est
--    réécrite en entier par trois migrations : c'est l'ordre qui décide de la
--    version qui reste en base, et se tromper ne lève aucune erreur — la vente
--    passe, mais « 1,5 kg » ou le crédit sont refusés.
SELECT 'create_sale : version credit' AS controle,
       CASE WHEN p.prosrc LIKE '%credit.internal%' THEN 'credit + decimal'
            ELSE 'ancienne version' END AS valeur_attendue,
       CASE WHEN p.prosrc LIKE '%credit.internal%'
             AND p.prosrc LIKE '%list_price%'
            THEN 'OK' ELSE 'A CORRIGER' END AS etat
  FROM pg_proc p
 WHERE p.proname = 'create_sale'
UNION ALL
-- D. L'unicité du numéro de facture doit être PAR BOUTIQUE. Un index global
--    faisait échouer la vente de la deuxième boutique Pro : le compteur est
--    propre à chaque boutique, donc deux commerces produisent le même numéro.
--    Symptôme : « duplicate key value violates unique constraint
--    idx_sales_invoice_number » et une caisse morte.
SELECT 'facture : unicite par boutique' AS controle,
       coalesce((SELECT string_agg(a.attname, ' + ' ORDER BY k.ord)
                   FROM pg_index i
                   JOIN unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
                   JOIN pg_attribute a
                     ON a.attrelid = i.indrelid AND a.attnum = k.attnum
                  WHERE i.indexrelid = 'idx_sales_invoice_number'::regclass),
                '(index absent)') AS valeur_attendue,
       -- On vérifie que l'index porte sur DEUX colonnes et que user_id est
       -- comprise, plutôt que de comparer la représentation textuelle de
       -- pg_index.indkey : celle-ci dépend de l'ordre physique des attributs
       -- et n'est pas stable d'une version de PostgreSQL à l'autre.
       CASE WHEN (SELECT count(*) = 2
                    AND bool_or(a.attname = 'user_id')
                    FROM pg_index i
                    JOIN unnest(i.indkey) AS k(attnum) ON true
                    JOIN pg_attribute a
                      ON a.attrelid = i.indrelid AND a.attnum = k.attnum
                   WHERE i.indexrelid = 'idx_sales_invoice_number'::regclass)
            THEN 'OK' ELSE 'A CORRIGER' END AS etat
UNION ALL
-- E. Le trigger de remplissage doit exister ET être actif. Sans lui, une
--    insertion directe en SQL (import, script, migration future) laisse
--    amount_received à 0 sur une vente payée : elle disparaît du chiffre
--    d'affaires sans lever la moindre erreur, et la caisse cesse de concorder
--    avec le rapport. C'est le point le plus silencieux de toute la migration.
SELECT 'acompte : trigger de remplissage' AS controle,
       coalesce((
         SELECT CASE WHEN t.tgenabled = 'O' THEN 'actif' ELSE 'desactive' END
           FROM pg_trigger t
          WHERE t.tgrelid = 'sales'::regclass
            AND t.tgname = 'sales_fill_amount_received'
       ), 'ABSENT') AS valeur_attendue,
       CASE WHEN EXISTS (
              SELECT 1
                FROM pg_trigger t
                JOIN pg_proc p ON p.proname = 'fill_amount_received'
               WHERE t.tgrelid = 'sales'::regclass
                 AND t.tgname = 'sales_fill_amount_received'
                 AND t.tgenabled = 'O'
            ) THEN 'OK' ELSE 'A COLLER' END AS etat
UNION ALL
-- F. Contrôle d'intégrité sur les données : une vente ne peut avoir reçu plus
--    que son prix, ni moins que zéro. Un écart ici signerait un bug de
--    répartition des versements, invisible dans tous les rapports.
SELECT 'acompte : coherence des montants' AS controle,
       count(*)::text || ' vente(s) incoherente(s)' AS valeur_attendue,
       CASE WHEN count(*) = 0 THEN 'OK' ELSE 'A CORRIGER' END AS etat
  FROM sales
 WHERE amount_received < 0 OR amount_received > total_amount
UNION ALL
-- G. Le programme bêta. Les deux triggers doivent être présents ET actifs : sans
--    le BEFORE, personne ne passe en Pro ; sans l'AFTER, les places sont
--    consommées sans que personne sache à qui — le pire des deux, puisque le
--    budget se viderait à l'insu du propriétaire.
SELECT 'beta : triggers actifs' AS controle,
       count(*)::text || ' trigger(s) actif(s) sur 2' AS valeur_attendue,
       CASE WHEN count(*) = 2 THEN 'OK' ELSE 'A COLLER' END AS etat
  FROM pg_trigger
 WHERE tgrelid = 'organizations'::regclass
   AND tgname IN ('trg_beta_claim_slot', 'trg_beta_record_access')
   AND tgenabled = 'O'
UNION ALL
-- H. État du programme, en clair. C'est la seule information à consulter en
--    routine : combien de places restent, et combien ont été servies.
SELECT 'beta : etat du programme' AS controle,
       CASE WHEN open THEN 'ouvert' ELSE 'clos' END
         || ' — ' || (slots_total - slots_used) || '/' || slots_total || ' place(s) restante(s)'
         || ' — ' || (SELECT count(*) FROM beta_access WHERE plan = 'pro') || ' compte(s) Pro'
       AS valeur_attendue,
       CASE WHEN slots_used <= slots_total THEN 'OK' ELSE 'INCOHERENT' END AS etat
  FROM beta_program
 WHERE id = 1
 ORDER BY 3;
