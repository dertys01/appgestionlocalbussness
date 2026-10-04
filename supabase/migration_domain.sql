-- ============================================================
-- MIGRATION DOMAINE — GestionLocal
-- A exécuter dans Supabase SQL Editor, après migration_security.sql
--
-- Un compte, deux domaines : commerce (caisse comptoir) et restauration
-- (salle, tables, commande ouverte).
--
-- Le domaine est un PARAMÈTRE D'AFFICHAGE, jamais un privilège : il ne touche
-- ni aux RLS, ni aux plans, ni aux limites de produits. Un restaurateur reste
-- soumis aux mêmes quotas qu'un commerçant — c'est ce qui rend la bascule entre
-- les deux domaines sans risque.
--
-- Les organizations existantes sont en commerce : DEFAULT 'retail' et aucune
-- valeur forcée, donc le backfill est inutile.
-- ============================================================

-- La colonne d'abord : la contrainte porte sur elle.
-- ADD COLUMN IF NOT EXISTS est indispensable, le harnais rejoue ce fichier.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS domain text NOT NULL DEFAULT 'retail';

-- ⚠ LE GRANT EST INDISPENSABLE, et c'est un piège que cette migration
--   s'infligeait elle-même.
--
--   migration_security.sql a verrouillé organizations en accordant les droits
--   COLONNE par colonne (plan en SELECT seul, pour qu'un client ne puisse pas
--   écrire `plan = 'pro'`). Dès qu'il existe des droits de colonne, PostgreSQL
--   n'accorde plus rien au niveau TABLE : une colonne ajoutée ensuite par
--   ADD COLUMN naît donc SANS droit d'écriture, même pour le patron.
--
--   Résultat en recette du 04/10/2026 : l'écran « Quelle est votre activité ? »
--   répondait « permission denied for table organizations » et l'inscription
--   restait bloquée. Le test SQL ne le voyait pas — le harnais tourne en
--   postgres, qui contourne les privilèges.
GRANT UPDATE (domain) ON organizations TO authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'organizations_domain_check'
  ) THEN
    ALTER TABLE organizations
      ADD CONSTRAINT organizations_domain_check
      CHECK (domain IN ('retail', 'restaurant'));
  END IF;
END;
$$;

-- Index inutile : le domaine est lu avec la ligne, jamais filtré en masse.