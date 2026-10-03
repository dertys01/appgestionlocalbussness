-- ============================================================
-- SCHEMA MVP AppGestionLocalBusiness
-- ============================================================
-- ⚠️ HISTORIQUE — ne plus exécuter seul. L'état courant du schéma est défini
-- par l'ordre complet : schema.sql → … → migration_roles.sql →
-- migration_security.sql (c'est migration_security.sql qui fait foi).
-- ============================================================

-- Extension UUID
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- TABLE : products
-- ============================================================
CREATE TABLE IF NOT EXISTS products (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  sku           TEXT,                        -- code-barres / référence
  price_buy     NUMERIC(12, 2) NOT NULL DEFAULT 0,
  price_sell    NUMERIC(12, 2) NOT NULL DEFAULT 0,
  stock_qty     INTEGER NOT NULL DEFAULT 0,
  min_stock_level INTEGER NOT NULL DEFAULT 5,
  category      TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- TABLE : sales
-- ============================================================
CREATE TABLE IF NOT EXISTS sales (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  total_amount  NUMERIC(12, 2) NOT NULL DEFAULT 0,
  payment_method TEXT NOT NULL DEFAULT 'cash',  -- 'cash' | 'momo'
  note          TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- TABLE : sale_items
-- ============================================================
CREATE TABLE IF NOT EXISTS sale_items (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sale_id       UUID NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id    UUID NOT NULL REFERENCES products(id),
  product_name  TEXT NOT NULL,               -- snapshot du nom au moment de la vente
  quantity      INTEGER NOT NULL,
  unit_price    NUMERIC(12, 2) NOT NULL,
  subtotal      NUMERIC(12, 2) NOT NULL
);

-- ============================================================
-- TABLE : stock_logs  (audit de tous les mouvements)
-- ============================================================
CREATE TABLE IF NOT EXISTS stock_logs (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  product_id    UUID NOT NULL REFERENCES products(id),
  product_name  TEXT NOT NULL,
  movement_type TEXT NOT NULL,               -- 'sale' | 'restock' | 'adjustment'
  quantity_change INTEGER NOT NULL,          -- négatif pour une vente
  stock_before  INTEGER NOT NULL,
  stock_after   INTEGER NOT NULL,
  reference_id  UUID,                        -- sale_id si movement_type = 'sale'
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE products   ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales      ENABLE ROW LEVEL SECURITY;
ALTER TABLE sale_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_logs ENABLE ROW LEVEL SECURITY;

-- products
DROP POLICY IF EXISTS "user_products" ON products;
CREATE POLICY "user_products" ON products
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- sales
DROP POLICY IF EXISTS "user_sales" ON sales;
CREATE POLICY "user_sales" ON sales
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- sale_items : accessible si la vente appartient à l'utilisateur
DROP POLICY IF EXISTS "user_sale_items" ON sale_items;
CREATE POLICY "user_sale_items" ON sale_items
  USING (
    EXISTS (SELECT 1 FROM sales WHERE sales.id = sale_items.sale_id AND sales.user_id = auth.uid())
  );

-- stock_logs
DROP POLICY IF EXISTS "user_stock_logs" ON stock_logs;
CREATE POLICY "user_stock_logs" ON stock_logs
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ============================================================
-- TRIGGER : met à jour updated_at sur products
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

-- DROP préalable : sans lui, la seconde exécution échoue en 42710
-- « trigger already exists » et interrompt le script en cours de route.
DROP TRIGGER IF EXISTS products_updated_at ON products;
CREATE TRIGGER products_updated_at
  BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- DONNÉES DE TEST (optionnel)
-- ============================================================
-- INSERT INTO products (user_id, name, sku, price_buy, price_sell, stock_qty, min_stock_level, category)
-- VALUES (auth.uid(), 'Samsung Galaxy A05', 'SM-A055F', 55000, 72000, 8, 3, 'smartphones');
