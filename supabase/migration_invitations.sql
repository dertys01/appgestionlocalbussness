-- ============================================================
-- MIGRATION INVITATIONS — GestionLocal
-- À exécuter dans Supabase SQL Editor, après migration_expenses.sql
--
-- L'ajout d'un employé demandait au patron d'inventer un mot de passe et de
-- le transmettre par un canal non chiffré (WhatsApp, papier). C'est le chemin
-- le plus probable pour qu'un accès client soit compromis, et cela suppose
-- aussi que le commerce possède déjà une boîte mail.
--
-- On remplace ceflux par une invitation :
--
--   1. Le patron saisit l'email, reçoit un lien à transmettre
--   2. L'employé ouvre le lien, choisit son propre mot de passe
--   3. redeem_invitation() lie le compte à la boutique, de façon atomique
--
-- Le jeton ne transite jamais par l'API en clair après la création : il est
-- stocké tel quel, comme un secret à usage unique. La table est par ailleurs
-- inaccessible au client (RLS + RLS du patron), donc seul le service_role la
-- lit.
-- ============================================================

-- ─── 1. Les invitations ────────────────────────────────────
CREATE TABLE IF NOT EXISTS employee_invitations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email       text NOT NULL,
  role        text NOT NULL DEFAULT 'employee' CHECK (role IN ('employee', 'manager')),
  token       text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  accepted_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT employee_invitations_email_lower CHECK (email = lower(btrim(email))),
  CONSTRAINT employee_invitations_token_len   CHECK (length(token) >= 32)
);

ALTER TABLE employee_invitations ENABLE ROW LEVEL SECURITY;

-- Le patron voit et gère ses invitations. Un employé n'en a pas : get_business_owner_id()
-- renverrait son patron, il pourrait donc lire les invitations de la boutique
-- et s'inviter lui-même. On vérifie explicitement qu'il est le patron.
DROP POLICY IF EXISTS "invitations_owner_read" ON employee_invitations;
CREATE POLICY "invitations_owner_read" ON employee_invitations
  FOR SELECT USING (auth.uid() = owner_id);

DROP POLICY IF EXISTS "invitations_owner_write" ON employee_invitations;
CREATE POLICY "invitations_owner_write" ON employee_invitations
  FOR ALL USING (auth.uid() = owner_id) WITH CHECK (auth.uid() = owner_id);

-- Index sur owner_id : le patron liste ses invitations à chaque affichage.
CREATE INDEX IF NOT EXISTS idx_employee_invitations_owner
  ON employee_invitations(owner_id, created_at DESC);


-- ─── 2. Remboursement atomique ──────────────────────────────
-- L'employé s'inscrit depuis un lien ; cette fonction consume l'invitation et
-- crée le lien de membre en une transaction. FOR UPDATE sérialise deux
-- usages simultanés du même lien : le second reçoit "déjà utilisée" au lieu de
-- créer un second membre.
--
-- SECURITY DEFINER est nécessaire : l'appelant n'est pas encore membre de la
-- équipe, donc la policy member_view_own ne lui accorde rien. La fonction
-- est révoquée au public et accordée au service_role, qui est le seul à
-- l'appeler (la route d'acceptation, via la clé service role).
CREATE OR REPLACE FUNCTION redeem_invitation(
  p_token       text,
  p_member_id   uuid,
  p_member_name text
)
RETURNS TABLE (owner_id uuid, email text, member_name text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inv employee_invitations%ROWTYPE;
BEGIN
  SELECT * INTO v_inv
    FROM employee_invitations
    WHERE token = p_token
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cette invitation est introuvable ou a été révoquée.'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_inv.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Cette invitation a déjà été utilisée.'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_inv.expires_at < now() THEN
    RAISE EXCEPTION 'Cette invitation a expiré. Demandez un nouveau lien à votre patron.'
      USING ERRCODE = 'P0002';
  END IF;

  -- L'email saisi doit être celui invité : sinon un lien peut être intercepté
  -- et réutilisé pour s'attribuer la boutique.
  -- La colonne est qualifiée : « email » seul serait ambigu entre auth.users et
  -- la table RETURNS (owner_id, email, member_name).
  IF NOT EXISTS (
    SELECT 1 FROM auth.users u
    WHERE u.id = p_member_id
      AND lower(btrim(u.email)) = v_inv.email
  ) THEN
    RAISE EXCEPTION 'Ce lien invite uniquement %', v_inv.email
      USING ERRCODE = 'P0002';
  END IF;

  IF length(btrim(p_member_name)) = 0 THEN
    RAISE EXCEPTION 'Le nom est obligatoire.' USING ERRCODE = '22023';
  END IF;

  INSERT INTO business_members (owner_id, member_id, member_name, role)
  SELECT v_inv.owner_id, p_member_id, btrim(p_member_name), v_inv.role
  WHERE NOT EXISTS (
    SELECT 1 FROM business_members x
    WHERE x.owner_id = v_inv.owner_id AND x.member_id = p_member_id
  );

  UPDATE employee_invitations ei SET accepted_at = now() WHERE ei.id = v_inv.id;

  RETURN QUERY SELECT v_inv.owner_id, v_inv.email, btrim(p_member_name);
END;
$$;

REVOKE ALL ON FUNCTION redeem_invitation(text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION redeem_invitation(text, uuid, text) TO service_role;

COMMENT ON FUNCTION redeem_invitation(text, uuid, text) IS
  'Consomme une invitation et lie le compte à la boutique. Vérifie que le compte '
  'correspond à l''email invité, refuse une invitation déjà utilisée ou expirée. '
  'Appelée uniquement par le service_role.';

COMMENT ON TABLE employee_invitations IS
  'Invitations d''équipe en attente. Le jeton est un secret à usage unique, '
  'expirant après 7 jours ; il est transmis au patron pour un envoi WhatsApp '
  'ou tout autre canal, jamais par email.';


-- ─── 3. Nettoyage ───────────────────────────────────────────
-- Les invitations acceptées ne servent plus à rien. Sans cette étape la table
-- grossit indéfiniment et conserve des emails d'employés partis.
-- Le token étant consommé et l'email de l'employé devenu inutile, la suppression est sans
-- risque : l'invitation n'a plus de valeur d'accès.
--
-- À appeler périodiquement (pg_cron côté Supabase, ou à la main) :
--
--   SELECT purge_accepted_invitations();
--
CREATE OR REPLACE FUNCTION purge_accepted_invitations(p_days int DEFAULT 7)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted bigint;
BEGIN
  DELETE FROM employee_invitations
    WHERE accepted_at IS NOT NULL
      AND accepted_at < now() - make_interval(days => p_days);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION purge_accepted_invitations(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_accepted_invitations(int) TO service_role;
