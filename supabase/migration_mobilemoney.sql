-- ═══════════════════════════════════════════════════════════
--  MOBILE MONEY — périodes prépayées (Sprint 19)
-- ═══════════════════════════════════════════════════════════
--
-- Constat de l'évaluation : la cible ne paie pas par carte, et le Mobile
-- Money ne prélève pas automatiquement. On ne vend donc pas un abonnement
-- récurrent mais des PÉRIODES : 1, 3 ou 12 mois payés d'avance, avec une
-- échéance visible. Ce fichier pose la moitié base de données du dispositif ;
-- l'autre moitié (prestataire, appels réseau, pages de paiement) vit dans
-- src/lib/payments et src/app/api/payments — aucune clé, aucun appel externe
-- ici.
--
-- Ce que la base connaît :
--   • les COMMANDES (payment_orders) : quel plan, combien de temps, quel
--     montant convenu, quel prestataire, payée ou non ;
--   • leur ACTIVATION (activate_prepaid_plan) : la seule porte qui passe une
--     commande en « payée » et repousse l'échéance du plan ;
--   • l'ÉCHÉANCE (organizations.plan_valid_until) : un plan prépayé a une
--     fin, lisible par current_org_plan() que TOUT le reste du serveur
--     appelle déjà.
--
-- Ce que la base ne connaît PAS : FedaPay, PayDunya, les webhooks, les
-- signatures. Un webhook n'arrive jamais ici sans passer par la route
-- serveur correspondante, qui appelle activate_prepaid_plan() en service_role.
--
-- Le montant d'une commande est calculé par la route API à partir de la
-- configuration de prix (NEXT_PUBLIC_PLANS_CONFIG) — jamais reçu du
-- navigateur. payment_orders n'est pas insérable par le client : seul le
-- service_role écrit des commandes (voir la révocation plus bas), et
-- activate_prepaid_plan() ne regarde d'ailleurs ni amount ni currency pour
-- décider : seulement le plan et la durée, bornés par CHECK à la création.


-- ─── 1. L'échéance du plan ──────────────────────────────────
-- NULL = pas de fin : le gratuit est gratuit pour toujours, et l'abonnement
-- Stripe mensuel se renouvelle tout seul (son webhook ne touche jamais cette
-- colonne). Seul un paiement Mobile Money l'écrit.
--
-- Jamais de DEFAULT ici : une colonne d'organisation ajoutée avec défaut
-- remplit TOUTES les lignes existantes (règle du dépôt) — les boutiques déjà
-- en Pro se retrouveraient avec une échéance, donc une fin, qu'elles n'ont
-- pas payée.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS plan_valid_until timestamptz;

COMMENT ON COLUMN organizations.plan_valid_until IS
  'Fin de la période prépayée (Mobile Money). NULL = aucune fin : gratuit, '
  'ou abonnement Stripe en cours. Écrit par activate_prepaid_plan() seul — '
  'absente des GRANT UPDATE côté client (migration_security.sql).';


-- ─── 2. current_org_plan() — le plan utile devient datable ──
-- CREATE OR REPLACE sans DROP : même type de retour (text), le harnais
-- rejoue migration_trial.sql puis ce fichier dans l'ORDER, chaque version
-- est un surcroît du précédent (essai, puis essai + échéance).
--
-- Les deux tests sont exclusifs et le restent :
--   • l'essai ne s'active que sur un plan BRUT gratuit (start_free_trial
--     refuse ailleurs) → la branche échéance, qui exige un plan brut
--     payant, ne peut jamais l'éteindre ;
--   • l'échéance ne regarde que les plans brut payants → un résidu
--     plan_valid_until sur une boutique redevenue gratuite n'y change rien.
CREATE OR REPLACE FUNCTION current_org_plan()
RETURNS text
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT CASE
              WHEN o.plan <> 'free'
                   AND o.plan_valid_until IS NOT NULL
                   AND o.plan_valid_until <= now() THEN 'free'
              WHEN o.plan = 'free' AND o.trial_ends_at > now() THEN 'starter'
              ELSE o.plan
            END
       FROM organizations o
      WHERE o.id = get_business_owner_id()),
    'free'
  );
$$;

REVOKE ALL ON FUNCTION current_org_plan() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION current_org_plan() TO authenticated;
GRANT EXECUTE ON FUNCTION current_org_plan() TO service_role;

COMMENT ON FUNCTION current_org_plan() IS
  'Plan utile de la boutique appelante : période prépayée non échue, ou '
  'essai Starter actif, sinon le plan brut — « free » en cas de doute. '
  'SECURITY INVOKER, la RLS de organizations suffit.';


-- ─── 3. payment_orders — les commandes ──────────────────────
-- user_id : l'identifiant de la boutique (= identifiant auth du patron),
-- comme partout ailleurs dans le dépôt.
CREATE TABLE IF NOT EXISTS payment_orders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  plan          text NOT NULL CHECK (plan IN ('starter', 'pro')),
  period_months smallint NOT NULL CHECK (period_months IN (1, 3, 12)),
  amount        numeric(12,2) NOT NULL CHECK (amount > 0),
  currency      text NOT NULL DEFAULT 'XOF',
  provider      text NOT NULL,
  provider_ref  text,
  -- Jeton l'unique, généré côté serveur : c'est lui que le prestataire
  -- renverra dans son webhook, et il doit être devinable impossible.
  reference     text NOT NULL UNIQUE,
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'paid', 'failed', 'expired')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- Les commandes meurent toutes seules : pas de cron, l'activation refuse.
  expires_at    timestamptz NOT NULL DEFAULT now() + interval '7 days',
  paid_at       timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_orders_user
  ON payment_orders(user_id, created_at DESC);

DROP TRIGGER IF EXISTS payment_orders_updated_at ON payment_orders;
CREATE TRIGGER payment_orders_updated_at
  BEFORE UPDATE ON payment_orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE payment_orders ENABLE ROW LEVEL SECURITY;

-- Patron lit SES commandes — et les siennes seulement :
-- user_id = auth.uid(), pas get_business_owner_id(). La seconde renverrait
-- l'id du patron pour un employé aussi, et un employé aurait lu les commandes
-- de la boutique (la route exige le patron en plus, deux couches comme pour
-- plan).
DROP POLICY IF EXISTS "orders_select_own" ON payment_orders;
CREATE POLICY "orders_select_own" ON payment_orders
  FOR SELECT USING (user_id = auth.uid());

-- Pas de policy UPDATE/DELETE : le navigateur ne passe JAMAIS une commande
-- en payée. Même sans policy, un UPDATE échouerait en silence (0 ligne) —
-- la section 37 du harnais le vérifie plutôt que de supposer.
--
-- Et pas d'INSERT non plus : les commandes naissent de la route API, qui
-- calcule le montant. Un INSERT direct ne mène nulle part (activate est
-- service_role) mais laisser le champ ouvert inviterait aux fausses
-- commandes dans la table d'historique des encaissements.
REVOKE INSERT, UPDATE, DELETE ON payment_orders FROM authenticated;

-- anon : aucune session, aucune commande. Les tables « navigateur » de ce
-- dépôt sont toutes révoquées à anon (cf. migration_plan_config.sql) — la
-- RLS seule ne dit rien à un rôle sans claim.
REVOKE ALL ON payment_orders FROM anon;


-- ─── 4. activate_prepaid_plan() — la seule porte ────────────
-- SECURITY DEFINER : appelée par la route webhook avec la clé service_role.
-- ACCORDER À authenticated reviendrait à offrir le plan à quiconque écrit
-- une référence au doigt — la fonction ne vérifie personne, c'est la route
-- qui vérifie la signature du prestataire et l'appartenance de la commande.
--
-- VOLATILE : elle écrit, et le planificateur ne doit pas la traiter comme
-- pure (même discipline que require_feature()).
--
-- Idempotence par construction : le passage pending → paid est atomique
-- (UPDATE ... WHERE status = 'pending'), les webhooks rejoués ne peuvent pas
-- ajouter deux périodes — ils retrouvent « déjà payée » et renvoient true.
CREATE OR REPLACE FUNCTION activate_prepaid_plan(p_reference text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order payment_orders%ROWTYPE;
BEGIN
  -- Les commandes mortes changent de statut pour l'histoire (une commande
  -- « pending » périmée ne doit pas traîner indéfiniment comme candidates),
  -- puis l'activation ne prend que des pending EN VIE.
  UPDATE payment_orders
     SET status = 'expired', updated_at = now()
   WHERE reference = p_reference
     AND status = 'pending'
     AND expires_at <= now();

  UPDATE payment_orders
     SET status = 'paid', paid_at = now(), updated_at = now()
   WHERE reference = p_reference
     AND status = 'pending'
   RETURNING * INTO v_order;

  IF NOT FOUND THEN
    RETURN EXISTS (
      SELECT 1 FROM payment_orders
       WHERE reference = p_reference AND status = 'paid'
    );
  END IF;

  -- Prolongation : renouveler le MÊME plan ajoute la période à la fin de
  -- celle en cours (acheter 1 mois en novembre puis 3 en décembre donne
  -- février, pas décembre + 3). Changer de plan démarre à maintenant : la
  -- période payée du plan précédent est perdue, et c'est écrit dans le
  -- commentaire plutôt que deviné.
  UPDATE organizations
     SET plan = v_order.plan,
         plan_valid_until = CASE
           WHEN plan = v_order.plan AND plan_valid_until > now()
             THEN plan_valid_until + make_interval(months => v_order.period_months)
           ELSE now() + make_interval(months => v_order.period_months)
         END
   WHERE id = v_order.user_id;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION activate_prepaid_plan(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION activate_prepaid_plan(text) FROM anon;
REVOKE ALL ON FUNCTION activate_prepaid_plan(text) FROM authenticated;
GRANT EXECUTE ON FUNCTION activate_prepaid_plan(text) TO service_role;

COMMENT ON FUNCTION activate_prepaid_plan(text) IS
  'Passe une commande Mobile Money en « payée » et repousse l''échéance du '
  'plan (prolongation si même plan). Idempotente : les webhooks rejoués ne '
  'doublent rien. service_role uniquement — la vérification de la signature '
  'prestataire appartient à la route /api/payments/callback, pas ici.';
