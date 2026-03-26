-- ============================================================
-- MIGRATION INDEXES — GestionLocal
-- A exécuter dans Supabase SQL Editor
-- ============================================================

-- products
CREATE INDEX IF NOT EXISTS idx_products_user_id     ON products(user_id);
CREATE INDEX IF NOT EXISTS idx_products_name        ON products(name);
CREATE INDEX IF NOT EXISTS idx_products_category    ON products(category);

-- sales
CREATE INDEX IF NOT EXISTS idx_sales_user_id        ON sales(user_id);
CREATE INDEX IF NOT EXISTS idx_sales_created_at     ON sales(created_at DESC);

-- sale_items
CREATE INDEX IF NOT EXISTS idx_sale_items_sale_id   ON sale_items(sale_id);

-- stock_logs
CREATE INDEX IF NOT EXISTS idx_stock_logs_product_id ON stock_logs(product_id);

-- activity_logs
CREATE INDEX IF NOT EXISTS idx_activity_logs_owner_id   ON activity_logs(business_owner_id);
CREATE INDEX IF NOT EXISTS idx_activity_logs_created_at ON activity_logs(created_at DESC);
