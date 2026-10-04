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