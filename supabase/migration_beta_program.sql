-- ============================================================
-- PROGRAMME BÊTA — 10 comptes en accès complet
-- À exécuter dans Supabase SQL Editor
--
-- LE BESOIN
--   Tester en grandeur nature, avec des gens qui ne sont pas le développeur.
--   Dix amis s'inscrivent, ils ouvrent l'application, ils la cassent, et ils
--   disent ce qui manque. C'est le seul moyen de trouver les défauts qu'aucun
--   test automatique ne voit — un prix qui ne s'affiche pas sur un petit
--   écran, un libellé que personne ne comprend, un geste que la caissière ne
--   fait pas parce qu'il n'y est pas.
--
-- POURQUOI UN TRIGGER ET PAS L'APPLICATION
--   Trois chemins créent une organisation : /api/register, la page
--   /register en deux étapes, et l'onboarding de la page d'accueil. Les
--   modifier tous serait trois endroits à tenir d'accord, et le quatrième
--   chemin oublié donnerait un compte gratuit sans qu'on le voie.
--
--   Le trigger est le seul point par où passe toute création de boutique. Il
--   s'applique donc partout, y compris aux chemins qu'on n'a pas prévus, et il
--   ne demande aucune modification de l'application.
--
-- UNE PLACE, PAS UNE PROMESSE
--   Le programme est un budget de 10 places, pas un code d'accès. Il n'y a rien
--   à distribuer et donc rien à trouver : le 11e compte s'inscrit normalement,
--   en gratuit. Une fois les 10 pris, le programme est fermé et le comportement
--   redevient exactement celui d'une inscription normale.
--
--   Fermer définitivement :  SELECT close_beta_program();
--   Changer le nombre de places : UPDATE beta_program SET slots_total = 20;
--   Tout révoquer d'un coup : SELECT revoke_all_beta();
--
-- CE QUI N'EST PAS FAIT, ET POURQUOI
--   Pas de date d'expiration. Une date non appliquée par un trigger planifié
--   est pire qu'aucune date : on croit que l'accès s'arrêtera tout seul, et il
--   ne s'arrête pas. Le budget est fermé par une commande explicite, donc ce
--   qui est promis est ce qui se produit.
--
--   Pas d'accès « illimité » distinct. Un compte bêta est un compte Pro. Une
--   neuvième façon de dire « actif » serait une neuvième source de vérité.
-- ============================================================

-- ─── 1. Le budget ─────────────────────────────────────────
-- Une seule ligne, contrainte à l'identifiant 1 : il n'y a pas de deuxième
-- ligne à créée, donc pas d'état ambigu sur « combien de places restent ».
CREATE TABLE IF NOT EXISTS beta_program (
  id           int PRIMARY KEY DEFAULT 1,
  -- Modifiable à tout moment par un simple UPDATE. 10 par défaut, ce qui est la
  -- demande initiale.
  slots_total  int  NOT NULL DEFAULT 10,
  slots_used   int  NOT NULL DEFAULT 0,
  open         boolean NOT NULL DEFAULT true,
  -- Rappel de pourquoi le programme existe, et jusqu'à quand. Servira au moment
  -- de décider quoi faire des comptes bêta.
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT beta_program_singleton   CHECK (id = 1),
  CONSTRAINT beta_program_cap_positif CHECK (slots_total >= 0),
  -- L'invariant central : impossible d'avoir servi plus de places que le budget.
  -- Une inscription concurrente qui chercherait à dépasser le plafond violerait
  -- cette contrainte et la transaction entière serait annulée, plutôt que de
  -- laisser un onzième compte Pro.
  CONSTRAINT beta_program_dans_le_budget CHECK (slots_used >= 0 AND slots_used <= slots_total)
);

INSERT INTO beta_program (id, slots_total, note)
VALUES (1, 10, 'Dix comptes en accès Pro pour les tests en conditions réelles.')
ON CONFLICT (id) DO UPDATE
  SET note = EXCLUDED.note;
-- ⚠ ON CONFLICT ne touche PAS slots_used : rejouer la migration ne doit pas
--   réinitialiser le compteur, sinon une réapplication donnerait 10 places
--   neuves et le programme ne se fermerait jamais.


-- ─── 2. Qui a eu une place ────────────────────────────────
-- Pas seulement un journal : cette table est l'outil de travail du test. Les
-- colonnes de retour existent pour ça, sinon l'information se perd dans des
-- messages privés et ne sert à rien.
CREATE TABLE IF NOT EXISTS beta_access (
  user_id    uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  email      text,
  plan       text NOT NULL DEFAULT 'pro' CHECK (plan IN ('free', 'starter', 'pro')),
  granted_at timestamptz NOT NULL DEFAULT now(),

  -- Le matériau du debriefing, écrit au fil de l'eau.
  avis       text,   -- ce que la personne a dit, en ses mots
  bugs       text,   -- ce qui ne marche pas, avec la façon de reproduire
  manques    text,   -- ce qui manque, ce qu'elle aurait aimé avoir
  teste_le   date,

  CONSTRAINT beta_access_one_row_per_shop CHECK (user_id IS NOT NULL)
);

COMMENT ON TABLE beta_access IS
  'Comptes bêta et retours associés. Les colonnes avis / bugs / manques sont le '
  'point d''accumulation des retours de test : à remplir au fil des tests, puis '
  'à relire dans cet ordre pour décider quoi corriger.';

-- Aucune policy : ces tables sont des outils d'administration. Le trigger qui
-- écrit dedans est SECURITY DEFINER, donc il n'en a pas besoin, et le client
-- n'a rien à y voir. Un testeur ne doit pas pouvoir élargir son accès lui-même.
ALTER TABLE beta_program  ENABLE ROW LEVEL SECURITY;
ALTER TABLE beta_access   ENABLE ROW LEVEL SECURITY;
ALTER TABLE beta_program  FORCE ROW LEVEL SECURITY;
ALTER TABLE beta_access   FORCE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_beta_access_granted ON beta_access(granted_at DESC);

-- ─── 3. L'attribution ─────────────────────────────────────
-- Le travail est partagé par deux triggers, et ce n'est pas un détail de style :
-- beta_access référence organizations, donc la ligne doit EXISTER avant d'y
-- écrire. Un seul trigger BEFORE — le plus naturel, puisque c'est lui qui
-- modifie NEW.plan — violerait la clé étrangère à chaque inscription, ce que
-- PostgreSQL refuse avec « insert or update on table beta_access violates
-- foreign key constraint ».
--
--   BEFORE INSERT  consomme une place et passe NEW.plan à 'pro'
--   AFTER  INSERT  enregistre la fiche, maintenant que la boutique existe
--
-- La décision est transmise par un GUC, remis à NULL dans tous les cas. Le motif
-- est le même que credit.internal dans create_sale() : un état de session, donc
-- non modifiable par un client SQL ordinaire, qui ne laisse rien entre deux
-- requêtes. Si le trigger AFTER levait une exception, l'INSERT entier serait
-- annulé — Trigger et transaction, donc aucune place consommée sans boutique.
--
-- Le point clé de la consommation : un UPDATE unique, gardé par une condition, et
-- non un SELECT suivi d'un UPDATE.
--
-- Deux inscriptions simultanées lisent toutes deux slots_used = 9 et se croient
-- toutes deux autorisées. Avec un seul UPDATE ... WHERE slots_used <
-- slots_total, PostgreSQL reverifie la condition apres avoir pris le verrou de
-- ligne : la seconde transaction voit slots_used = 10, ne modifie aucune ligne,
-- et l'INSERT ne consomme aucune place. C'est ce qui rend le plafond exact sous
-- concurrence, sans SERIALIZABLE ni reessai.
CREATE OR REPLACE FUNCTION beta_claim_slot()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pris int;
BEGIN
  PERFORM set_config('beta.granted', '0', true);

  -- Programme fermé : on ne touche à rien.
  IF NOT EXISTS (SELECT 1 FROM beta_program WHERE id = 1 AND open) THEN
    RETURN NEW;
  END IF;

  UPDATE beta_program
     SET slots_used = slots_used + 1,
         updated_at = now()
   WHERE id = 1
     AND open
     AND slots_used < slots_total;

  GET DIAGNOSTICS v_pris = ROW_COUNT;

  -- Plus de place : la boutique est créée en gratuit, sans aucune trace. C'est
  -- le comportement normal d'une inscription, pas une erreur — le onzième ami
  -- doit pouvoir s'inscrire, simplement sans l'accès complet.
  IF v_pris = 0 THEN
    RETURN NEW;
  END IF;

  PERFORM set_config('beta.granted', '1', true);
  NEW.plan := 'pro';
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION beta_record_access()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email   text;
  v_accorde text;
BEGIN
  -- La décision est LUE avant d'être effacée. L'inverse — effacer puis lire —
  -- lirait toujours NULL, donc aucune fiche ne serait jamais écrite, et le
  -- programme accorderait l'accès sans rien enregistrer : le pire des deux
  -- mondes, puisque le plafond serait consommé sans que personne sache à qui.
  v_accorde := current_setting('beta.granted', true);
  PERFORM set_config('beta.granted', NULL, true);

  IF v_accorde IS DISTINCT FROM '1' THEN
    RETURN NULL;
  END IF;

  -- L'email est sur auth.users, pas sur organizations. Le sous-requête tolère son
  -- absence : une organisation créée hors du flux d'inscription (script,
  -- importation) reçoit une place sans email, ce qui reste identifiable par
  -- l'identifiant.
  SELECT u.email INTO v_email FROM auth.users u WHERE u.id = NEW.id;

  INSERT INTO beta_access (user_id, email, plan)
  VALUES (NEW.id, v_email, 'pro')
  ON CONFLICT (user_id) DO UPDATE
    SET plan = EXCLUDED.plan;

  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION beta_claim_slot() IS
  'Consomme une place du budget bêta et passe la boutique en Pro. Sans quoi la '
  'boutique est créée en gratuit. L''attribution est atomique : sous '
  'concurrence, le plafond reste exact.';

COMMENT ON FUNCTION beta_record_access() IS
  'Enregistre la fiche bêta, après coup : beta_access référence organizations, la '
  'ligne doit donc exister avant. Ne fait rien si aucune place n''a été '
  'consommée par beta_claim_slot().';

DROP TRIGGER IF EXISTS trg_beta_claim_slot ON organizations;
CREATE TRIGGER trg_beta_claim_slot
  BEFORE INSERT ON organizations
  FOR EACH ROW
  EXECUTE FUNCTION beta_claim_slot();

DROP TRIGGER IF EXISTS trg_beta_record_access ON organizations;
CREATE TRIGGER trg_beta_record_access
  AFTER INSERT ON organizations
  FOR EACH ROW
  EXECUTE FUNCTION beta_record_access();

-- ─── 4. Commandes d'administration ────────────────────────
-- Ce que le propriétaire du projet executera. Elles sont en SQL et non dans
-- l'application : ce sont des decisions de gestion, pas des fonctionnalites.

-- Ferme le programme. Les comptes deja servis gardent leur acces : fermer
-- arrete les inscriptions, ca ne retire rien a ceux qui sont deja testes.
CREATE OR REPLACE FUNCTION close_beta_program()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE beta_program
     SET open = false,
         updated_at = now(),
         note = COALESCE(note, '') || ' — programme clos.'
   WHERE id = 1;
$$;

-- Rouvre, et ajuste le budget. Pratique pour une deuxieme vague de testeurs.
CREATE OR REPLACE FUNCTION set_beta_slots(p_total int)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE beta_program
     SET slots_total = p_total,
         open = true,
         updated_at = now()
   WHERE id = 1;
$$;

-- Retombe tout le monde en gratuit et vide le compteur. Le geste de fermeture
-- reelle : sans lui, dix boutiques Pro continueraient d'etre Pro indefiniment.
-- Les commentaires de retour sont conserves : ils sont le prix du test.
CREATE OR REPLACE FUNCTION revoke_all_beta()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_n int;
BEGIN
  UPDATE organizations o
     SET plan = 'free'
   WHERE o.id IN (SELECT user_id FROM beta_access);

  GET DIAGNOSTICS v_n = ROW_COUNT;

  UPDATE beta_access SET plan = 'free';
  UPDATE beta_program
     SET slots_used = 0,
         open = false,
         updated_at = now()
   WHERE id = 1;

  -- %s et non %d : le spécificateur « d » de format() n'est pas accepté par
  -- toutes les versions de PostgreSQL, et l'échec ici serait bien pire que la
  -- révision : une commande d'administration qui ne compile pas.
  RETURN format('%s boutique(s) repassée(s) en gratuit. Les retours sont conservés.', v_n::text);
END;
$$;

-- Etat du programme, en une ligne.
CREATE OR REPLACE FUNCTION beta_status()
RETURNS TABLE (
  open        boolean,
  slots_total int,
  slots_used  int,
  remaining   int,
  granted     bigint,
  note        text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT b.open, b.slots_total, b.slots_used,
         GREATEST(b.slots_total - b.slots_used, 0),
         (SELECT count(*) FROM beta_access WHERE plan = 'pro'),
         b.note
    FROM beta_program b
   WHERE b.id = 1;
$$;

REVOKE ALL ON FUNCTION close_beta_program()   FROM PUBLIC;
REVOKE ALL ON FUNCTION set_beta_slots(int)    FROM PUBLIC;
REVOKE ALL ON FUNCTION revoke_all_beta()      FROM PUBLIC;
REVOKE ALL ON FUNCTION beta_status()          FROM PUBLIC;
GRANT EXECUTE ON FUNCTION beta_status() TO service_role;

-- Les trois commandes d'ecriture restent reservees : elles se lancent depuis le
-- SQL Editor, ou le service role. Aucun client ne doit pouvoir fermer le
-- programme, ajouter des places, ni remettre dix boutiques en gratuit.
GRANT EXECUTE ON FUNCTION close_beta_program()   TO service_role;
GRANT EXECUTE ON FUNCTION set_beta_slots(int)    TO service_role;
GRANT EXECUTE ON FUNCTION revoke_all_beta()      TO service_role;
