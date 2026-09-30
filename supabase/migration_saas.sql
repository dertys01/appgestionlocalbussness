-- ============================================================
-- MIGRATION SaaS — GestionLocal
-- A exécuter dans Supabase SQL Editor
-- ============================================================

-- ─── 1. TABLE ORGANIZATIONS ─────────────────────────────────
-- id = auth.uid() du patron (aucune migration de données requise :
-- les colonnes user_id existantes sont déjà l'org_id)
CREATE TABLE IF NOT EXISTS organizations (
  id          uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name        text NOT NULL,
  slug        text UNIQUE NOT NULL,
  logo_url    text,
  plan        text NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'starter', 'pro')),
  timezone    text NOT NULL DEFAULT 'Africa/Porto-Novo',
  currency    text NOT NULL DEFAULT 'XOF',
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);

-- Trigger updated_at
CREATE OR REPLACE FUNCTION update_org_timestamp()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS organizations_updated_at ON organizations;
CREATE TRIGGER organizations_updated_at
  BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION update_org_timestamp();

-- RLS
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Patron lit sa propre org" ON organizations;
CREATE POLICY "Patron lit sa propre org" ON organizations
  FOR SELECT USING (auth.uid() = id);

DROP POLICY IF EXISTS "Employé lit l'org de son patron" ON organizations;
CREATE POLICY "Employé lit l'org de son patron" ON organizations
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM business_members
      WHERE member_id = auth.uid() AND owner_id = organizations.id
    )
  );

DROP POLICY IF EXISTS "Patron modifie sa propre org" ON organizations;
CREATE POLICY "Patron modifie sa propre org" ON organizations
  FOR UPDATE USING (auth.uid() = id);

DROP POLICY IF EXISTS "Patron crée son org" ON organizations;
CREATE POLICY "Patron crée son org" ON organizations
  FOR INSERT WITH CHECK (auth.uid() = id);

-- ─── 2. TABLE SUBSCRIPTIONS ──────────────────────────────────
CREATE TABLE IF NOT EXISTS subscriptions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  stripe_customer_id       text UNIQUE,
  stripe_subscription_id   text UNIQUE,
  plan                     text NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'starter', 'pro')),
  status                   text NOT NULL DEFAULT 'active',
  current_period_end       timestamptz,
  created_at               timestamptz DEFAULT now(),
  updated_at               timestamptz DEFAULT now()
);

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Patron lit ses abonnements" ON subscriptions;
CREATE POLICY "Patron lit ses abonnements" ON subscriptions
  FOR SELECT USING (org_id = auth.uid());

-- Seul le service role peut écrire (via webhook Stripe)
DROP POLICY IF EXISTS "Service role gère les abonnements" ON subscriptions;
CREATE POLICY "Service role gère les abonnements" ON subscriptions
  FOR ALL USING (auth.role() = 'service_role');

-- ─── 3. ONBOARDING FLAG ─────────────────────────────────────
-- Ajouter une colonne onboarding_done à organizations (ALTER idempotent)
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS onboarding_done boolean DEFAULT false;

-- ─── 4. CRÉER UNE ORG POUR LES UTILISATEURS EXISTANTS ───────
-- (exécuter une seule fois — idempotent grâce à ON CONFLICT DO NOTHING)
INSERT INTO organizations (id, name, slug, plan, onboarding_done)
SELECT
  u.id,
  COALESCE(u.raw_user_meta_data->>'business_name', split_part(u.email, '@', 1)),
  lower(regexp_replace(
    COALESCE(u.raw_user_meta_data->>'business_name', split_part(u.email, '@', 1)),
    '[^a-z0-9]', '-', 'g'
  )) || '-' || left(u.id::text, 8),
  'free',
  true  -- utilisateurs existants = onboarding déjà fait
FROM auth.users u
WHERE NOT EXISTS (
  SELECT 1 FROM organizations WHERE id = u.id
);
