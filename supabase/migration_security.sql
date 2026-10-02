-- ============================================================
-- MIGRATION : Durcissement sécurité
-- A exécuter dans Supabase SQL Editor
-- ============================================================
--
-- Quatre trous, du plus rapide au plus structurant :
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
