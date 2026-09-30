-- ============================================================
-- PRIX NÉGOCIÉ — create_sale() ignorait le prix convenu
-- À exécuter dans Supabase SQL Editor
--
-- LE PROBLÈME
--   create_sale() recalcule le total côté serveur à partir de
--   products.price_sell, et refuse tout prix transmis par le client. C'était un
--   choix délibéré — un client ne doit pas pouvoir facturer 1 FCFA. Mais dans un
--   marché où « c'est le dernier prix » est la règle, l'impossibilité de
--   modifier un prix n'est pas une protection : c'est un blocage. Un
--   commerçant ne note pas la vente, il la refuse ou il vend sous le prix
--   en espèces, hors de l'application.
--
-- CE QUE CELA CHANGE
--   Chaque ligne de panier peut porter un prix convenu. Le prix catalogue
--   reste la référence et n'est jamais modifié : il est enregistré dans
--   sale_items.list_price, ce qui rend chaque remise traçable.
--
-- CE QUE CELA N'OUVRE PAS
--   Rien qui vaille le prix d'achat. La vente à perte reste possible — un
--   commerçant a le droit de se tromper, ou d'écouler un stock aging — mais
--   elle est signalée dans Rentabilité au lieu de disparaître dans le chiffre
--   d'affaires. Bloquer une vente à perte empêcherait de solder un stock, ce qui
--   est précisément le moment où le commerçant en a besoin.
--
--   Le risque réel d'un prix envoyé par le client n'est pas le client
--   malveillant, c'est la caisse qui cache du chiffre. La parade est la
--   traçabilité, pas le verrou : list_price + agrégat des remises dans le
--   rapport.
-- ============================================================

-- ─── 1. Le prix catalogue, mémorisé ───────────────────────
-- Sans cette colonne, une remise se perdait définitivement : le prix catalogue
-- aurait été écrasé et la marge historique recalculée au prix d'aujourd'hui,
-- exactement le défaut que unit_cost corrigeait déjà pour le coût.
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS list_price numeric(12,2);

-- ─── 2. create_sale() accepte un prix convenu ─────────────
CREATE OR REPLACE FUNCTION create_sale(
  p_items          jsonb,
  p_payment_method text,
  p_client_name    text    DEFAULT NULL,
  p_note           text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner      uuid;
  v_sale_id    uuid;
  v_ids        uuid[];
  v_qtys       int[];
  v_agreed     numeric(12,2)[];   -- prix convenu, NULL = prix catalogue
  v_plan       text;
  v_counter    int;
  v_invoice    text;
  v_name       text;
  v_list       numeric(12,2);     -- prix catalogue (référence)
  v_price      numeric(12,2);     -- prix réellement facturé
  v_cost       numeric(12,2);
  v_stock      int;
  v_qty        int;
  v_total      numeric(12,2) := 0;
  v_discount   numeric(12,2) := 0;
  v_at_loss    int := 0;
  v_i          int;
BEGIN
  -- ── Locataire résolu côté serveur, jamais reçu du client ──
  v_owner := get_business_owner_id();
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Non authentifié' USING ERRCODE = '28000';
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Panier vide' USING ERRCODE = '22023';
  END IF;

  IF p_payment_method IS NULL OR p_payment_method NOT IN ('cash', 'momo') THEN
    RAISE EXCEPTION 'Moyen de paiement invalide : %', p_payment_method USING ERRCODE = '22023';
  END IF;

  -- ── Valider chaque ligne AVANT toute écriture ──
  -- unit_price est facultatif. S'il est présent il doit être un nombre
  -- strictement positif : 0 reviendrait à donner le stock, ce qu'aucun
  -- marchandage ne justifie.
  --
  -- Le contrôle est fait en trois temps, et non par un seul motif regex :
  -- `^[0-9]+(\.[0-9]{1,2})?$` accepte « 0 », et COALESCE(liste, prix) aurait
  -- alors traité la ligne comme sans remise. Une vente gratuite doit être
  -- refusée, pas traitée comme une absence de prix.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_items) AS e
    WHERE COALESCE(e->>'product_id', '') !~ '^[0-9a-fA-F-]{36}$'
       OR COALESCE(e->>'quantity', '') !~ '^[0-9]+$'
       OR (e->>'quantity')::int < 1
       OR (e->>'quantity')::int > 100000
  ) THEN
    RAISE EXCEPTION 'Ligne de panier invalide' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_items) AS e
    WHERE e ? 'unit_price'
      AND (e->>'unit_price' !~ '^[0-9]+(\.[0-9]{1,2})?$'
           OR (e->>'unit_price')::numeric <= 0)
  ) THEN
    RAISE EXCEPTION 'Ligne de panier invalide' USING ERRCODE = '22023';
  END IF;

  -- ── Agréger par produit ──
  -- Les quantités s'additionnent. Les prix convenus ne s'additionnent pas : deux
  -- lignes du même article à deux prix différents sont ambiguës, et prendre le
  -- minimum ou le maximum ouvrirait la porte à un panier truqué. On refuse.
  IF EXISTS (
    SELECT 1 FROM (
      SELECT (e->>'product_id')::uuid AS product_id
        FROM jsonb_array_elements(p_items) AS e
       WHERE e ? 'unit_price'
       GROUP BY 1
      HAVING count(DISTINCT e->>'unit_price') > 1
    ) AS conflit
  ) THEN
    RAISE EXCEPTION 'Deux prix différents pour le même article : regroupez la ligne'
      USING ERRCODE = '22023';
  END IF;

  SELECT array_agg(product_id ORDER BY product_id),
         array_agg(quantity   ORDER BY product_id),
         array_agg(unit_price ORDER BY product_id)
    INTO v_ids, v_qtys, v_agreed
    FROM (
      SELECT (e->>'product_id')::uuid AS product_id,
             SUM((e->>'quantity')::int)::int AS quantity,
             -- min() ne sert qu'à satisfaire NOT NULL : le contrôle ci-dessus a
             -- déjà garanti qu'il n'y a qu'une valeur distincte.
             MIN((e->>'unit_price')::numeric) AS unit_price
        FROM jsonb_array_elements(p_items) AS e
       GROUP BY 1
    ) AS aggregated;

  -- ── Verrouiller les lignes produits et valider le stock ──
  -- FOR UPDATE sérialise les caisses concurrentes sur les mêmes articles.
  FOR v_i IN 1 .. COALESCE(array_length(v_ids, 1), 0) LOOP
    SELECT p.name, p.price_sell, COALESCE(p.price_buy, 0), p.stock_qty
      INTO v_name, v_list, v_cost, v_stock
      FROM products p
     WHERE p.id = v_ids[v_i]
       AND p.user_id = v_owner
       FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Produit introuvable : %', v_ids[v_i] USING ERRCODE = 'P0002';
    END IF;

    IF v_stock < v_qtys[v_i] THEN
      RAISE EXCEPTION 'Stock insuffisant pour « % » (disponible : %, demandé : %)',
        v_name, v_stock, v_qtys[v_i] USING ERRCODE = '23514';
    END IF;

    -- Prix convenu si fourni, sinon prix catalogue. La quantité est multipliée
    -- par le prix unitaire convenu : « 3 pieces a 6000 chacune » ne se négocie
    -- pas sur le total, la ligne est déjà agrégée.
    v_price := COALESCE(v_agreed[v_i], v_list);

    v_total    := v_total + v_price * v_qtys[v_i];
    v_discount := v_discount + (v_list - v_price) * v_qtys[v_i];

    -- Signalé, pas bloqué : voir l'en-tête. La vente reste enregistrée et le
    -- rapport indique ce qui a été concessionné.
    IF v_price < v_cost THEN
      v_at_loss := v_at_loss + 1;
    END IF;
  END LOOP;

  IF v_discount < 0 THEN
    v_discount := 0;
  END IF;

  -- ── Numéro de facture : incrément atomique (Pro uniquement) ──
  SELECT o.plan INTO v_plan FROM organizations o WHERE o.id = v_owner;
  v_invoice := NULL;

  IF v_plan = 'pro' THEN
    UPDATE organizations
       SET invoice_counter = invoice_counter + 1
     WHERE id = v_owner
    RETURNING invoice_counter INTO v_counter;

    v_invoice := 'FAC-' || to_char(now(), 'YYYY') || '-' || lpad(v_counter::text, 5, '0');
  END IF;

  -- ── En-tête de vente ──
  INSERT INTO sales (
    user_id, total_amount, payment_method, client_name, note, invoice_number
  ) VALUES (
    v_owner,
    v_total,
    p_payment_method,
    NULLIF(btrim(COALESCE(p_client_name, '')), ''),
    p_note,
    v_invoice
  )
  RETURNING id INTO v_sale_id;

  -- ── Lignes, décrément et journal de stock ──
  FOR v_i IN 1 .. COALESCE(array_length(v_ids, 1), 0) LOOP
    v_qty := v_qtys[v_i];

    SELECT p.name, p.price_sell, COALESCE(p.price_buy, 0), p.stock_qty
      INTO v_name, v_list, v_cost, v_stock
      FROM products p
     WHERE p.id = v_ids[v_i]
       AND p.user_id = v_owner;

    v_price := COALESCE(v_agreed[v_i], v_list);

    INSERT INTO sale_items (
      sale_id, product_id, product_name, quantity,
      unit_price, subtotal, unit_cost, list_price
    ) VALUES (
      v_sale_id, v_ids[v_i], v_name, v_qty,
      v_price, v_price * v_qty, v_cost, v_list
    );

    UPDATE products SET stock_qty = stock_qty - v_qty WHERE id = v_ids[v_i];

    INSERT INTO stock_logs (
      user_id, product_id, product_name, movement_type,
      quantity_change, stock_before, stock_after, reference_id
    ) VALUES (
      v_owner, v_ids[v_i], v_name, 'sale',
      -v_qty, v_stock, v_stock - v_qty, v_sale_id
    );
  END LOOP;

  -- discount_amount et at_loss_count permettent à l'appelant d'afficher un avert
  -- sans relire les lignes.
  RETURN jsonb_build_object(
    'id',             v_sale_id,
    'invoice_number', v_invoice,
    'total_amount',   v_total,
    'discount_amount', v_discount,
    'at_loss_count',  v_at_loss
  );
END;
$$;

REVOKE ALL ON FUNCTION create_sale(jsonb, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_sale(jsonb, text, text, text) TO authenticated;

COMMENT ON FUNCTION create_sale(jsonb, text, text, text) IS
  'Enregistre une vente de façon atomique. Chaque ligne peut porter un prix '
  'convenu (unit_price) ; le prix catalogue est alors conservé dans '
  'sale_items.list_price pour que la remise reste traçable. Deux prix '
  'différents pour le même article sont refusés.';
