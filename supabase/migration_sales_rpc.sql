-- ============================================================
-- MIGRATION VENTE TRANSACTIONNELLE — GestionLocal
-- À exécuter dans Supabase SQL Editor
--
-- Remplace le flux client (INSERT sales + INSERT sale_items + boucle
-- sequentielle UPDATE products / INSERT stock_logs) par une unique
-- fonction atomique. Corrige :
--   * les ventes partiellement appliquees (stock non decremente alors que
--     l'UI affichait « Vente enregistree ») ;
--   * les lost updates entre deux caisses (lecture-modification-ecriture) ;
--   * les 2N allers-retours reseau d'un panier de N lignes (1 seul) ;
--   * le compteur de facture lu-modifie-ecrit depuis le client.
-- ============================================================

-- ─── 1. Numéro de facture persisté sur la vente ─────────────
-- Avant, le numéro n'était jamais stocké : il était calculé à l'impression
-- depuis un compteur en base, si bien que deux factures imprimées depuis le
-- même état de page portaient le même numéro, et qu'aucune facture n'était
-- rattachable à sa vente.
ALTER TABLE sales ADD COLUMN IF NOT EXISTS invoice_number text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_invoice_number
  ON sales(invoice_number) WHERE invoice_number IS NOT NULL;

-- ─── 2. Filet de sécurité sur le stock ─────────────────────
-- NOT VALID : la contrainte est bien appliquée aux INSERT/UPDATE futurs,
-- mais on ne scanne pas l'existant (le plan peut contenir des données
-- négatives à cause de l'ancien flux client non transactionnel).
-- Après avoir nettoyé :  ALTER TABLE products VALIDATE CONSTRAINT products_stock_qty_non_negative;
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_stock_qty_non_negative;
ALTER TABLE products ADD CONSTRAINT products_stock_qty_non_negative
  CHECK (stock_qty >= 0) NOT VALID;

-- ─── 3. Rate limiting distribué ────────────────────────────
-- Remplace le compteur en mémoire de /api/register, qui était recréé vide à
-- chaque invocation serverless et ne limitait donc rien en production.
CREATE TABLE IF NOT EXISTS rate_limits (
  key        text PRIMARY KEY,
  count      integer NOT NULL DEFAULT 0,
  reset_at   timestamptz NOT NULL
);

-- Nettoyage opportuniste : supprime les lignes expirées lors de l'appel suivant.
CREATE OR REPLACE FUNCTION bump_rate_limit(
  p_key             text,
  p_max             integer,
  p_window_seconds  integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now    timestamptz := now();
  v_count  integer;
BEGIN
  -- Verrou de ligne : deux inscriptions simultanées depuis la même IP
  -- sérialisent ici au lieu de lire/écrire en même temps.
  INSERT INTO rate_limits (key, count, reset_at)
  VALUES (p_key, 1, v_now + make_interval(secs => p_window_seconds))
  ON CONFLICT (key) DO UPDATE
    SET count = CASE
                  WHEN rate_limits.reset_at <= v_now THEN 1
                  ELSE rate_limits.count + 1
                END,
        reset_at = CASE
                     WHEN rate_limits.reset_at <= v_now
                       THEN v_now + make_interval(secs => p_window_seconds)
                     ELSE rate_limits.reset_at
                   END
  RETURNING count INTO v_count;

  RETURN v_count > p_max;
END;
$$;

-- Purge des compteurs expirés (appelable par un cron ; sans effet ici).
CREATE OR REPLACE FUNCTION purge_rate_limits()
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH deleted AS (
    DELETE FROM rate_limits WHERE reset_at <= now() RETURNING 1
  )
  SELECT count(*)::integer FROM deleted;
$$;

REVOKE ALL ON FUNCTION bump_rate_limit(text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION bump_rate_limit(text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION purge_rate_limits() TO service_role;

-- ─── 4. Politique DELETE manquante sur le journal ──────────
-- activity_logs n'avait qu'une policy INSERT et une policy SELECT : la purge
-- des logs de plus de 90 jours ne pouvait donc jamais aboutir.
DROP POLICY IF EXISTS "activity_prune" ON activity_logs;
DROP POLICY IF EXISTS "activity_prune" ON activity_logs;
CREATE POLICY "activity_prune" ON activity_logs
  FOR DELETE USING (auth.uid() = business_owner_id);

-- ─── 5. Fonction create_sale ───────────────────────────────
-- Retourne l'identifiant de la vente, son numéro de facture (Pro) et son
-- total — tous trois calculés côté serveur, pour que le client affiche
-- exactement ce qui a été enregistré.
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
  v_plan       text;
  v_counter    int;
  v_invoice    text;
  v_name       text;
  v_price      numeric(12,2);
  v_cost       numeric(12,2);
  v_stock      int;
  v_qty        int;
  v_total      numeric(12,2) := 0;
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

  -- ── Valider chaque quantité AVANT toute écriture ──
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_items) AS e
    WHERE COALESCE(e->>'product_id', '') !~ '^[0-9a-fA-F-]{36}$'
       OR COALESCE(e->>'quantity', '') !~ '^[0-9]+$'
       OR (e->>'quantity')::int < 1
       OR (e->>'quantity')::int > 100000
  ) THEN
    RAISE EXCEPTION 'Ligne de panier invalide' USING ERRCODE = '22023';
  END IF;

  -- ── Agréger par produit ──
  -- Indispensable : sans cela un panier contenant deux fois le même article
  -- passerait la vérification de stock ligne par ligne (5 >= 4, puis 5 >= 4)
  -- avant de décrémenter de 8 et de rendre le stock négatif.
  SELECT array_agg(product_id ORDER BY product_id),
         array_agg(quantity   ORDER BY product_id)
    INTO v_ids, v_qtys
    FROM (
      SELECT (e->>'product_id')::uuid AS product_id,
             SUM((e->>'quantity')::int)::int AS quantity
        FROM jsonb_array_elements(p_items) AS e
       GROUP BY 1
    ) AS aggregated;

  -- ── Verrouiller les lignes produits et valider le stock ──
  -- FOR UPDATE sérialise les caisses concurrentes sur les mêmes articles.
  -- Les verrous sont conservés jusqu'au COMMIT, donc la seconde boucle relit
  -- des valeurs stables.
  FOR v_i IN 1 .. COALESCE(array_length(v_ids, 1), 0) LOOP
    SELECT p.name, p.price_sell, COALESCE(p.price_buy, 0), p.stock_qty
      INTO v_name, v_price, v_cost, v_stock
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

    -- Le prix facturé est celui de la base, jamais celui transmis par le client.
    v_total := v_total + v_price * v_qtys[v_i];
  END LOOP;

  -- ── Numéro de facture : incrément atomique (Pro uniquement) ──
  -- `UPDATE ... RETURNING` pose un verrou de ligne : deux caisses qui
  -- impriment en parallèle obtiennent deux numéros distincts.
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
      INTO v_name, v_price, v_cost, v_stock
      FROM products p
     WHERE p.id = v_ids[v_i]
       AND p.user_id = v_owner;

    INSERT INTO sale_items (
      sale_id, product_id, product_name, quantity, unit_price, subtotal, unit_cost
    ) VALUES (
      v_sale_id, v_ids[v_i], v_name, v_qty, v_price, v_price * v_qty, v_cost
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

  RETURN jsonb_build_object(
    'id',             v_sale_id,
    'invoice_number', v_invoice,
    'total_amount',   v_total
  );
END;
$$;

-- Seuls les utilisateurs authentifiés peuvent encaisser.
REVOKE ALL ON FUNCTION create_sale(jsonb, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_sale(jsonb, text, text, text) TO authenticated;

COMMENT ON FUNCTION create_sale(jsonb, text, text, text) IS
  'Enregistre une vente de façon atomique : lignes, décrément de stock et journal. '
  'Lève une exception si le stock est insuffisant — dans ce cas rien n''est écrit.';
