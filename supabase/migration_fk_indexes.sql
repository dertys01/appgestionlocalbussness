-- ============================================================
-- MIGRATION : index couvrant les clés étrangères
-- A exécuter dans Supabase SQL Editor
--
-- L'advisor Supabase signale deux FK sans index couvrant : sale_items.product_id
-- et stock_logs.user_id. Sans eux, une jointure ou une suppression en cascade
-- fait un seq scan de la table à chaque requête.
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_sale_items_product_id ON sale_items(product_id);
CREATE INDEX IF NOT EXISTS idx_stock_logs_user_id ON stock_logs(user_id);
