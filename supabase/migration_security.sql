-- ============================================================
-- MIGRATION : Durcissement sécurité
-- A exécuter dans Supabase SQL Editor
-- ============================================================
--
-- Sept trous, du plus rapide au plus structurant :
--
--   1. rate_limits sans RLS      — le compteur d'inscription est effaçable
--                                   par n'importe quel client, clé anon en
--                                   main : `DELETE /rest/v1/rate_limits` et on
--                                   repasse à l'inscription illimitée.
--   2. organizations.plan libre  — n'importe quel client passe sa boutique en
--                                   Pro sans payer. current_org_plan(),
--                                   require_feature(), check_product_limit()
--                                   et la facturation Pro lisent tous cette
--                                   colonne.
--   3. subscriptions sans UNIQUE(org_id) — l'upsert du webhook échoue en
--                                   silence (supabase-js renvoie {error}, la
--                                   route ne le lit pas), le portail
--                                   abonnement répond 404 et un client Stripe
--                                   est recréé à chaque achat.
--   4. business_members FOR ALL  — un utilisateur peut rattacher un compte
--                                   arbitraire à son équipe : la victime voit
--                                   son tenant basculer chez l'attaquant.
--   5. sales / sale_items / stock_logs FOR ALL — créées sans clause FOR, donc
--                                   pour les quatre commandes. Un employé
--                                   pouvait UPDATE et DELETE les ventes de la
--                                   boutique, et le journal des stocks.
--   6. suppression de compte cassée — deux pannes de bout en bout relevées dans
--                                   les logs Auth : l'API renvoyait 500 sur
--                                   toute lecture d'utilisateur, et la
--                                   suppression d'un compte pourvu de ventes
--                                   échouait sur une FK.
--   7. la clé anon appelle tout   — Supabase accorde EXECUTE aux rôles anon,
--                                   authenticated et service_role au MOMENT DE
--                                   LA CRÉATION de chaque fonction
--                                   (ALTER DEFAULT PRIVILEGES). Le grant vient
--                                   du rôle, pas de PUBLIC : un
--                                   `REVOKE ... FROM PUBLIC`, écrit partout
--                                   dans les migrations, ne lui retire rien.
--                                   Constat en base le 03/10/2026 : 33 des 35
--                                   fonctions du schéma public répondaient à
--                                   la seule clé publique du navigateur, dont
--                                   20 en SECURITY DEFINER. Vérifié par appel
--                                   réel, la clé anonyme obtenait beta_status()
--                                   — réservée au service_role — et
--                                   close_beta_program(), SECURITY DEFINER
--                                   sans la moindre garde, aurait pu fermer le
--                                   programme bêta pour toutes les boutiques.
--
-- Le point 4 est refermé ici à deux niveaux (policy + trigger) et un troisième
-- dans l'application : la suppression du compte Auth en cascade n'est plus
-- appelée par /api/employees/[id].
--
-- Rejouable : IF NOT EXISTS / DROP … IF EXISTS / CREATE OR REPLACE partout.
-- Doit rester la DERNIÈRE migration du dossier supabase/ : c'est elle qui
-- ferme les failles ouvertes plus tôt, et les rejouer après l'aurait
-- taries.


-- ─── 1. rate_limits : hors portée du client ────────────────
-- bump_rate_limit() est SECURITY DEFINER et appartient au propriétaire de la
-- table. Sans FORCE, le propriétaire échappe à la RLS et la fonction continue
-- de tourner ; anon et authenticated, eux, se heurtent à l'absence totale de
-- policy — c'est le déni pur, pour SELECT comme pour DELETE.
--
-- FORCE ROW LEVEL SECURITY n'est volontairement PAS posée : elle soumettrait
-- aussi le propriétaire, donc bump_rate_limit() et purge_rate_limits(). Le
-- jour où le propriétaire de la table n'est plus le owner de la fonction, le
-- rate limit casserait — en silence, puisque l'appel est en fail-open.
ALTER TABLE rate_limits ENABLE ROW LEVEL SECURITY;

-- Aucune policy n'est créée : c'est le principe. Le service role, qui a
-- BYPASSRLS, est le seul à y accéder — et il n'y accède que par les deux
-- fonctions ci-dessus.


-- ─── 2. organizations.plan : verrouillé hors Stripe ────────
-- Deux couches, parce qu'une seule peut disparaître :
--   • le trigger refuse toute MODIFICATION de plan venant du navigateur ;
--   • les privilèges interdisent même de NOMMER la colonne plan.
-- Les deux sont indépendants : rejouer une GRANT ALL (ce que fait le harnais
-- de test, et ce que fait Supabase à la création d'une table) ne défait pas le
-- trigger.
CREATE OR REPLACE FUNCTION organizations_reject_plan_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- Plan inchangé : on laisse passer updated_at, onboarding_done, name, etc.
  IF NEW.plan IS NOT DISTINCT FROM OLD.plan THEN
    RETURN NEW;
  END IF;

  -- Deux rôles légitimes modifient le plan :
  --   • service_role — le webhook Stripe, seul détenteur du vrai plan ;
  --   • le rôle de l'éditeur SQL (postgres, supabase_admin) — vous, avec
  --     TEST_ACTIVER_PRO.sql ou close_beta_program().
  -- anon et authenticated sont les deux seuls rôles atteignables depuis le
  -- navigateur : PostgREST n'en autorise pas d'autre avec la clé anon. C'est
  -- donc une liste de négation, et non d'autorisation — le rôle exact de
  -- l'éditeur SQL varie selon les projets Supabase, une liste blanche le
  -- casserait sans prévenir.
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Le plan ne peut être modifié que par le paiement Stripe.'
    USING ERRCODE = '42501',
          HINT = 'Passez par le portail abonnement dans Paramètres, ou par TEST_ACTIVER_PRO.sql côté SQL Editor.';
END;
$$;

DROP TRIGGER IF EXISTS organizations_plan_guard ON organizations;
CREATE TRIGGER organizations_plan_guard
  BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION organizations_reject_plan_change();

-- La colonne par défaut est déjà 'free' : les INSERT du client nommaient
-- plan:'free' inutilement, ce qui les aurait fait échouer ici. Les deux
-- insertions de src/ ont été corrigées en même temps que cette migration.
--
-- Les valeurs écrites par un trigger échappent au contrôle de privilège (il ne
-- porte que sur les colonnes citées dans la requête) : beta_claim_slot()
-- continue donc de passer les dix comptes bêta en Pro.
REVOKE INSERT, UPDATE ON organizations FROM anon, authenticated;
GRANT INSERT  (id, name, slug, logo_url, timezone, currency, onboarding_done, address, ifu)
  ON organizations TO authenticated;
GRANT UPDATE (name, slug, logo_url, timezone, currency, onboarding_done, address, ifu)
  ON organizations TO authenticated;

-- Ni plan, ni invoice_counter, ni created_at : le premier est Stripe, le
-- deuxième est incrémenté par create_sale() en SECURITY DEFINER, les derniers
-- sont à la base.


-- ─── 3. subscriptions : une ligne par organisation ─────────
-- Le webhook fait upsert(..., { onConflict: 'org_id' }) depuis le tout premier
-- jour. PostgreSQL refuse un ON CONFLICT sans contrainte correspondante, et
-- supabase-js renvoie l'erreur dans { error } sans jamais la lever — l'échec
-- était donc totalement invisible.

-- Déduplication préalable : si une base a déjà reçu deux abonnements pour la
-- même org (par un insert direct, puisqu'échouer l'upsert), l'index refuserait
-- d'être créé. On garde la ligne la plus récente.
DELETE FROM subscriptions s
USING subscriptions k
WHERE s.org_id = k.org_id
  AND s.id <> k.id
  AND (COALESCE(k.updated_at, k.created_at, 'epoch'::timestamptz), k.id)
    > (COALESCE(s.updated_at, s.created_at, 'epoch'::timestamptz), s.id);

CREATE UNIQUE INDEX IF NOT EXISTS ux_subscriptions_org
  ON subscriptions (org_id);


-- ─── 4. business_members : lecture seule pour le client ────
-- La policy « owner_manage_members » était FOR ALL : un utilisateur pouvait
-- insérer (owner_id = soi, member_id = <uuid arbitraire>) et rattacher n'importe
-- quel compte à son équipe. Or :
--   • le tenant de la victime bascule chez l'attaquant (get_business_owner_id()
--     privilégie l'appartenance à une équipe) ;
--   • l'attaquant acquiert alors le droit de supprimer ce membre.
-- Aucune écriture client n'existe dans src/ : les insertions passent par
-- redeem_invitation() en SECURITY DEFINER, les suppressions par les routes API
-- en service role. La policy n'avait donc aucune raison d'être en écriture.
DROP POLICY IF EXISTS "owner_manage_members" ON business_members;
DROP POLICY IF EXISTS "owner_manage_members_select" ON business_members;
CREATE POLICY "owner_manage_members_select" ON business_members
  FOR SELECT USING (auth.uid() = owner_id);

-- Seconde couche : un compte qui possède déjà SA boutique ne peut devenir
-- membre d'une autre. Sans cela, inviter un patron détourne son tenant — et
-- supprimer ce lien, puis le compte Auth, détruisait sa boutique entière (tous
-- les ON DELETE CASCADE partent de auth.users).
--
-- SECURITY DEFINER indispensable : en RLS, une interrogation d'organizations
-- filtrée par la policy du candidat ne verrait pas la boutique d'un inconnu, et
-- la garde passerait exactement là où elle doit bloquer.
CREATE OR REPLACE FUNCTION business_members_reject_owner_member()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM organizations o WHERE o.id = NEW.member_id) THEN
    RAISE EXCEPTION 'Ce compte possède déjà sa propre boutique et ne peut pas rejoindre une autre équipe.'
      USING ERRCODE = '23514',
            HINT = 'Invitez un autre compte, ou transférez d''abord la boutique.';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION business_members_reject_owner_member() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION business_members_reject_owner_member() TO authenticated, service_role;

DROP TRIGGER IF EXISTS business_members_guard ON business_members;
CREATE TRIGGER business_members_guard
  BEFORE INSERT OR UPDATE ON business_members
  FOR EACH ROW EXECUTE FUNCTION business_members_reject_owner_member();


-- ─── 5. sales / sale_items / stock_logs : lecture pour le client ──
-- Ces trois policies ont été créées SANS clause FOR, ce qui vaut FOR ALL. Leur
-- prédicat est `user_id = get_business_owner_id()`, qui pour un employé
-- renvoie le PATRON : l'employé passait donc dans le USING comme dans le
-- WITH CHECK, et pouvait faire UPDATE et DELETE sur les ventes de la boutique.
-- Effacer la journée, effacer sa propre trace dans le journal des stocks —
-- depuis le navigateur, avec la seule clé anon.
--
-- Les policies RLS s'additionnent (OR) et ne se remplacent pas : il faut
-- bien DROP l'ancienne, sinon elle reste en place.
--
-- Aucune écriture client n'existe sur sales ni sale_items — tout passe par
-- create_sale(), record_credit_sale() et pay_customer_debt(), toutes en
-- SECURITY DEFINER. Ces fonctions tournent en propriétaire des tables et
-- contourneront donc la RLS ; le client n'a besoin que du SELECT.
--
-- stock_logs, lui, EST écrit par le client (réapprovisionnement,
-- inventaire). L'INSERT reste ouvert, mais sous le même garde-fou que les
-- dépenses et les dettes : can_manage_products(). Il est déjà exigé par
-- products_update, donc rien qui marchait ne cesse de marcher.

DROP POLICY IF EXISTS "user_sales" ON sales;
DROP POLICY IF EXISTS "user_sales_select" ON sales;
CREATE POLICY "user_sales_select" ON sales
  FOR SELECT USING (user_id = get_business_owner_id());

DROP POLICY IF EXISTS "user_sale_items" ON sale_items;
DROP POLICY IF EXISTS "user_sale_items_select" ON sale_items;
CREATE POLICY "user_sale_items_select" ON sale_items
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM sales
      WHERE sales.id = sale_items.sale_id
        AND sales.user_id = get_business_owner_id()
    )
  );

DROP POLICY IF EXISTS "user_stock_logs" ON stock_logs;
DROP POLICY IF EXISTS "user_stock_logs_select" ON stock_logs;
CREATE POLICY "user_stock_logs_select" ON stock_logs
  FOR SELECT USING (user_id = get_business_owner_id());

DROP POLICY IF EXISTS "user_stock_logs_insert" ON stock_logs;
CREATE POLICY "user_stock_logs_insert" ON stock_logs
  FOR INSERT WITH CHECK (
    user_id = get_business_owner_id()
    AND can_manage_products()
  );
-- Ni UPDATE ni DELETE : le journal des stocks est inaltérable. Une correction
-- se fait par un nouveau mouvement, jamais en réécrivant l'ancien.


-- ─── 6. Suppression de compte : deux blocages de bout en bout ──
-- Relevés dans les logs Auth (source `auth_logs`), qui nomment les deux causes
-- au mot près.
--
-- a) `GET /admin/users` → 500 « converting NULL to string is unsupported »
--    GoTrue lit confirmation_token dans un string Go non nullable : NULL lève
--    une erreur, '' passe. Un compte créé par le formulaire d'inscription a
--    '' ; un compte inséré à la main dans auth.users a laissé les colonnes jeton
--    à NULL. Une seule ligne suffisait : la liste des comptes ET la fiche d'un
--    compte devenaient illisibles, donc leur suppression depuis le Dashboard
--    aussi. Le PATCH ne touche que les lignes incomplètes.
--
-- b) `DELETE /admin/users/{id}` → 500 « delete on table "products" violates
--    foreign key constraint "sale_items_product_id_fkey" »
--    La suppression d'un compte remonte en cascade vers products AVANT sales
--    (l'ordre suit celui de création des contraintes, soit products avant sales
--    dans schema.sql). products partait donc quand sale_items le référençait
--    encore, et NO ACTION renvoyait l'erreur.
--    Rien n'est assoupli : la règle de suppression reste NO ACTION. Seule la
--    VÉRIFICATION est différée à la fin de la transaction, où sale_items a
--    disparu via sale_id (déjà en CASCADE). Une suppression isolée d'un produit
--    reste donc refusée, exactement comme avant.
--
-- Rejouable : COALESCE ne réécrit rien quand la valeur est déjà correcte, et
-- ALTER CONSTRAINT réappliqué sur la même valeur ne change rien.

UPDATE auth.users
   SET confirmation_token      = COALESCE(confirmation_token, ''),
       recovery_token          = COALESCE(recovery_token, ''),
       email_change_token_new  = COALESCE(email_change_token_new, ''),
       email_change            = COALESCE(email_change, '')
 WHERE confirmation_token IS NULL
    OR recovery_token IS NULL
    OR email_change_token_new IS NULL
    OR email_change IS NULL;

ALTER TABLE sale_items
  ALTER CONSTRAINT sale_items_product_id_fkey DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE stock_logs
  ALTER CONSTRAINT stock_logs_product_id_fkey DEFERRABLE INITIALLY DEFERRED;


-- ─── 7. La clé anon ne doit plus rien appeler ───────────────
--
-- 33 des 35 fonctions du schéma public répondaient à la seule clé publique du
-- navigateur, dont 20 en SECURITY DEFINER. Deux mécanismes, et il faut les
-- traiter tous les deux :
--
--   · Supabase accorde EXECUTE à anon, authenticated et service_role au moment
--     de la CRÉATION de chaque fonction (ALTER DEFAULT PRIVILEGES). Le grant
--     vient du rôle, donc un `REVOKE ... FROM PUBLIC` — écrit partout dans les
--     migrations — ne lui retire rien.
--   · PostgreSQL accorde par ailleurs EXECUTE à PUBLIC sur toute fonction
--     dont l'ACL n'a pas été touchée. anon hérite de ce droit comme de tout
--     autre : vérifié, c'était le cas de 12 fonctions (update_updated_at,
--     check_product_limit, fill_amount_received, purge_rate_limits…).
--
-- Aucun chemin de l'application n'en avait besoin — vérifié fonction par
-- fonction :
--
--   · les huit routes API construisent leur client avec la service role,
--     l'unique exception étant /api/register qui n'utilise le client anon que
--     pour auth.signInWithPassword ;
--   · src/proxy.ts appelle bump_rate_limit() et purge_rate_limits() en fetch
--     direct, avec la service role ;
--   · les modules du tableau de bord ne se montrent qu'après
--     `if (!user) return <LoginPage />` — donc jamais en rôle anon ;
--   · les trois pages publiques (inscription, invitation, réinitialisation)
--     n'appellent que GoTrue, jamais une fonction SQL.
--
-- Deux exceptions, et elles ne sont pas des indulgences. Les policies RLS
-- appellent get_business_owner_id() et can_manage_products(), et une policy
-- s'évalue sous le rôle de l'appelant : sans EXECUTE, une lecture non
-- authentifiée renverrait « permission denied for function » au lieu de zéro
-- ligne. Pour anon, les deux renvoient NULL, donc faux — aucun accès n'est
-- concédé, seul le code de retour changerait.
--
-- `authenticated` n'est PAS re-granté en bloc : ce serait rouvrir
-- close_beta_program(), set_beta_slots() et revoke_all_beta() à n'importe quel
-- client connecté. Les migrations concernées accordent déjà EXECUTE à qui de
-- droit, et le harnais vérifie en 22b que les douze fonctions que le
-- navigateur appelle réellement le restent.
--
-- Les ALTER DEFAULT PRIVILEGES doublent le REVOKE sur ALL : sans eux, la
-- prochaine migration créerait une fonction et lui rouvrirait la porte
-- d'elle-même.
--
-- Rejouable : REVOKE et GRANT sont idempotents.

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM anon;

GRANT EXECUTE ON FUNCTION get_business_owner_id() TO anon;
GRANT EXECUTE ON FUNCTION can_manage_products()   TO anon;
