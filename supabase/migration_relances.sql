-- ============================================================
-- migration_relances.sql — P6 : relances automatiques (rappel programmé)
--
-- L'évaluation §7 tranche : la relance MANUELLE est sur tous les plans
-- (« Dettes + relance manuelle : oui »), les relances AUTOMATIQUES sont
-- Starter et Pro (« Relances automatiques : non | oui | oui »). Ce fichier
-- est la moitié payante : il détecte CE qu'il faut relancer et retient
-- QUAND on l'a fait. L'envoi lui-même reste le lien WhatsApp existant —
-- aucun code n'envoie un WhatsApp tout seul sans API Business.
--
-- LE CHOIX « CALCUL EN DIRECT »
--   Pas de cron, pas de table de signaux pré-calculés : dettes_a_relancer()
--   calcule à chaque lecture (données toujours fraîches, aucun secret à
--   poser, aucune panne silencieuse de job). Le jour où les notifications
--   push arrivent, c'est cette même fonction qui les alimentera.
--
-- LA CADENCE (7 JOURS, DEUX FOIS)
--   Une dette devient « à relancer » quand sa plus vieille vente ouverte a
--   7 jours ou plus, et ne le redevient que 7 jours après la dernière
--   relance journalisée. Ce sont des constantes de rythme produit — même
--   nature que le « depuis N jours » affiché par l'écran, qui utilise déjà
--   7 jours — pas des valeurs d'offre : rien à configurer, rien à cacher.
--
-- FAIL-SAFE : marquer_relance() ne refuse jamais bruyamment. La journali-
-- sation ne doit jamais empêcher l'envoi : un tap « Relancer » dont le log
-- échoue ouvre quand même WhatsApp (au pire, la dette ressurgit).
-- ============================================================

-- ─── 1. relance_suivi — quand chaque dette a été relancée ───
-- Une ligne par dette (customer_debts.id), écrasée à chaque relance. Pas de
-- colonne d'organisation : la dette appartient déjà à une boutique, et c'est
-- elle qui porte l'isolation. Suppression en cascade : une dette qui
-- disparaît n'a plus rien à rappeler.
CREATE TABLE IF NOT EXISTS relance_suivi (
  debt_id          uuid        NOT NULL PRIMARY KEY REFERENCES customer_debts(id) ON DELETE CASCADE,
  last_reminded_at timestamptz NOT NULL DEFAULT now(),
  reminded_by      uuid
);

ALTER TABLE relance_suivi ENABLE ROW LEVEL SECURITY;

-- Même régime que payment_orders : le navigateur ne touche pas la table.
-- Toute lecture passe par dettes_a_relancer(), toute écriture par
-- marquer_relance(), toutes deux SECURITY DEFINER avec contrôle du patron.
REVOKE ALL ON relance_suivi FROM anon;
REVOKE ALL ON relance_suivi FROM authenticated;
GRANT ALL ON relance_suivi TO service_role;

COMMENT ON TABLE relance_suivi IS
  'Dernière relance journalisée par dette. Écrite par marquer_relance() au '
  'tap « Relancer », lue par dettes_a_relancer() pour ne pas re-proposer '
  'une dette déjà relancée il y a moins de 7 jours.';

-- ─── 2. marquer_relance() — journaliser l'envoi ───
CREATE OR REPLACE FUNCTION marquer_relance(p_debt_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Dette d'une autre boutique : on ment poliment (false), on ne lève pas.
  -- Lever ici bloquerait l'ouverture de WhatsApp côté écran.
  IF NOT EXISTS (SELECT 1 FROM customer_debts d
                  WHERE d.id = p_debt_id
                    AND d.user_id = get_business_owner_id()) THEN
    RETURN false;
  END IF;

  INSERT INTO relance_suivi (debt_id, last_reminded_at, reminded_by)
  VALUES (p_debt_id, now(), auth.uid())
  ON CONFLICT (debt_id) DO UPDATE
    SET last_reminded_at = now(),
        reminded_by = auth.uid();

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION marquer_relance(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION marquer_relance(uuid) TO authenticated;

COMMENT ON FUNCTION marquer_relance(uuid) IS
  'Journalise une relance au tap « Relancer ». Ne refuse jamais bruyamment '
  '(false si dette étrangère) : le log ne doit pas empêcher l''envoi.';

-- ─── 3. dettes_a_relancer() — CE qu'il faut relancer ───
-- Même calcul de solde que get_customer_debts() (dues par téléphone, dettes
-- soldées exclues), plus deux filtres : âge de la plus vieille vente
-- ouverte (≥ 7 jours) et fraîcheur de la dernière relance (< 7 jours →
-- masquée). Le verrou de plan est ici, pas dans l'écran : current_org_plan()
-- connaît l'essai (starter) comme l'échéance (retour au gratuit).
CREATE OR REPLACE FUNCTION dettes_a_relancer()
RETURNS TABLE (
  debt_id          uuid,
  phone            text,
  name             text,
  total_due        numeric,
  total_paid       numeric,
  oldest_sale_at   timestamptz,
  jours            integer,
  last_reminded_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH dues AS (
    SELECT
      s.user_id,
      s.client_phone,
      SUM(s.total_amount - s.amount_received) AS total_due,
      SUM(s.amount_received)                  AS total_paid,
      MIN(s.created_at)                       AS oldest_sale_at
    FROM sales s
    WHERE NOT s.settled AND s.client_phone IS NOT NULL
    GROUP BY s.user_id, s.client_phone
  )
  SELECT d.id,
         d.phone,
         d.name,
         GREATEST(COALESCE(u.total_due, 0), 0),
         COALESCE(u.total_paid, 0),
         u.oldest_sale_at,
         (extract(epoch FROM now() - u.oldest_sale_at) / 86400)::int,
         rs.last_reminded_at
    FROM customer_debts d
    LEFT JOIN dues u
      ON u.user_id = d.user_id AND u.client_phone = d.phone
    LEFT JOIN relance_suivi rs
      ON rs.debt_id = d.id
   WHERE d.user_id = get_business_owner_id()
     -- VERROU DE PLAN (évaluation §7 : automatiques = Starter et Pro).
     -- current_org_plan() traduit l'essai en starter et l'échéance en free :
     -- un essai en cours reçoit les rappels, un plan échu ne les reçoit plus.
     AND current_org_plan() IN ('starter', 'pro')
     AND GREATEST(COALESCE(u.total_due, 0), 0) > 0
     AND u.oldest_sale_at <= now() - interval '7 days'
     AND (rs.last_reminded_at IS NULL
          OR rs.last_reminded_at <= now() - interval '7 days')
   ORDER BY u.oldest_sale_at ASC NULLS LAST;
$$;

REVOKE ALL ON FUNCTION dettes_a_relancer() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dettes_a_relancer() TO authenticated;

COMMENT ON FUNCTION dettes_a_relancer() IS
  'Dettes à relancer pour la boutique appelante, du plus ancien au plus '
  'récent : solde > 0, plus vieille vente ouverte ≥ 7 jours, pas de relance '
  'journalisée depuis 7 jours. Vide sur le plan gratuit (la relance manuelle '
  'reste, elle, sur tous les plans). SECURITY DEFINER : lit relance_suivi, '
  'révoquée au navigateur.';
