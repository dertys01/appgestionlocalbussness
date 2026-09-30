-- ============================================================
-- MIGRATION : Équipe & Journal d'activité
-- ============================================================

-- Table membres de l'équipe
CREATE TABLE IF NOT EXISTS business_members (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  owner_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  member_id   UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  member_name TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'employee',
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(owner_id, member_id)
);

-- Journal d'activité
CREATE TABLE IF NOT EXISTS activity_logs (
  id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  business_owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  actor_id          UUID NOT NULL,
  actor_email       TEXT NOT NULL,
  actor_name        TEXT,
  action            TEXT NOT NULL,
  description       TEXT NOT NULL,
  metadata          JSONB,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

-- RLS
ALTER TABLE business_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_logs    ENABLE ROW LEVEL SECURITY;

-- business_members : le patron gère ses membres
DROP POLICY IF EXISTS "owner_manage_members" ON business_members;
CREATE POLICY "owner_manage_members" ON business_members
  USING (auth.uid() = owner_id)
  WITH CHECK (auth.uid() = owner_id);

-- business_members : chaque employé voit son propre lien
DROP POLICY IF EXISTS "member_view_own" ON business_members;
CREATE POLICY "member_view_own" ON business_members
  FOR SELECT USING (auth.uid() = member_id);

-- activity_logs : insert libre (actor = soi-même)
DROP POLICY IF EXISTS "activity_insert" ON activity_logs;
CREATE POLICY "activity_insert" ON activity_logs
  FOR INSERT WITH CHECK (auth.uid() = actor_id);

-- activity_logs : le patron et ses employés peuvent lire
DROP POLICY IF EXISTS "activity_read" ON activity_logs;
CREATE POLICY "activity_read" ON activity_logs
  FOR SELECT USING (
    auth.uid() = business_owner_id OR
    EXISTS (
      SELECT 1 FROM business_members
      WHERE owner_id = business_owner_id AND member_id = auth.uid()
    )
  );

-- Fonction : retourne le user_id du patron (pour employé → owner_id, pour patron → lui-même)
CREATE OR REPLACE FUNCTION get_business_owner_id()
RETURNS UUID AS $$
  SELECT COALESCE(
    (SELECT owner_id FROM business_members WHERE member_id = auth.uid() LIMIT 1),
    auth.uid()
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Mise à jour des politiques RLS existantes pour supporter les employés

DROP POLICY IF EXISTS "user_products" ON products;
DROP POLICY IF EXISTS "user_products" ON products;
CREATE POLICY "user_products" ON products
  USING (user_id = get_business_owner_id())
  WITH CHECK (user_id = get_business_owner_id());

DROP POLICY IF EXISTS "user_sales" ON sales;
DROP POLICY IF EXISTS "user_sales" ON sales;
CREATE POLICY "user_sales" ON sales
  USING (user_id = get_business_owner_id())
  WITH CHECK (user_id = get_business_owner_id());

DROP POLICY IF EXISTS "user_sale_items" ON sale_items;
DROP POLICY IF EXISTS "user_sale_items" ON sale_items;
CREATE POLICY "user_sale_items" ON sale_items
  USING (
    EXISTS (
      SELECT 1 FROM sales
      WHERE sales.id = sale_items.sale_id
        AND sales.user_id = get_business_owner_id()
    )
  );

DROP POLICY IF EXISTS "user_stock_logs" ON stock_logs;
DROP POLICY IF EXISTS "user_stock_logs" ON stock_logs;
CREATE POLICY "user_stock_logs" ON stock_logs
  USING (user_id = get_business_owner_id())
  WITH CHECK (user_id = get_business_owner_id());
