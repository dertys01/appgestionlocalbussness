-- ============================================================
-- MIGRATION — Mode d'ouverture de l'application — GestionLocal
-- À exécuter dans Supabase SQL Editor, après migration_activation_funnel.sql
--
-- POURQUOI
--   P2 (application installable, 08/10/2026) et P3 (mesure du parcours)
--   se répondent : savoir que les pilotes s'inscrivent ne dit pas s'ils
--   ouvrent GestionLocal depuis l'icône installée sur leur écran d'accueil
--   ou depuis un onglet du navigateur. C'est l'hypothèse « la rétention
--   vient de l'icône » qui devient vérifiable, dans le même relevé que le
--   parcours d'activation.
--
-- CE QU'ELLE FAIT
--   • organizations.display_mode      'standalone' (application installée,
--                                     plein écran) ou 'navigateur' ;
--                                     NULL = jamais relevé.
--   • organizations.display_mode_at   quand ce mode a été relevé pour la
--                                     dernière fois — le mode change : le
--                                     patron installe l'app entre deux
--                                     visites, l'horodatage dit laquelle
--                                     des deux valeurs est la plus fraîche.
--   • get_activation_funnel() NE CHANGE PAS : le relevé du parcours se
--     sert de ces colonnes par une jointure (scripts/funnel.mjs). Changer
--     son type de retour obligerait à DROP + CREATE sur une fonction déjà
--     en production, pour la même information — inutilelement risqué.
--
--   SANS DÉFAUT, comme il se doit : « ADD COLUMN ... DEFAULT » remplirait
--   toutes les lignes existantes d'un mode qu'elles n'ont jamais eu (le
--   garde-fous du dépôt vaut pour toute colonne d'affichage). NULL veut
--   dire « pas encore relevé », et le relevé se fait tout seul à la
--   prochaine connexion du patron.
--
-- QUI ÉCRIT
--   Le client (SupabaseProvider), session patron seule, et seulement
--   quand le mode diffère de celui déjà stocké : une écriture par
--   changement de mode, pas une par visite. La RLS « Patron modifie sa
--   propre org » (migration_saas.sql) refuse déjà les employés — le
--   relevé est volontairement à la charge du seul commerçant que la
--   mesure suit.
--
-- SÉCURITÉ
--   • CHECK sur les deux valeurs : une valeur inconnue écraserait la
--     mesure sans jamais échouer visiblement.
--   • GRANT colonne par colonne : migration_security.sql a REVOKEt la
--     table en entier, une colonne ajoutée plus tard naît sans droit
--     d'écriture — même motif que migration_domain.sql et
--     migration_onboarding_mode.sql.
--
-- Rejouable : IF NOT EXISTS, garde de contrainte, GRANT idempotent.
-- ============================================================

-- ─── 1. Les colonnes ────────────────────────────────────────
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS display_mode text,
  ADD COLUMN IF NOT EXISTS display_mode_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'organizations_display_mode_check') THEN
    ALTER TABLE organizations
      ADD CONSTRAINT organizations_display_mode_check
      CHECK (display_mode IS NULL
             OR display_mode IN ('standalone', 'navigateur'));
  END IF;
END;
$$;


-- ─── 2. Le droit d'écrire ces colonnes ───────────────────────
--
-- Sans ce GRANT, la première tentative du patron échouerait en
-- « permission denied for table organizations » — et l'échec serait
-- invisible : le client n'attend pas la réponse (écriture non
-- bloquante), la mesure resterait à NULL sans dire pourquoi.
GRANT UPDATE (display_mode, display_mode_at) ON organizations TO authenticated;
