-- ============================================================
-- ESSAI GRATUIT DE 14 JOURS (Sprint 19 — freemium, plan 14)
-- À exécuter dans Supabase SQL Editor
--
-- L'essai Starter de 14 jours, sans carte, déclenché par un bouton
-- (décision : jamais automatique — c'est le commerçant qui choisit quand le
-- compte à rebours démarre, sinon il s'écoule pendant l'onboarding).
--
-- POURQUOI DEUX COLONNES ET PAS LE PLAN
--   organizations.plan est verrouillé : seul le webhook Stripe le change
--   (trigger organizations_reject_plan_change + privilèges colonne par
--   colonne). Écrire 'starter' dans plan pendant l'essai créerait un second
--   détenteur du même champ, et la fin d'essai — un retour en arrière du
--   plan — serait une modification que le trigger refuse au navigateur.
--   Le plan brut reste donc la VÉRITÉ CONTRACTUELLE (il paie ou non), et
--   l'essai vit à côté : current_org_plan() renvoie l'EFFET utile.
--
-- POURQUOI SANS GRANT CLIENT SUR LES COLONNES
--   GRANT UPDATE sur trial_ends_at reviendrait à laisser le patron écrire
--   la date de fin qu'il veut. La colonne naît sans droit d'écriture (le
--   piège de migration_domain, assumé ici : il est protecteur), et
--   start_free_trial() est SECURITY DEFINER — seule porte d'accès, avec ses
--   propres vérifications. Le SELECT reste de table : l'écran doit afficher
--   la date de fin.
--
-- UNE SEULE FOIS, POUR TOUJOURS
--   trial_started_at IS NULL est exigé : un essai expiré ne se relance pas.
--   Re-partir en essai à chaque essai terminé transformerait le gratuit en
--   illimité par rotation.
-- ============================================================

-- ─── 1. Colonnes ───────────────────────────────────────────
-- ADD COLUMN sans DEFAULT : aucune ligne existante ne se remplit. Le défaut
-- d'une colonne d'ajout s'applique à TOUTES les lignes — ici il n'y en a
-- d'ailleurs aucun : NULL est la valeur, pas un défaut à poser.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS trial_started_at timestamptz;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS trial_ends_at timestamptz;

COMMENT ON COLUMN organizations.trial_started_at IS
  'Début de l''essai Starter de 14 jours. NULL = jamais démarré ; il n''y en aura jamais deux.';
COMMENT ON COLUMN organizations.trial_ends_at IS
  'Fin de l''essai. Seul start_free_trial() l''écrit (SECURITY DEFINER, sans GRANT sur la colonne).';


-- ─── 2. current_org_plan() : l'effet de l'essai ────────────
-- Même signature, CREATE OR REPLACE autorisé (le type de retour ne change
-- pas). require_feature(), les appels de rapports et tout ce qui lit le plan
-- par cette fonction deviennent conscients de l'essai sans autre modification.
--
-- L'essai ne soulève QUE les boutiques gratuites : une boutique payante qui
-- aurait une fin d'essai résiduelle reste sur son plan — c'est le paiement
-- qui commande, pas l'essai.
CREATE OR REPLACE FUNCTION current_org_plan()
RETURNS text
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT CASE
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
  'Plan utile de la boutique appelante : plan payant, ou essai Starter actif. '
  'Défaut « free » en cas de doute. SECURITY INVOKER, la RLS de organizations suffit.';


-- ─── 3. start_free_trial() : la seule porte ────────────────
-- SECURITY DEFINER, parce que les colonnes trial n'ont aucun GRANT client :
-- la fonction est la seule à pouvoir les écrire, et elle vérifie elle-même
-- qui appelle. Un UPDATE direct du navigateur échoue sur les privilèges
-- avant même la RLS — deux couches, comme pour plan.
--
-- auth.uid() et non get_business_owner_id() : cette fonction-là renverrait
-- l'id du patron pour un employé aussi, et l'employé aurait pu démarrer
-- l'essai de la boutique de son patron. Ici, pas de ligne dont l'id est
-- l'appelant, pas d'essai.
--
-- VOLATILE, pour les mêmes raisons que require_feature() : elle lève une
-- exception, le planificateur ne doit pas la traiter comme pure.
CREATE OR REPLACE FUNCTION start_free_trial()
RETURNS timestamptz
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_plan   text;
  v_debut  timestamptz;
  v_fin    timestamptz;
BEGIN
  SELECT plan, trial_started_at
    INTO v_plan, v_debut
    FROM organizations
   WHERE id = auth.uid();

  IF NOT FOUND THEN
    -- Pas de session, employé (l'id de l'appelant n'est pas une boutique) :
    -- dans les deux cas, aucun essai à démarrer. Le message nomme la cause
    -- la plus fréquente, celle du patron qui n'a pas de session.
    RAISE EXCEPTION 'Boutique introuvable : cette action est réservée au patron connecté.'
      USING ERRCODE = '22023';
  END IF;

  IF v_plan <> 'free' THEN
    RAISE EXCEPTION 'Votre boutique est déjà sur un plan payant : l''essai ne s''applique qu''en plan gratuit.'
      USING ERRCODE = '22023';
  END IF;

  IF v_debut IS NOT NULL THEN
    RAISE EXCEPTION 'L''essai gratuit de 14 jours n''est proposé qu''une fois par boutique.'
      USING ERRCODE = '22023';
  END IF;

  UPDATE organizations
     SET trial_started_at = now(),
         trial_ends_at    = now() + interval '14 days'
   WHERE id = auth.uid()
  RETURNING trial_ends_at INTO v_fin;

  RETURN v_fin;
END;
$$;

REVOKE ALL ON FUNCTION start_free_trial() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION start_free_trial() TO authenticated;
GRANT EXECUTE ON FUNCTION start_free_trial() TO service_role;

COMMENT ON FUNCTION start_free_trial() IS
  'Démarre l''essai Starter de 14 jours (une fois par boutique, plan gratuit '
  'seulement, patron seulement). Renvoie la date de fin. SECURITY DEFINER : '
  'seule porte d''écriture des colonnes trial, qui n''ont aucun GRANT client.';
