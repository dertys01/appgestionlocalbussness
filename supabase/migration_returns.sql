-- ============================================================
-- migration_returns.sql — retours / avoirs (ventes comptoir)
-- À exécuter APRÈS migration_ca_caisse.sql
-- ============================================================
--
-- POURQUOI : une vente comptoir (espèces / MoMo) ne pouvait pas être annulée
-- ni remboursée. Or un client se ravise, un article est défectueux. Le retour
-- doit : REMETTRE le stock, RENDRE l'argent, et TRACER l'avoir.
--
-- PÉRIMÈTRE v1 : ventes `cash` / `momo`. Un retour réduit `sales.amount_received`
-- du montant rendu — c'est la colonne qui définit le chiffre d'affaires (base
-- de caisse) partout, donc CA et tiroir suivent sans qu'aucun écran n'ait à
-- changer. Le remboursement suit donc le moyen de la VENTE (une vente espèces
-- rend des espèces).
--
-- LE CRÉDIT EST REFUSÉ ICI : sur une vente à crédit, réduire amount_received
-- AUGMENTERAIT la dette (get_customer_debts calcule total_amount −
-- amount_received). Un retour à crédit doit passer par le carnet de dettes —
-- on le dit, on ne le devine pas.
--
-- Le stock est remis (products.stock_qty += quantité) et le journal reçoit un
-- mouvement 'return'. On ne peut pas rendre plus que ce qui a été vendu, ni
-- deux fois la même quantité : les retours déjà enregistrés sont déduits.
--
-- Rejouable : IF NOT EXISTS / DROP POLICY IF EXISTS / CREATE OR REPLACE.
-- ============================================================

-- ─── 1. L'avoir et ses lignes ───────────────────────────────
CREATE TABLE IF NOT EXISTS sale_returns (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  sale_id    uuid NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  amount     numeric(12,2) NOT NULL CHECK (amount >= 0),
  method     text NOT NULL DEFAULT 'cash' CHECK (method IN ('cash', 'momo')),
  note       text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);

CREATE INDEX IF NOT EXISTS idx_sale_returns_sale ON sale_returns(sale_id);

CREATE TABLE IF NOT EXISTS sale_return_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id    uuid NOT NULL REFERENCES sale_returns(id) ON DELETE CASCADE,
  product_id   uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  product_name text NOT NULL,
  quantity     numeric(12,3) NOT NULL CHECK (quantity > 0),
  unit_price   numeric(12,2) NOT NULL DEFAULT 0 CHECK (unit_price >= 0)
);

CREATE INDEX IF NOT EXISTS idx_sale_return_items_return ON sale_return_items(return_id);

ALTER TABLE sale_returns      ENABLE ROW LEVEL SECURITY;
ALTER TABLE sale_return_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "sale_returns_read" ON sale_returns;
CREATE POLICY "sale_returns_read" ON sale_returns
  FOR SELECT USING (user_id = get_business_owner_id());

DROP POLICY IF EXISTS "sale_return_items_read" ON sale_return_items;
CREATE POLICY "sale_return_items_read" ON sale_return_items
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM sale_returns r
       WHERE r.id = sale_return_items.return_id
         AND r.user_id = get_business_owner_id()
    )
  );

-- Aucune écriture client : la RPC s'en charge.
REVOKE INSERT, UPDATE, DELETE ON sale_returns      FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON sale_return_items FROM anon, authenticated;
REVOKE ALL ON sale_returns      FROM anon;
REVOKE ALL ON sale_return_items FROM anon;


-- ─── 2. Enregistrer un retour ───────────────────────────────
CREATE OR REPLACE FUNCTION return_sale(
  p_sale_id uuid,
  p_items   jsonb,
  p_note    text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner    uuid := get_business_owner_id();
  v_sale     sales%ROWTYPE;
  v_return   uuid;
  v_montant  numeric(12,2) := 0;
  v_item     record;
  v_vendu    numeric(12,3);
  v_deja     numeric(12,3);
  v_prix     numeric(12,2);
  v_stock    numeric(12,3);
  v_nom      text;
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Non authentifié' USING ERRCODE = '28000';
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Un retour doit contenir au moins une ligne' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_sale FROM sales
   WHERE id = p_sale_id AND user_id = v_owner
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Vente introuvable' USING ERRCODE = 'P0002';
  END IF;

  -- v1 : comptoir seulement. Voir l'en-tête.
  IF v_sale.payment_method NOT IN ('cash', 'momo') THEN
    RAISE EXCEPTION 'Retour impossible sur une vente à crédit : réglez la dette depuis l''écran Dettes.'
      USING ERRCODE = '22023';
  END IF;

  -- Valider la forme de chaque ligne AVANT toute écriture.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_items) AS e
    WHERE COALESCE(e->>'product_id', '') !~ '^[0-9a-fA-F-]{36}$'
       OR COALESCE(e->>'quantity', '') !~ '^[0-9]+([.,][0-9]{1,3})?$'
       OR (replace(e->>'quantity', ',', '.'))::numeric <= 0
  ) THEN
    RAISE EXCEPTION 'Ligne de retour invalide' USING ERRCODE = '22023';
  END IF;

  INSERT INTO sale_returns (user_id, sale_id, amount, method, note, created_by)
  VALUES (v_owner, p_sale_id, 0, v_sale.payment_method,
          NULLIF(btrim(COALESCE(p_note, '')), ''), auth.uid())
  RETURNING id INTO v_return;

  FOR v_item IN
    SELECT (e->>'product_id')::uuid AS product_id,
           (replace(e->>'quantity', ',', '.'))::numeric AS quantity
      FROM jsonb_array_elements(p_items) AS e
  LOOP
    -- Quantité vendue de ce produit sur CETTE vente.
    SELECT si.quantity, si.unit_price, si.product_name
      INTO v_vendu, v_prix, v_nom
      FROM sale_items si
     WHERE si.sale_id = p_sale_id AND si.product_id = v_item.product_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Ce produit ne figure pas dans la vente' USING ERRCODE = 'P0002';
    END IF;

    -- Déjà retourné sur ce produit (tous retours confondus).
    SELECT COALESCE(SUM(sri.quantity), 0) INTO v_deja
      FROM sale_return_items sri
      JOIN sale_returns sr ON sr.id = sri.return_id
     WHERE sr.sale_id = p_sale_id AND sri.product_id = v_item.product_id;

    IF v_item.quantity > v_vendu - v_deja THEN
      RAISE EXCEPTION 'Retour supérieur à ce qui reste dû pour « % » (vendu : %, déjà retourné : %)',
        v_nom, v_vendu, v_deja USING ERRCODE = '23514';
    END IF;

    -- Remise en stock + journal.
    SELECT stock_qty INTO v_stock FROM products
     WHERE id = v_item.product_id AND user_id = v_owner FOR UPDATE;
    UPDATE products SET stock_qty = stock_qty + v_item.quantity
     WHERE id = v_item.product_id AND user_id = v_owner;
    INSERT INTO stock_logs (
      user_id, product_id, product_name, movement_type,
      quantity_change, stock_before, stock_after, reference_id
    ) VALUES (
      v_owner, v_item.product_id, v_nom, 'return',
      v_item.quantity, v_stock, v_stock + v_item.quantity, v_return
    );

    INSERT INTO sale_return_items (return_id, product_id, product_name, quantity, unit_price)
    VALUES (v_return, v_item.product_id, v_nom, v_item.quantity, v_prix);

    v_montant := v_montant + v_prix * v_item.quantity;
  END LOOP;

  -- Le montant rendu ne peut pas dépasser ce qui a été réellement encaissé.
  v_montant := LEAST(v_montant, v_sale.amount_received);

  UPDATE sale_returns SET amount = v_montant WHERE id = v_return;
  UPDATE sales SET amount_received = GREATEST(amount_received - v_montant, 0)
   WHERE id = p_sale_id;

  RETURN jsonb_build_object('return_id', v_return, 'amount', v_montant);
END;
$$;

REVOKE ALL ON FUNCTION return_sale(uuid, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION return_sale(uuid, jsonb, text) TO authenticated;
GRANT EXECUTE ON FUNCTION return_sale(uuid, jsonb, text) TO service_role;

COMMENT ON FUNCTION return_sale(uuid, jsonb, text) IS
  'Retour d''une vente comptoir : remet le stock, réduit amount_received du '
  'montant rendu (donc le CA et le tiroir), trace l''avoir. Refuse une vente '
  'à crédit et un retour supérieur à ce qui reste dû.';
