-- ============================================================
-- MIGRATION PLAN LIMITS — GestionLocal
-- A exécuter dans Supabase SQL Editor
-- Enforce les limites de produits au niveau DB (inviolable)
-- ============================================================

CREATE OR REPLACE FUNCTION check_product_limit()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  org_plan text;
  product_count int;
  plan_limit int;
BEGIN
  SELECT plan INTO org_plan FROM organizations WHERE id = NEW.user_id;

  SELECT COUNT(*) INTO product_count
  FROM products WHERE user_id = NEW.user_id;

  plan_limit := CASE org_plan
    WHEN 'free'    THEN 30
    WHEN 'starter' THEN 200
    WHEN 'pro'     THEN 2147483647
    ELSE 30
  END;

  IF product_count >= plan_limit THEN
    RAISE EXCEPTION 'Limite de produits atteinte pour le plan % (max %). Passez à un plan supérieur.', org_plan, plan_limit;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_product_limit ON products;
CREATE TRIGGER enforce_product_limit
  BEFORE INSERT ON products
  FOR EACH ROW EXECUTE FUNCTION check_product_limit();
