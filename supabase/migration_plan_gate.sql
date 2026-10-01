-- ============================================================
-- VERROU DE PLAN CÔTÉ SERVEUR
-- À exécuter dans Supabase SQL Editor
--
-- LE TROU
--   Les écrans Rapports, Prévisions et Dettes sont verrouillés par un test de
--   plan dans le navigateur : le menu affiche un cadenas, et un client en plan
--   gratuit est redirigé vers Paramètres. C'est vrai, et c'est sans valeur.
--
--   Le verrou est côté client, donc contournable en une ligne depuis la console
--   du navigateur :
--
--     supabase.rpc('get_product_profitability')
--
--   La clé anon est publique — elle est dans le bundle JS, que le navigateur
--   télécharge. Un concurrent, un-client, ou un Stall qui veut voir la marge de
--   la boutique d'à côté n'a rien à faire de plus. Il n'est même pas nécessaire
--   d'être connecté : il suffit d'être le propriétaire de sa boutique, ce que
--   l'inscription en plan gratuit donne en trente secondes. La RLS isole les
--   boutiques entre elles, donc il ne verra que SES chiffres — mais il verra
--   tous les chiffres payants, gratuitement.
--
-- CE QUE CELA FAIT PERDRE
--   Le plan Starter vend 3 000 FCFA/mois, le Pro 9 000. Si les rapports sont
--   accessibles à tous, personne n'a de raison de payer : c'est le produit
--   entier qui devient gratuit. Le cadenas dans le menu continuait de dire le
--   contraire.
--
-- LE PRINCIPE
--   Une règle de monétisation ne peut pas vivre dans le navigateur. Le plan est
--   relu en base, à chaque appel, et l'appel est refusé si le plan ne suit pas.
--   Le client ne fait que refléter la décision — il n'est plus l'arbitre.
--
-- ⚠ Ce n'est PAS une sécurité de confidentialité : la RLS s'en charge, et elle
--   fonctionne. C'est une règle commerciale, et c'est précisément le genre de
--   règle qu'un client contourne sans le vouloir, en gardant un onglet ouvert
--   d'un essai terminé. Le contrôle doit être là où la décision se prend.
--
-- CE QUI N'EST PAS VERROUILLÉ, ET POURQUOI
--   La caisse, le stock, les ventes, l'équipe, les invitations, les dettes.
--   Un client doit pouvoir VENDRE : c'est l'application. Verrouiller la
--   vente décourage, il faut donc laisser passer tout ce qui fait tourner le
--   commerce, et ne verrouiller que ce qui est un avantage payant.
--
-- DEUX COUCHES, VOLONTAIREMENT : le plan et les limites restent aussi dans le
--   client (PLAN_LIMITS), pour afficher des cadenas et des messages sans
--   aller-retour réseau. Cette migration ne le remplace pas, elle le renforce :
--   si les deux divergent un jour, c'est la base qui tranche.
-- ============================================================

-- ─── 1. Lire le plan de la boutique ────────────────────────
-- La source de vérité est organizations.plan, déjà utilisée par le trigger de
-- limite de produits : le contrôle de plan ne peut pas utiliser une autre
-- colonne, sinon les deux se désynchronisent.
--
-- COALESCE sur 'free' : une organisation sans plan est traitée comme gratuit.
-- Le doute doit coûter cher au vendeur, jamais au client.
CREATE OR REPLACE FUNCTION current_org_plan()
RETURNS text
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT o.plan FROM organizations o WHERE o.id = get_business_owner_id()),
    'free'
  );
$$;

REVOKE ALL ON FUNCTION current_org_plan() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION current_org_plan() TO authenticated;
GRANT EXECUTE ON FUNCTION current_org_plan() TO service_role;

COMMENT ON FUNCTION current_org_plan() IS
  'Plan de la boutique appelante. Défaut « free » : en cas de doute, un client '
  'est traité comme gratuit. SECURITY INVOKER, la RLS de organizations suffit.';


-- ─── 2. Exiger une fonctionnalité ──────────────────────────
-- Lève une exception si le plan ne permet pas p_feature. Le message est en
-- français et nomme le plan à prendre : c'est ce que le client affiche quand
-- l'appel échoue, et un message technique serait incompréhensible pour un
-- commerçant.
--
-- VOLATILE, et c'est délibéré : la fonction lève une exception, donc elle n'est
-- pas « pure ». Une fonction STABLE serait susceptible d'être évaluée une seule
-- fois par le planificateur, ou écartée s'il juge le résultat inutilisable —
-- deux façons discrètes de laisser passer un client en plan gratuit.
--
-- SECURITY INVOKER : elle ne fait que lire organizations, dont la RLS renvoie
-- la ligne de l'appelant. Rien à contourner.
CREATE OR REPLACE FUNCTION require_feature(p_feature text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_plan    text;
  v_requis  text;
  v_rang_plan   int;
  v_rang_requis int;
BEGIN
  -- Les mêmes quotas que PLAN_LIMITS côté client. Les tenir à jour à deux
  -- endroits est un risque assumé : c'est la base qui tranche, donc un oubli
  -- côté client ne donne accès à rien.
  v_requis := CASE p_feature
    WHEN 'reports'   THEN 'starter'   -- rentabilité, charges, dettes
    WHEN 'forecast'  THEN 'pro'       -- prévisions de réapprovisionnement
    WHEN 'exportCsv' THEN 'starter'
    ELSE NULL
  END;

  -- Fonctionnalité inconnue : on refuse. Une faute de frappe dans le nom ne
  -- doit pas se traduire par un accès accordé.
  IF v_requis IS NULL THEN
    RAISE EXCEPTION 'Fonctionnalité inconnue : %', p_feature USING ERRCODE = '22023';
  END IF;

  -- CONTEXTE SANS UTILISATEUR = CONFIANCE, PAS PLAN GRATUIT.
  --
  -- Aucun utilisateur résolu ne signifie pas un client gratuit : cela veut dire
  -- clé service_role, script d'administration, migration, ETL. Ces contextes
  -- sont déjà de confiance maximale — ils ont tous les droits sur toutes les
  -- boutiques — donc les bloquer au motif du plan n'aurait aucun sens.
  --
  -- Ce n'est pas une brèche : le rôle anon n'a aucun droit d'exécution sur ces
  -- fonctions (les GRANT vont à authenticated et service_role), et un appel
  -- authentifié a toujours un claim `sub`. Seuls service_role et les scripts
  -- arrivent ici avec un propriétaire NULL.
  IF get_business_owner_id() IS NULL THEN
    RETURN true;
  END IF;

  v_plan := current_org_plan();

  -- Comparaison par rang plutôt que par liste : ajouter un plan plus tard ne
  -- demande pas de réécrire les conditions. Les rangs sont mis dans des
  -- variables car un CASE nu comme opérande de comparaison n'est pas accepté
  -- par le parseur PL/pgSQL — il s'arrête sur « syntax error at end of input »,
  -- sans nommer la ligne fautive.
  v_rang_plan := CASE v_plan
    WHEN 'pro'     THEN 3
    WHEN 'starter' THEN 2
    ELSE 1
  END;

  v_rang_requis := CASE v_requis
    WHEN 'pro'     THEN 3
    WHEN 'starter' THEN 2
    ELSE 1
  END;

  IF v_rang_plan < v_rang_requis THEN
    RAISE EXCEPTION
      'La fonctionnalité « % » nécessite le plan % (plan actuel : %).',
      p_feature, v_requis, v_plan
      USING ERRCODE = '42501';
  END IF;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION require_feature(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION require_feature(text) TO authenticated;
GRANT EXECUTE ON FUNCTION require_feature(text) TO service_role;

COMMENT ON FUNCTION require_feature(text) IS
  'Lève une exception si le plan de la boutique ne permet pas la fonctionnalité. '
  'À appeler dans les fonctions payantes : le contrôle de plan ne peut pas '
  'vivre dans le navigateur, où un simple appel RPC le contourne.';


-- ─── 3. Les quantités vendues, pour les Prévisions ────────
-- Nouvelle fonction, et pas un simple verrou sur la requête existante : le
-- module Prévisions lisait sale_items ligne à ligne pour compter lui-même les
-- quantités vendues. Il ramenait donc TOUTES les lignes de vente de la période
-- dans le navigateur d'un client en plan gratuit — le chiffre d'affaires, jour
-- par jour, produit par produit. Un verrou posé sur l'écran n'aurait protégé
-- que l'affichage ; il fallait protéger les données.
--
-- La fonction retourne le même agrégat, calculé en base. Un client gratuit
-- reçoit une erreur, pas le chiffre d'affaires des trois derniers mois.
--
-- SECURITY INVOKER : l'isolation vient de la RLS de sale_items et sales. Le
-- contrôle de plan est ajouté, ce qui est une autre question.
DROP FUNCTION IF EXISTS get_units_sold_since(integer);
CREATE FUNCTION get_units_sold_since(p_days integer DEFAULT 30)
RETURNS TABLE (
  product_id uuid,
  quantity   numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  -- Le garde s'exécute avant l'agrégat : un client sans le plan ne voit pas
  -- les quantités, même agrégées. `true` pour laisser passer la ligne, et
  -- l'exception est levée par require_feature() si le plan ne suffit pas.
  SELECT si.product_id, SUM(si.quantity)
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
   WHERE (SELECT true FROM require_feature('forecast'))
     -- Borne basse : un nombre négatif ou absurde ne doit pas transformer la
     -- requête en plein scan de l'historique du client.
     AND p_days BETWEEN 1 AND 3650
     AND s.created_at >= now() - make_interval(days => p_days)
   GROUP BY si.product_id;
$$;

REVOKE ALL ON FUNCTION get_units_sold_since(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_units_sold_since(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION get_units_sold_since(integer) TO service_role;

COMMENT ON FUNCTION get_units_sold_since(integer) IS
  'Quantités vendues par produit sur les N derniers jours, agrégées en base. '
  'Remplace la lecture ligne à ligne de sale_items : le client ne reçoit plus '
  'l''historique complet. Exige le plan pro (fonctionnalité forecast).';
