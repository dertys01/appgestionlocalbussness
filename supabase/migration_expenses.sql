-- ============================================================
-- MIGRATION DÉPENSES — GestionLocal
-- À exécuter dans Supabase SQL Editor, après migration_profitability.sql
--
-- Le chiffre d'affaires ne prouve rien : 457 000 FCFA de CA peuvent
-- correspondre à un commerce déficitaire si le loyer, les salaires et
-- l'électricité ne sont pas saisis. Ce module enregistre les charges et
-- calcule le résultat net.
--
--   1. expense_categories — plan de comptes par organisation
--   2. expenses           — les charges
--   3. get_cash_flow()    — résultat par jour
--
-- Choix : le jour d'une dépense est calculé par le client et stocké en
-- `date`. Les ventes restent horodatées en timestamptz et sont ramenées au
-- jour via le fuseau de l'organisation. C'est le seul endroit où les deux
-- representations coexistent ; get_cash_flow() fait la conversion.
-- ============================================================

-- ─── 1. Plan de comptes ────────────────────────────────────
-- Par organisation, et non global : deux boutiques n'ont pas les mêmes
-- charges, et une catégorie partagée exposerait le nom des comptes de l'une
-- à l'autre via les policies.
CREATE TABLE IF NOT EXISTS expense_categories (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name       text NOT NULL,
  icon       text,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT expense_categories_org_name_key UNIQUE (user_id, name)
);

ALTER TABLE expense_categories ENABLE ROW LEVEL SECURITY;

-- Séparée par organisation : chaque boutique voit son seul plan de comptes.
DROP POLICY IF EXISTS "expense_categories_read" ON expense_categories;
DROP POLICY IF EXISTS "expense_categories_read" ON expense_categories;
CREATE POLICY "expense_categories_read" ON expense_categories
  FOR SELECT USING (user_id = get_business_owner_id());

DROP POLICY IF EXISTS "expense_categories_write" ON expense_categories;
DROP POLICY IF EXISTS "expense_categories_write" ON expense_categories;
CREATE POLICY "expense_categories_write" ON expense_categories
  FOR ALL USING (can_manage_products() AND user_id = get_business_owner_id())
  WITH CHECK (can_manage_products() AND user_id = get_business_owner_id());

-- Jeu de comptes par défaut, créé à la première visite du module.
--
-- Aucun paramètre : le tenant est résolu par get_business_owner_id(), comme
-- partout ailleurs. Une signature exposant p_owner permettrait à un client
-- d'appeler le seed pour l'organisation d'un autre.
--
-- ON CONFLICT DO NOTHING porte sur (user_id, name) : rejouer la migration
-- ou revenir dans l'application ne duplique rien.
CREATE OR REPLACE FUNCTION seed_expense_categories()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := get_business_owner_id();
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Non authentifié' USING ERRCODE = '28000';
  END IF;

  INSERT INTO expense_categories (user_id, name, icon, sort_order) VALUES
    (v_owner, 'Loyer',            'building', 10),
    (v_owner, 'Salaires',         'users',    20),
    (v_owner, 'Électricité',      'zap',      30),
    (v_owner, 'Eau',              'droplet',  40),
    (v_owner, 'Transport',        'truck',    50),
    (v_owner, 'Communication',    'wifi',     60),
    (v_owner, 'Fournitures',      'package',  70),
    (v_owner, 'Entretien',        'tool',     80),
    (v_owner, 'Impôts et taxes',  'receipt',  90),
    (v_owner, 'Crédit bancaire',  'credit-card', 100),
    (v_owner, 'Autre',            'dots',     999)
  ON CONFLICT (user_id, name) DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION seed_expense_categories() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION seed_expense_categories() TO authenticated;
GRANT EXECUTE ON FUNCTION seed_expense_categories() TO service_role;

-- ─── 2. Les dépenses ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS expenses (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  category   text NOT NULL,
  label      text NOT NULL,               -- ex : « Loyer janvier »
  amount     numeric(12,2) NOT NULL,
  day        date NOT NULL,               -- date locale de la boutique
  note       text,
  created_at timestamptz NOT NULL DEFAULT now(),

  -- Une charge négative fausserait le résultat net.
  CONSTRAINT expenses_amount_positive CHECK (amount > 0),
  CONSTRAINT expenses_label_not_blank CHECK (length(btrim(label)) > 0)
);

ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;

-- Lecture : tout le tenant, comme les ventes.
DROP POLICY IF EXISTS "expenses_read" ON expenses;
DROP POLICY IF EXISTS "expenses_read" ON expenses;
CREATE POLICY "expenses_read" ON expenses
  FOR SELECT USING (user_id = get_business_owner_id());

-- Écriture : patron / manager, même règle que le catalogue.
DROP POLICY IF EXISTS "expenses_insert" ON expenses;
DROP POLICY IF EXISTS "expenses_insert" ON expenses;
CREATE POLICY "expenses_insert" ON expenses
  FOR INSERT WITH CHECK (can_manage_products() AND user_id = get_business_owner_id());

DROP POLICY IF EXISTS "expenses_update" ON expenses;
DROP POLICY IF EXISTS "expenses_update" ON expenses;
CREATE POLICY "expenses_update" ON expenses
  FOR UPDATE USING (can_manage_products())
  WITH CHECK (can_manage_products() AND user_id = get_business_owner_id());

DROP POLICY IF EXISTS "expenses_delete" ON expenses;
DROP POLICY IF EXISTS "expenses_delete" ON expenses;
CREATE POLICY "expenses_delete" ON expenses
  FOR DELETE USING (can_manage_products());

CREATE INDEX IF NOT EXISTS idx_expenses_user_day     ON expenses(user_id, day DESC);
CREATE INDEX IF NOT EXISTS idx_expenses_user_category ON expenses(user_id, category);

-- ─── 3. Résultat journalier ────────────────────────────────
-- SECURITY INVOKER : l'isolation vient de la RLS de sales et expenses.
-- Aucune règle de tenancy dupliquée.
-- get_cash_flow() est redéfinie plus loin, avec un type de retour différent :
-- PostgreSQL refuse « cannot change return type of existing function » sur un
-- CREATE OR REPLACE. Le DROP rend ce fichier rejouable sur une base qui porte
-- déjà la version corrigée de la section 8 de migration_security.sql — version
-- que le harnais rétablit en fin de rejouabilité.
DROP FUNCTION IF EXISTS get_cash_flow(date, date);

CREATE OR REPLACE FUNCTION get_cash_flow(p_from date, p_to date)
RETURNS TABLE (
  day          date,
  revenue      numeric,
  expenses     numeric,
  net          numeric,
  transactions bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH bounds AS (
    -- Fuseau de l'organisation, avec repli sur celui du pays si absent.
    SELECT COALESCE(
             (SELECT o.timezone FROM organizations o
               WHERE o.id = get_business_owner_id()),
             'Africa/Porto-Novo'
           ) AS tz
  ),
  sales_by_day AS (
    SELECT
      (s.created_at AT TIME ZONE (SELECT tz FROM bounds))::date AS d,
      -- Base de caisse, sans exception : le chiffre d'affaires est ce qui est
      -- réellement rentré, et amount_received est la seule colonne qui le sait.
      -- Une vente espèces vaut son prix, une vente à crédit vaut son acompte,
      -- et un règlement encaissé aujourd'hui sur une vente d'hier est
      -- imputé... à la date de la vente, pas à celle du versement.
      --
      -- Ce dernier point est un choix, et il faut le dire : le résultat net est
      -- rattaché à la journée où la vente a eu lieu, même si l'argent est rentré
      -- trois semaines plus tard. Rattacher au jour du versement donnerait un
      -- résultat net qui bouge le jour où le client paie, sur une journée où
      -- aucune vente n'a été faite — impossible à lire pour un commerçant, et
      -- sans rapport avec ce que sa caisse contient réellement.
      SUM(s.amount_received) AS revenue,
      COUNT(*)              AS tx
    FROM sales s
    WHERE (s.created_at AT TIME ZONE (SELECT tz FROM bounds))::date
          BETWEEN p_from AND p_to
    GROUP BY 1
  ),
  expenses_by_day AS (
    SELECT x.day AS d, SUM(x.amount) AS spent
    FROM expenses x
    WHERE x.day BETWEEN p_from AND p_to
    GROUP BY 1
  )
  SELECT
    COALESCE(s.d, x.d)                                AS day,
    COALESCE(s.revenue, 0)                            AS revenue,
    COALESCE(x.spent, 0)                              AS expenses,
    COALESCE(s.revenue, 0) - COALESCE(x.spent, 0)     AS net,
    COALESCE(s.tx, 0)                                 AS transactions
  FROM sales_by_day s
  FULL OUTER JOIN expenses_by_day x ON s.d = x.d
  -- VERROU DE PLAN. Même raison que get_product_profitability() : l'appel RPC
  -- contourne le cadenas du menu. Ici, ce que le client gratuit lirait est le
  -- résultat net par jour — exactement ce qui se trouve au bas de la page
  -- « Charges », la ligne que le plan vend.
  -- require_feature est VOLATILE : elle ne peut être ni écartée ni mise en
  -- cache par le planificateur. FULL OUTER JOIN produit toujours au moins une
  -- ligne, donc le garde est toujours atteint.
  WHERE (SELECT true FROM require_feature('reports'))
  ORDER BY 1;
$$;

COMMENT ON FUNCTION get_cash_flow(date, date) IS
  'Résultat journalier : CA − charges. L''isolation vient de la RLS de sales '
  'et expenses (SECURITY INVOKER). Repli sur Africa/Porto-Novo si la timezone '
  'de l''organisation est absente.';

REVOKE ALL ON FUNCTION get_cash_flow(date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_cash_flow(date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION get_cash_flow(date, date) TO service_role;

-- ─── 4. Signature obsolète ─────────────────────────────────
-- La version initiale de cette migration exposait
-- seed_expense_categories(p_owner uuid). PostgREST ne la faisait pas
-- correspondre à un appel sans argument (« Could not find the function … without
-- parameters »). Elle est remplacée ci-dessus ; on retire l'ancienne pour ne
-- pas laisser deux fonctions au même nom.
DROP FUNCTION IF EXISTS seed_expense_categories(uuid);
