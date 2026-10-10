-- ============================================================
-- migration_purchase_orders.sql — bons de commande fournisseur
-- À exécuter APRÈS migration_suppliers.sql
-- ============================================================
--
-- POURQUOI : le module fournisseurs existe, mais on ne peut que les
-- enregistrer. Un commerce COMMANDE : on prépare une commande (quels
-- articles, combien, à quel coût), on l'envoie au fournisseur, puis on la
-- RÉCEPTIONNE — et c'est la réception qui fait entrer le stock.
--
-- DEUX RPC, SECURITY DEFINER (aucune écriture client sur ces tables) :
--   • create_purchase_order(fournisseur, lignes, note) — naît en « ordered » ;
--   • receive_purchase_order(id)  — incrémente le stock + journal de stock,
--                                   passe en « received » (une seule fois) ;
--   • cancel_purchase_order(id)   — annule une commande non reçue.
--
-- La RÉCEPTION est le seul moment où le stock bouge : créer une commande ne
-- touche à rien. Le coût unitaire est CONSERVÉ sur la ligne (traçabilité du
-- prix d'achat), mais ne réécrit PAS products.price_buy : changer le coût
-- courant est une décision du commerçant, pas un effet de bord d'une
-- réception.
--
-- Rejouable : IF NOT EXISTS / DROP POLICY IF EXISTS / CREATE OR REPLACE.
-- ============================================================

-- ─── 1. La commande ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS purchase_orders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  supplier_id   uuid REFERENCES suppliers(id) ON DELETE SET NULL,
  -- Instantané du nom : une commande doit rester lisible même si le
  -- fournisseur est retiré du carnet.
  supplier_name text,
  status        text NOT NULL DEFAULT 'ordered'
                CHECK (status IN ('ordered', 'received', 'cancelled')),
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  received_at   timestamptz,
  received_by   uuid
);

CREATE INDEX IF NOT EXISTS idx_purchase_orders_user
  ON purchase_orders(user_id, created_at DESC);

ALTER TABLE purchase_orders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "purchase_orders_read" ON purchase_orders;
CREATE POLICY "purchase_orders_read" ON purchase_orders
  FOR SELECT USING (user_id = get_business_owner_id());

-- ─── 2. Les lignes ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS purchase_order_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  product_id   uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  product_name text NOT NULL,
  quantity     numeric(12,3) NOT NULL CHECK (quantity > 0),
  unit_cost    numeric(12,2) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0)
);

CREATE INDEX IF NOT EXISTS idx_purchase_order_items_order
  ON purchase_order_items(order_id);

ALTER TABLE purchase_order_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "purchase_order_items_read" ON purchase_order_items;
CREATE POLICY "purchase_order_items_read" ON purchase_order_items
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM purchase_orders o
       WHERE o.id = purchase_order_items.order_id
         AND o.user_id = get_business_owner_id()
    )
  );

-- Aucune écriture client : les RPC s'en chargent.
REVOKE INSERT, UPDATE, DELETE ON purchase_orders      FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON purchase_order_items FROM anon, authenticated;
REVOKE ALL ON purchase_orders      FROM anon;
REVOKE ALL ON purchase_order_items FROM anon;


-- ─── 3. Créer une commande ──────────────────────────────────
CREATE OR REPLACE FUNCTION create_purchase_order(
  p_supplier_id uuid,
  p_items       jsonb,
  p_note        text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner    uuid := get_business_owner_id();
  v_order_id uuid;
  v_nom      text;
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Non authentifié' USING ERRCODE = '28000';
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Une commande doit contenir au moins une ligne' USING ERRCODE = '22023';
  END IF;

  -- Chaque ligne doit être valide AVANT toute écriture.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_items) AS e
    WHERE COALESCE(e->>'product_id', '') !~ '^[0-9a-fA-F-]{36}$'
       OR COALESCE(e->>'quantity', '') !~ '^[0-9]+([.,][0-9]{1,3})?$'
       OR (replace(e->>'quantity', ',', '.'))::numeric <= 0
       OR COALESCE(e->>'unit_cost', '0') !~ '^[0-9]+([.,][0-9]{1,2})?$'
  ) THEN
    RAISE EXCEPTION 'Ligne de commande invalide' USING ERRCODE = '22023';
  END IF;

  -- Le fournisseur doit appartenir à la boutique (sinon ignoré).
  IF p_supplier_id IS NOT NULL THEN
    SELECT name INTO v_nom FROM suppliers WHERE id = p_supplier_id AND user_id = v_owner;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Fournisseur introuvable' USING ERRCODE = 'P0002';
    END IF;
  END IF;

  INSERT INTO purchase_orders (user_id, supplier_id, supplier_name, note, created_by)
  VALUES (v_owner, p_supplier_id, v_nom, NULLIF(btrim(COALESCE(p_note, '')), ''), auth.uid())
  RETURNING id INTO v_order_id;

  -- Les produits doivent appartenir à la boutique : on lit le nom et on refuse
  -- un produit étranger, plutôt que d'écrire une ligne orpheline.
  INSERT INTO purchase_order_items (order_id, product_id, product_name, quantity, unit_cost)
  SELECT v_order_id,
         p.id,
         p.name,
         (replace(e->>'quantity', ',', '.'))::numeric,
         COALESCE(NULLIF(replace(e->>'unit_cost', ',', '.'), ''), '0')::numeric
    FROM jsonb_array_elements(p_items) AS e
    JOIN products p ON p.id = (e->>'product_id')::uuid AND p.user_id = v_owner;

  IF (SELECT count(*) FROM purchase_order_items WHERE order_id = v_order_id) = 0 THEN
    RAISE EXCEPTION 'Aucun produit valide dans la commande' USING ERRCODE = '22023';
  END IF;

  RETURN v_order_id;
END;
$$;

REVOKE ALL ON FUNCTION create_purchase_order(uuid, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_purchase_order(uuid, jsonb, text) TO authenticated;
GRANT EXECUTE ON FUNCTION create_purchase_order(uuid, jsonb, text) TO service_role;


-- ─── 4. Réceptionner (fait entrer le stock) ─────────────────
CREATE OR REPLACE FUNCTION receive_purchase_order(p_order_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := get_business_owner_id();
  v_statut text;
  v_ligne  record;
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Non authentifié' USING ERRCODE = '28000';
  END IF;

  SELECT status INTO v_statut
    FROM purchase_orders
   WHERE id = p_order_id AND user_id = v_owner
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Commande introuvable' USING ERRCODE = 'P0002';
  END IF;
  IF v_statut <> 'ordered' THEN
    RAISE EXCEPTION 'Cette commande n''est plus en attente (statut : %)', v_statut
      USING ERRCODE = '23514';
  END IF;

  -- Chaque ligne incrémente le stock et écrit le journal.
  FOR v_ligne IN
    SELECT i.product_id, i.product_name, i.quantity
      FROM purchase_order_items i
     WHERE i.order_id = p_order_id
  LOOP
    UPDATE products
       SET stock_qty = stock_qty + v_ligne.quantity
     WHERE id = v_ligne.product_id AND user_id = v_owner;

    INSERT INTO stock_logs (
      user_id, product_id, product_name, movement_type,
      quantity_change, stock_before, stock_after, reference_id
    )
    SELECT v_owner, v_ligne.product_id, v_ligne.product_name, 'restock',
           v_ligne.quantity,
           p.stock_qty - v_ligne.quantity, p.stock_qty, p_order_id
      FROM products p
     WHERE p.id = v_ligne.product_id;
  END LOOP;

  UPDATE purchase_orders
     SET status = 'received', received_at = now(), received_by = auth.uid()
   WHERE id = p_order_id;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION receive_purchase_order(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION receive_purchase_order(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION receive_purchase_order(uuid) TO service_role;

COMMENT ON FUNCTION receive_purchase_order(uuid) IS
  'Réceptionne une commande : incrémente le stock, écrit le journal (restock), '
  'passe en « received ». Une seule fois (refuse si déjà reçue/annulée). '
  'Ne réécrit pas products.price_buy — le coût reste sur la ligne.';


-- ─── 5. Annuler ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION cancel_purchase_order(p_order_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := get_business_owner_id();
  v_statut text;
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Non authentifié' USING ERRCODE = '28000';
  END IF;

  SELECT status INTO v_statut
    FROM purchase_orders
   WHERE id = p_order_id AND user_id = v_owner
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Commande introuvable' USING ERRCODE = 'P0002';
  END IF;
  IF v_statut <> 'ordered' THEN
    RAISE EXCEPTION 'Seule une commande en attente peut être annulée (statut : %)', v_statut
      USING ERRCODE = '23514';
  END IF;

  UPDATE purchase_orders SET status = 'cancelled' WHERE id = p_order_id;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION cancel_purchase_order(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cancel_purchase_order(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION cancel_purchase_order(uuid) TO service_role;
