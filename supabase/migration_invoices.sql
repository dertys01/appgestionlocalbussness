-- ============================================================
-- MIGRATION INVOICES — GestionLocal
-- A exécuter dans Supabase SQL Editor
-- ============================================================

-- Champs facturation dans organizations
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS ifu             text;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS address         text;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS invoice_counter integer NOT NULL DEFAULT 0;

-- Nom du client optionnel sur une vente (pour facture normalisée)
ALTER TABLE sales ADD COLUMN IF NOT EXISTS client_name text;
