-- ============================================================================
-- Équipe : gérer ses employés sans clé service role
-- ============================================================================
--
-- Pourquoi
-- -------
-- Deux routes de l'application (/api/employees, /api/employees/[id]) et une
-- troisième (/api/invitations) utilisaient la clé `service_role`. Cette clé
-- contourne TOUTES les règles de sécurité de la base : la pose sur chaque
-- poste de développement et sur chaque build est un risque disproportionné
-- pour deux opérations — changer le rôle d'un employé, retirer un employé de
-- son équipe.
--
-- Le contournement n'était même pas nécessaire. migration_security.sql a
-- volontairement supprimé toute écriture client sur `business_members` :
--
--   DROP POLICY "owner_manage_members" ;  -- FOR ALL, trop large
--
-- et l'a remplacée par une lecture seule (`auth.uid() = owner_id`). Les
-- routes rechargeaient ensuite la clé service pour écrire quand même — donc
-- exactement ce que cette migration voulait empêcher.
--
-- Ce que fait cette migration
-- --------------------------
-- Deux fonctions SECURITY DEFINER, sur le modèle de `redeem_invitation()` que
-- le projet a déjà adopté : l'autorisation vit DANS la fonction, en un seul
-- endroit vérifiable, et la table reste sans écriture client. Un appel direct
-- sur `business_members` échoue toujours.
--
--   business_members_set_role(member_id, role)
--   business_members_remove(member_id)
--
-- `employee_invitations` n'a pas besoin de fonction : sa policy
-- `invitations_owner_write` est déjà FOR ALL sur `auth.uid() = owner_id`. Le
-- patron gère ses invitations avec sa propre session. C'est aussi ce qui rend
-- le contrôle « est-ce un patron ? » traître si on le fait naïvement (voir
-- plus bas, dans les routes).
--
-- Ce qui reste avec la clé
-- -------------------------
-- `/api/register` et `/api/invitations/accept` : créer un compte Auth, et
-- partager un limiteur entre les instances serverless. Ces deux opérations
-- n'ont pas de patron derrière elles — il n'existe pas encore de jeton, ou
-- l'appelant est anonyme. La clé y est légitime.
--
-- `/api/stripe/*` : abonnements et webhooks. Également légitime.
--
-- En revanche, `purge_accepted_invitations()` n'en avait pas besoin. Elle
-- effaçait les invitations de TOUTES les boutiques et n'était donc pas
-- exécutable par un client — ce qui la rendait, de fait, la raison d'être de
-- la clé dans l'écran Équipe. Elle est recentrée sur une boutique (section 3).

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Changer le rôle d'un employé
-- ────────────────────────────────────────────────────────────────────────────
-- Le rôle decide de ce que le membre peut faire ; `migration_roles.sql` s'appuie
-- dessus. On le borne explicitement plutôt que de faire confiance à l'appelant.
CREATE OR REPLACE FUNCTION business_members_set_role(p_member_id uuid, p_role text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_ligne business_members%ROWTYPE;
BEGIN
  IF p_role IS NULL OR p_role NOT IN ('employee', 'manager') THEN
    RAISE EXCEPTION 'Rôle invalide : %', p_role USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_ligne
    FROM business_members
   WHERE member_id = p_member_id AND owner_id = auth.uid();

  -- Absence de ligne : soit l'employé n'existe pas, soit il appartient à
  -- quelqu'un d'autre. Les deux cas rendent la même chose à l'appelant : on ne
  -- confirme pas l'existence d'une équipe qui n'est pas la sienne.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Employé introuvable' USING ERRCODE = 'P0002';
  END IF;

  -- Un patron qui se retire lui-même de sa propre équipe disparaît de la
  -- boutique : get_business_owner_id() privilégie l'appartenance à une équipe,
  -- et le patron ne verrait plus rien de ce qu'il possède.
  IF v_ligne.member_id = v_ligne.owner_id THEN
    RAISE EXCEPTION 'Le patron ne peut pas modifier son propre rôle'
      USING ERRCODE = '22023';
  END IF;

  UPDATE business_members SET role = p_role WHERE id = v_ligne.id;
  RETURN true;
END;
$function$;

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Retirer un employé de l'équipe
-- ────────────────────────────────────────────────────────────────────────────
-- On supprime le LIEN, jamais le compte Auth : organizations, products, sales et
-- stock_logs partent tous en ON DELETE CASCADE depuis auth.users. Supprimer le
-- compte détruisait donc la boutique entière du membre — ce qui est arrivé
-- dans le cas d'un patron invité comme employé ailleurs.
--
-- Le compte reste, sans lien : il ne voit plus rien et peut se reconnecter. Le
-- poste est bien libéré, puisque le plan compte membres + invitations en
-- attente.
CREATE OR REPLACE FUNCTION business_members_remove(p_member_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_ligne business_members%ROWTYPE;
BEGIN
  SELECT * INTO v_ligne
    FROM business_members
   WHERE member_id = p_member_id AND owner_id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Employé introuvable' USING ERRCODE = 'P0002';
  END IF;

  IF v_ligne.member_id = v_ligne.owner_id THEN
    RAISE EXCEPTION 'Le patron ne peut pas se retirer de sa propre équipe'
      USING ERRCODE = '22023';
  END IF;

  DELETE FROM business_members WHERE id = v_ligne.id;
  RETURN true;
END;
$function$;

-- `authenticated`, et non `service_role` : ce sont les clients, mais la
-- fonction vérifie elle-même que l'appelant est bien le patron concerné. Une
-- fonction en service_role serait plus simple à écrire et laisserait la porte
-- ouverte à quiconque masquerait son identité derrière la clé.
REVOKE ALL ON FUNCTION business_members_set_role(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION business_members_remove(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION business_members_set_role(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION business_members_remove(uuid) TO authenticated;

COMMENT ON FUNCTION business_members_set_role(uuid, text) IS
  'Change le rôle d''un membre de l''équipe. N''écrit que si l''appelant est le '
  'patron de cette équipe ; refuse le patron lui-même.';
COMMENT ON FUNCTION business_members_remove(uuid) IS
  'Retire un membre de l''équipe (supprime le lien, jamais le compte Auth). '
  'N''écrit que si l''appelant est le patron de cette équipe.';

-- ────────────────────────────────────────────────────────────────────────────
-- 3. Le nettoyage des invitations-consommées redevient possible sans la clé
-- ────────────────────────────────────────────────────────────────────────────
-- Elle était appelée en « fire-and-forget » à chaque ouverture de l'écran
-- Équipe, depuis une route en clé service — d'où la présence de cette clé dans
-- le projet pour une opération de nettoyage, et un écran qui dépendait d'un
-- secret dont l'absence était silencieuse.
--
-- La fonction effaçait les invitations de TOUTES les boutiques, ce qui est
-- incompatible avec un droit d'exécution client : un utilisateur authentifié
-- purgerait les invitations de tout le monde. Elle est donc recentrée sur une
-- seule boutique, et le contrôle du propriétaire est fait DEDANS — la RLS ne
-- filtre pas un DELETE exécuté par une fonction SECURITY DEFINER.
--
-- C'est ce qui permet de la rappeler depuis la route, avec la session du
-- patron : le nettoyage redevient effectif sans clé service, ce qu'il n'était
-- plus du tout une fois l'appel retiré de la route.
DROP FUNCTION IF EXISTS purge_accepted_invitations(int);

CREATE OR REPLACE FUNCTION purge_accepted_invitations(p_owner_id uuid, p_days int DEFAULT 7)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_deleted bigint;
BEGIN
  -- Sans cette garde, un patron pourrait passer l'identifiant d'un autre et
  -- effacer ses invitations : c'est le seul contrôle qui tient, puisque la
  -- fonction s'exécute avec les droits du propriétaire de la table.
  IF p_owner_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Purge refusée : ce n''est pas votre équipe'
      USING ERRCODE = '42501';
  END IF;

  DELETE FROM employee_invitations
    WHERE owner_id = p_owner_id
      AND accepted_at IS NOT NULL
      AND accepted_at < now() - make_interval(days => p_days);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$function$;

REVOKE ALL ON FUNCTION purge_accepted_invitations(uuid, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_accepted_invitations(uuid, int) TO authenticated;

COMMENT ON FUNCTION purge_accepted_invitations(uuid, int) IS
  'Supprime les invitations déjà consommées et expirées d''une boutique. '
  'N''agit que sur la boutique de l''appelant.';
