-- ============================================================
-- MIGRATION ONBOARDING & MODE SIMPLE — GestionLocal
-- À exécuter dans Supabase SQL Editor, après migration_equipe_sans_service_role.sql
--
-- Sprints 17 et 18 (plan de lancement, sprints 12 et 13 du document
-- PLAN-TRAVAIL-GESTIONLOCAL.md) : une boutique neuve fait sa première vente en
-- moins de 4 minutes, puis ne voit que l'essentiel.
--
-- Trois colonnes d'affichage, aucune ne donne de droit :
--   • ui_mode         'beginner' (essentiel seulement) ou 'full' ;
--   • onboarding_step l'écran de l'assistant où le patron s'est arrêté — un
--                     rechargement de page ne le renvoie pas au début ;
--   • business_type   les 4 activités de l'inscription. `domain` reste la
--                     seule colonne qui décide des modules : épicerie, boutique
--                     et autre → 'retail', restaurant → 'restaurant'.
--
-- La fin de l'assistant reste `onboarding_done` (migration_saas.sql) : une
-- seconde colonne « onboarding_completed » dirait la même chose, et les deux
-- finiraient par se contredire.
--
-- Enfin, le carnet de dettes passe dans le plan gratuit (section 3).
-- ============================================================

-- ─── 1. Les colonnes ────────────────────────────────────────
--
-- ⚠ L'ORDRE DES DEUX INSTRUCTIONS SUR ui_mode EST LE CŒUR DE CETTE MIGRATION.
--
--   ADD COLUMN ... DEFAULT x remplit TOUTES les lignes existantes avec x. Écrire
--   directement DEFAULT 'beginner' masquerait Rapports, Équipe et Prévisions à
--   tous les clients actuels le jour du déploiement — ceux qui s'en servent.
--
--   La colonne naît donc à 'full' (les boutiques existantes gardent leur
--   interface), PUIS le défaut passe à 'beginner' pour les seules inscriptions
--   à venir. Rejouée, la première instruction ne fait rien (IF NOT EXISTS) et
--   la seconde est idempotente : aucune boutique ne change de mode au rejeu.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS ui_mode text NOT NULL DEFAULT 'full';
ALTER TABLE organizations
  ALTER COLUMN ui_mode SET DEFAULT 'beginner';

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS onboarding_step text,
  ADD COLUMN IF NOT EXISTS business_type text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'organizations_ui_mode_check') THEN
    ALTER TABLE organizations
      ADD CONSTRAINT organizations_ui_mode_check
      CHECK (ui_mode IN ('beginner', 'full'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'organizations_business_type_check') THEN
    ALTER TABLE organizations
      ADD CONSTRAINT organizations_business_type_check
      CHECK (business_type IS NULL
             OR business_type IN ('epicerie', 'boutique', 'restaurant', 'autre'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'organizations_onboarding_step_check') THEN
    ALTER TABLE organizations
      ADD CONSTRAINT organizations_onboarding_step_check
      CHECK (onboarding_step IS NULL
             OR onboarding_step IN ('welcome', 'business', 'samples', 'first_sale', 'congrats'));
  END IF;
END;
$$;


-- ─── 2. Le droit d'écrire ces colonnes ─────────────────────
--
-- Même piège que migration_domain.sql : migration_security.sql accorde les
-- droits colonne par colonne, et une colonne ajoutée ensuite naît sans droit
-- d'écriture, même pour le patron. Sans ce GRANT, l'assistant répondrait
-- « permission denied for table organizations » dès son deuxième écran.
--
-- La RLS d'organizations limite déjà l'écriture à la ligne du patron : un
-- employé ne peut pas changer le mode de la boutique.
GRANT INSERT (ui_mode, onboarding_step, business_type) ON organizations TO authenticated;
GRANT UPDATE (ui_mode, onboarding_step, business_type) ON organizations TO authenticated;


-- ─── 3. Le carnet de dettes devient gratuit ────────────────
--
-- Le plan de lancement fait des dettes l'un des trois piliers du mode simple
-- (« caisse + dettes + stock »), et l'écran de félicitations propose « Voir mes
-- dettes clients » en premier. Une boutique gratuite qui suivait ce lien
-- tombait sur un cadenas : la fonction exigeait le plan Starter.
--
-- Règle retenue : récupérer son argent n'est pas un avantage payant. Les
-- rapports (rentabilité, charges, trésorerie) le restent, eux, et gardent leur
-- require_feature('reports').
--
-- Même signature et même type de retour que migration_ca_caisse.sql : seul le
-- verrou de plan disparaît, d'où CREATE OR REPLACE sans DROP.
CREATE OR REPLACE FUNCTION get_customer_debts()
RETURNS TABLE (
  debt_id         uuid,
  phone           text,
  name            text,
  total_due       numeric,
  last_sale_at    timestamptz,
  sales_count     bigint,
  oldest_sale_at  timestamptz,
  payments_count  bigint,
  last_payment_at date,
  total_paid      numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH dues AS (
    SELECT
      s.user_id,
      s.client_phone,
      SUM(s.total_amount - s.amount_received) AS total_due,
      SUM(s.amount_received)                 AS total_paid,
      COUNT(*)                               AS sales_count,
      MAX(s.created_at)                      AS last_sale_at,
      MIN(s.created_at)                      AS oldest_sale_at
    FROM sales s
    WHERE NOT s.settled AND s.client_phone IS NOT NULL
    GROUP BY s.user_id, s.client_phone
  ), soldes AS (
    SELECT
      d.id,
      d.user_id,
      d.phone,
      d.name,
      GREATEST(COALESCE(u.total_due, 0), 0) AS total_due,
      u.last_sale_at,
      COALESCE(u.sales_count, 0) AS sales_count,
      u.oldest_sale_at,
      COALESCE(u.total_paid, 0) AS total_paid,
      (SELECT COUNT(DISTINCT cp2.gesture_id) FROM credit_payments cp2
        WHERE cp2.debt_id = d.id) AS payments_count,
      (SELECT MAX(cp3.day) FROM credit_payments cp3 WHERE cp3.debt_id = d.id) AS last_payment_at
    FROM customer_debts d
    LEFT JOIN dues u ON u.user_id = d.user_id AND u.client_phone = d.phone
  )
  SELECT s.id, s.phone, s.name, s.total_due, s.last_sale_at, s.sales_count,
         s.oldest_sale_at, s.payments_count, s.last_payment_at, s.total_paid
    FROM soldes s
   -- L'isolation entre boutiques reste là : c'est la RLS et ce filtre qui
   -- protègent la liste des débiteurs du voisin, pas le plan.
   WHERE s.user_id = get_business_owner_id()
     AND s.total_due > 0
   ORDER BY s.oldest_sale_at ASC NULLS LAST;
$$;

REVOKE ALL ON FUNCTION get_customer_debts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_customer_debts() TO authenticated;
