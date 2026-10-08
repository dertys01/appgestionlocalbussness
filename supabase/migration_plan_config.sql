-- ============================================================
-- LIMITES DES PLANS CÔTÉ SERVEUR (Sprint 19 — freemium, plan 14)
-- À exécuter dans Supabase SQL Editor, APRÈS migration_trial.sql
--
-- CE QUE ÇA CORRIGE
--   Trois limites n'existaient que dans le navigateur : un simple
--   supabase.from('sales').select() dans la console passait outre
--   l'historique au-delà de la fenêtre de son plan, l'invitation d'un
--   employé au-delà du quota,
--   et le plafond produits lui-même ne dépendait que d'un CASE écrit dans
--   le code. Le dépôt est public : ces quotas sont désormais dans
--   plan_config, une table VIDE dans le dépôt, remplie par
--   scripts/sync-plan-config.mjs à partir de NEXT_PUBLIC_PLANS_CONFIG.
--   Le mécanisme ici, les valeurs nulle part ici.
--
-- LE SENS DE LA PORTE : FAIL-OPEN, DANS LES DEUX CAS
--   Une ligne absente de plan_config = pas de quota. Deux raisons, dans
--   l'ordre : le mécanisme ne devine jamais une valeur (un chiffre inventé
--   serait une offre publique par accident), et une configuration oubliée
--   doit coûter des ventes limitées, jamais des boutiques bloquées — le
--   premier écran d'un nouveau venu est l'assistant qui CRÉE des produits.
--   D'où l'ordre de déploiement, non négociable :
--     1. appliquer migration_trial.sql, puis ce fichier ;
--     2. node scripts/sync-plan-config.mjs   ← sans lui, aucun quota.
--
-- L'HISTOIRE QUI NE MEURT PAS : LES DETTES
--   §8 de l'évaluation : « Dettes + relance manuelle : oui » sur TOUS les
--   plans. Récupérer son argent n'est pas un avantage payant. La fenêtre
--   d'historique est donc contournée pour ce qui n'est pas soldé
--   (OR NOT settled) : une vente à crédit vieille de six mois reste lisible,
--   et get_customer_debts() — SECURITY INVOKER, qui lit sales — la retrouve.
--   Une fois la dette réglée, la vente redevient une ligne d'historique
--   comme les autres, et peut sortir de la fenêtre.
--
-- L'ESSAI ET L'ÉCHÉANCE COMPTENT POUR CE QU'ILS DONNENT
--   Les quotas lisent le plan EFFECTIF (essai Starter = quotas Starter ;
--   période prépayée écoulée = quotas gratuit), via le même CASE que
--   current_org_plan() : deux écrans de la même pièce. La colonne
--   plan_valid_until vient de migration_mobilemoney.sql, posée AVANT ce
--   fichier dans l'ORDER.
-- ============================================================

-- ─── 1. plan_config — les quotas, table vide dans le dépôt ───
-- Une clé par (plan, clé de quota). Les valeurs sont posées par
-- scripts/sync-plan-config.mjs ; ce fichier ne crée que le réceptacle.
CREATE TABLE IF NOT EXISTS plan_config (
  plan  text NOT NULL CHECK (plan IN ('free', 'starter', 'pro')),
  key   text NOT NULL,
  value int  NOT NULL,
  PRIMARY KEY (plan, key)
);

ALTER TABLE plan_config ENABLE ROW LEVEL SECURITY;

-- La valeur d'ILLIMITÉ se stocke en 2147483647 (l'ancien plafond Pro de
-- check_product_limit) : un int comme les autres, aucune valeur spéciale à
-- interpréter. Les calculs en date bornent ce nombre (voir
-- within_plan_history) pour ne jamais sortir du domaine des timestamps.
-- Le null du JSON devient cette valeur au moment de la synchronisation.

-- Lecture seule pour le navigateur... ou plutôt : AUCUNE lecture. Le seul
-- lecteur des quotas est within_plan_history(), qui tourne en SECURITY
-- DEFINER (voir section 2) — le navigateur n'a nul besoin de la table, ses
-- quotas affichés viennent de la configuration du build. RLS activée sans
-- policy = refus par défaut pour les deux rôles de navigateur, même si les
-- privilèges par défaut de Supabase (ALTER DEFAULT PRIVILEGES → ALL à la
-- création) les accordaient — privilèges ET policies, deux couches, comme
-- pour organizations.
REVOKE ALL ON plan_config FROM anon;
REVOKE ALL ON plan_config FROM authenticated;
GRANT ALL ON plan_config TO service_role;


-- ─── 2. within_plan_history() — la fenêtre d'historique ──────
-- Appelée par la politique de lecture de sales, ligne par ligne. STABLE :
-- le plan de la boutique ne bouge pas dans une requête.
--
-- SECURITY DEFINER, et c'est la clé de tout le reste : la fonction est
-- appelée depuis une POLICIE, dont le rôle courant est celui du lecteur —
-- y compris anon (visiteur déconnecté) et authenticated. Sans définition
-- propriétaire, elle mourrait sur les privilèges de plan_config (révoqués
-- à tous les navigateurs, section 1) : une ERREUR là où le déconnecté
-- obtenait un résultat vide. En propriétaire, elle lit plan_config et
-- organizations quel que soit l'appelant — et ne peut rien en dire : elle
-- ne renvoie qu'un booléen sur l'appelant lui-même (get_business_owner_id).
--
-- Trois sorties possibles, dans l'ordre de décision :
--   • plan non gratuit (ou essai actif) → true, tout l'historique ;
--   • plan gratuit avec quota posé → la ligne est-elle dans la fenêtre ;
--   • pas de quota posé → true (fail-open, cf. en-tête).
--
-- LEAST borné à ~1000 jours : l'illimité se stocke en 2147483647, et
-- now() - 2147483647 jours sortirait du domaine des timestamps (erreur
-- « timestamp out of range » qui casserait TOUS les SELECT de ventes).
-- 1000 ans couvre toute vente réelle, sans risque d'arithmétique.
CREATE OR REPLACE FUNCTION within_plan_history(p_moment timestamptz)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT CASE
              WHEN c.value >= 2147483646 THEN true
              ELSE p_moment >= now() - make_interval(days => LEAST(c.value, 365000))
            END
       FROM plan_config c
      WHERE c.plan = current_org_plan()
        AND c.key = 'history_days'),
    true
  );
$$;

COMMENT ON FUNCTION within_plan_history(timestamptz) IS
  'Vrai si la ligne appartient à l''historique visible du plan appelant : '
  'toujours pour un plan payant (ou en essai), dans la fenêtre history_days '
  'pour le gratuit, toujours si aucun quota n''est posé (fail-open). '
  'SECURITY DEFINER : appelée depuis la politique sales, en anon y compris.';

GRANT EXECUTE ON FUNCTION within_plan_history(timestamptz) TO anon;
GRANT EXECUTE ON FUNCTION within_plan_history(timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION within_plan_history(timestamptz) TO service_role;


-- ─── 3. sales : la fenêtre posée sur la lecture ──────────────
-- La politique remplace celle de migration_security.sql : même isolation
-- (user_id = get_business_owner_id()), plus la fenêtre, plus l'exemption
-- des dettes (OR NOT settled, cf. en-tête). Aucune écriture client n'existe
-- sur sales — tout passe par des RPC SECURITY DEFINER — donc le SELECT est
-- le seul point à toucher.
--
-- sale_items n'a pas de politique à écrire : la sienne pointe vers sales
-- par une sous-requête, et une politique applique la RLS de la table lue —
-- les lignes d'une vente hors fenêtre disparaissent avec leur vente.
DROP POLICY IF EXISTS "user_sales_select" ON sales;
CREATE POLICY "user_sales_select" ON sales
  FOR SELECT USING (
    user_id = get_business_owner_id()
    AND (within_plan_history(created_at) OR NOT settled)
  );


-- ─── 4. check_product_limit() — quotas en configuration ─────
-- Même trigger, corps remplacé (CREATE OR REPLACE suffit : le trigger
-- référence la fonction, pas son corps). Trois différences avec l'ancienne
-- version écrite en dur dans migration_plan_limits.sql :
--   • les quotas viennent de plan_config, pas d'un CASE dans le dépôt ;
--   • le plan est l'effet utile, essai et échéance prépayée compris ;
--   • pas de quota posé → on laisse passer (l'ancien CASE tombait en
--     'free' pour un plan inconnu — bloquer par défaut avait du sens quand
--     la valeur était connue ; sans valeur, bloquer reviendrait à inventer
--     une offre).
CREATE OR REPLACE FUNCTION check_product_limit()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_plan    text;
  v_quota   int;
  v_comptes int;
BEGIN
  SELECT CASE
           WHEN o.plan <> 'free' AND o.plan_valid_until IS NOT NULL
                AND o.plan_valid_until <= now() THEN 'free'
           WHEN o.plan = 'free' AND o.trial_ends_at > now() THEN 'starter'
           ELSE o.plan
         END
    INTO v_plan
    FROM organizations o
   WHERE o.id = NEW.user_id;

  v_plan := COALESCE(v_plan, 'free');

  SELECT value INTO v_quota
    FROM plan_config
   WHERE plan = v_plan AND key = 'products';

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  SELECT COUNT(*) INTO v_comptes
    FROM products
   WHERE user_id = NEW.user_id;

  IF v_comptes >= v_quota THEN
    RAISE EXCEPTION 'Limite de produits atteinte pour le plan % (max %). Passez à un plan supérieur.', v_plan, v_quota;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_product_limit ON products;
CREATE TRIGGER enforce_product_limit
  BEFORE INSERT ON products
  FOR EACH ROW EXECUTE FUNCTION check_product_limit();


-- ─── 5. check_employee_limit() — le quota d'équipe ───────────
-- Deux tables, une fonction (TG_TABLE_NAME décide du décompte) :
--
--   • employee_invitations (invitation) : le quota compte les membres +
--     les invitations EN ATTENTE (accepted_at NULL et non expirées). C'est
--     le même décompte que TeamModule à l'écran : l'invitation en attente
--     occupe déjà un poste, sinon l'échec arriverait à l'acceptation sans
--     raison visible.
--
--   • business_members (acceptation du lien, dans redeem_invitation) :
--     les MEMBRES SEULEMENT. L'invitation est encore « en attente » à cet
--     instant (accepted_at se remplit juste après) : la compter aussi
--     double-compterait la même personne et refuserait l'acceptation
--     exactement quand tout est en ordre.
--
--   Les deux décomptes réunis gardent l'invariant membres + en attente ≤
--   quota : l'invitation naît sous le premier décompte, l'acceptation
--   transfère la place de l'une à l'autre sans l'ajouter.
--
-- Seules les INSERT sont déclenchées : ni UPDATE ni DELETE ne crée
-- d'employé — un membre qui part libère sa place par la suppression, sans
-- trigger (aucune libération n'a besoin d'être refusée).
CREATE OR REPLACE FUNCTION check_employee_limit()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_plan   text;
  v_quota  int;
  v_comptes int;
BEGIN
  SELECT CASE
           WHEN o.plan <> 'free' AND o.plan_valid_until IS NOT NULL
                AND o.plan_valid_until <= now() THEN 'free'
           WHEN o.plan = 'free' AND o.trial_ends_at > now() THEN 'starter'
           ELSE o.plan
         END
    INTO v_plan
    FROM organizations o
   WHERE o.id = NEW.owner_id;

  v_plan := COALESCE(v_plan, 'free');

  SELECT value INTO v_quota
    FROM plan_config
   WHERE plan = v_plan AND key = 'employees';

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'business_members' THEN
    SELECT COUNT(*) INTO v_comptes
      FROM business_members
     WHERE owner_id = NEW.owner_id;
  ELSE
    SELECT
      (SELECT COUNT(*) FROM business_members WHERE owner_id = NEW.owner_id)
    + (SELECT COUNT(*) FROM employee_invitations
        WHERE owner_id = NEW.owner_id
          AND accepted_at IS NULL
          AND expires_at > now())
    INTO v_comptes;
  END IF;

  IF v_comptes >= v_quota THEN
    IF v_quota = 0 THEN
      RAISE EXCEPTION 'Le plan % ne prend pas d''employé. Passez à un plan supérieur.', v_plan;
    END IF;
    RAISE EXCEPTION 'Limite du plan % atteinte : % employé(s) maximum, invitations en attente comprises. Passez à un plan supérieur.', v_plan, v_quota;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_employee_limit ON employee_invitations;
CREATE TRIGGER enforce_employee_limit
  BEFORE INSERT ON employee_invitations
  FOR EACH ROW EXECUTE FUNCTION check_employee_limit();

DROP TRIGGER IF EXISTS enforce_member_limit ON business_members;
CREATE TRIGGER enforce_member_limit
  BEFORE INSERT ON business_members
  FOR EACH ROW EXECUTE FUNCTION check_employee_limit();
