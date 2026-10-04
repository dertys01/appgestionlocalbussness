-- ============================================================
-- VENTE AU POIDS — quantités fractionnaires
-- À exécuter dans Supabase SQL Editor
--
-- LE PROBLÈME
--   products.stock_qty, sale_items.quantity et stock_logs.quantity_change sont
--   des INTEGER, et create_sale() valide la quantité par `^[0-9]+$`. Une boutique
--   ne peut donc pas vendre 1,2 kg de riz.
--
--   Au Bénin, tout se vend au poids : le riz, l'huile, le sucre, le lait en
--   poudre, les tomates. Un commerçant qui sort son téléphone pour un article
--   qu'il vend toute la journée sort son téléphone, et rien de plus. La vente
--   part en espèces, hors de l'application, et la caisse n'a plus aucune idée de
--   ce qui s'est vendu.
--
-- CE QUE CELA CHANGE
--   Les quantités passent en NUMERIC(12,3). Trois décimales suffisent : 1,250 kg
--   se pèse au gramme près, et au-delà on mesure autrement.
--
--   Un champ products.unit accompagne la quantité, pour que l'écran affiche
--   « 1,2 kg » et non « 1,2 ». L'unité n'affecte aucun calcul : la quantité
--   reste un nombre dans l'unité du produit. C'est ce qui permet de garder un
--   seul stock par produit, ce qu'un stock en kg et un stock en pièce
--   obligeraient à scinder.
--
-- ⚠ Un produit vendu en sachet et en kilogrammes doit être DEUX produits.
--   C'est le choix classique des petites caisses, et l'alternative — deux
--   unités et un facteur de conversion — double la surface d'erreur pour un
--   besoin rare. Le commercçant crée « Riz (sachet 50kg) » et « Riz (au kilo) ».
--
-- Les montants ne changent pas : price_buy et price_sell restent des prix
-- UNITAIRES dans l'unité du produit. « Riz » à 750 F le kilo, pas 37 500 F
-- le quintal.
-- ============================================================

-- ─── 1. Unité de vente ────────────────────────────────────
-- Valeurs libres et non constraintes : les unités d'un marché ne sont pas
-- prévisibles, et une contrainte refusant « botte » ou « calabash » ferait
-- échouer une saisie légitime. Le défaut est « pce » (pièce), qui couvre
-- l'essentiel du catalogue.
ALTER TABLE products ADD COLUMN IF NOT EXISTS unit text NOT NULL DEFAULT 'pce';


-- ─── 2. Quantités fractionnaires ───────────────────────────
-- NUMERIC(12,3) : 999 999 999,999 avant saturation. Un stock en sacs de riz
-- comme un stock en kilos tiennent largement dedans.
--
-- ⚠ products_with_supplier doit être supprimée AVANT, et le défaut n'apparaît
--   que sur une base déjà peuplée. Sur une base neuve, la vue est créée par
--   migration_suppliers.sql, qui passe APRÈS ce fichier : l'ALTER réussit, et le
--   test ne voit jamais le problème. Sur une base où la vue existe déjà, l'ALTER
--   échoue en 0A000 « cannot alter type of a column used by a view or rule » et
--   le script s'interrompt avant les migrations suivantes.
--
DROP VIEW IF EXISTS products_with_supplier;

-- Les vues du module restaurant dépendent elles aussi de products : recipe_costs
-- et restaurant_menu_today lisent son stock et son prix. Sans ce DROP, le même
-- ALTER échoue en 0A000 sur une base où ces vues existent déjà — c'est-à-dire
-- sur toute base ayant déjà reçu les sprints 15 et 17, c'est-à-dire la nôtre.
DROP VIEW IF EXISTS recipe_costs;
DROP VIEW IF EXISTS restaurant_menu_today;

-- ⚠ Le type n'est changé QUE si la colonne est encore entière : le refaire
--   échoue en 0A000 pour la même raison.
DO $$
DECLARE
  v_type text;
BEGIN
  SELECT data_type INTO v_type
    FROM information_schema.columns
   WHERE table_name = 'sale_items' AND column_name = 'quantity';

  IF v_type = 'integer' THEN
    ALTER TABLE sale_items   ALTER COLUMN quantity TYPE NUMERIC(12,3);
    ALTER TABLE products     ALTER COLUMN stock_qty TYPE NUMERIC(12,3);
    ALTER TABLE products     ALTER COLUMN min_stock_level TYPE NUMERIC(12,3);
    ALTER TABLE stock_logs   ALTER COLUMN quantity_change TYPE NUMERIC(12,3),
                              ALTER COLUMN stock_before     TYPE NUMERIC(12,3),
                              ALTER COLUMN stock_after      TYPE NUMERIC(12,3);
  END IF;
END;
$$;

-- Recréation de la vue, dans le MÊME fichier.
--
--⚠ S'appuyer sur migration_suppliers.sql pour la reconstruire ne suffit pas :
--   ce fichier est réappliqué seul (le test de rejouabilité le fait pour rétablir
--   la dernière version de create_sale()), et supprime alors la vue sans que
--   rien ne la remette. Le catalogue devient invisible, sans aucune
--   erreur — le pire genre de panne. Un fichier de migration doit être
--   autonome : il répare ce qu'il casse.
--
-- La création est conditionnelle : sur une base neuve, ni la table suppliers ni
-- la colonne products.supplier_id n'existent encore, et la vue échouerait.
DO $$
BEGIN
  IF to_regclass('public.suppliers') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'products' AND column_name = 'supplier_id') THEN
    EXECUTE $vue$
      CREATE OR REPLACE VIEW products_with_supplier
      WITH (security_invoker = true)
      AS
      SELECT
        p.id,
        p.user_id,
        p.name,
        p.sku,
        p.category,
        p.price_buy,
        p.price_sell,
        p.stock_qty,
        p.min_stock_level,
        p.is_active,
        p.created_at,
        p.supplier_id,
        s.name AS supplier_name,
        s.phone AS supplier_phone
      FROM products p
      LEFT JOIN suppliers s ON s.id = p.supplier_id
    $vue$;

    EXECUTE $c$
      COMMENT ON VIEW products_with_supplier IS
        'Catalogue avec le fournisseur principal. Les produits sans fournisseur '
        'sont conservés. security_invoker : l''isolation vient de la RLS de '
        'products et suppliers, pas d''une vue qui la contournerait.'
    $c$;

    EXECUTE $g$ REVOKE ALL ON products_with_supplier FROM PUBLIC $g$;
    EXECUTE $g$ GRANT SELECT ON products_with_supplier TO authenticated $g$;
    EXECUTE $g$ GRANT SELECT ON products_with_supplier TO service_role $g$;
  END IF;
END;
$$;

-- La contrainte de stock non négatif survit au changement de type, mais on la
-- recrée proprement : ALTER COLUMN TYPE réécrit la table et une contrainte
-- NOT VALID peut ne plus être garantie.
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_stock_qty_non_negative;
ALTER TABLE products ADD CONSTRAINT products_stock_qty_non_negative
  CHECK (stock_qty >= 0) NOT VALID;


-- ─── 3. create_sale() accepte les fractions ───────────────
-- Le motif passe de `^[0-9]+$` à une décimale optionnelle. Point ou virgule :
-- un clavier de téléphone au Bénin saisit « 1,2 » aussi souvent que « 1.2 ».
-- La virgule est remplacée avant conversion, sinon (e->>'quantity')::numeric
-- échoue sur « 1,2 » et la vente est refusée pour une raison invisible.
--
-- Borne haute : 1 000 000. Un ticket à plus d'un million d'unités est une
-- saisie erronée, pas une vente.
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
  v_qtys       numeric(12,3)[];
  v_agreed     numeric(12,2)[];   -- prix convenu, NULL = prix catalogue
  v_plan       text;
  v_counter    int;
  v_invoice    text;
  v_name       text;
  v_list       numeric(12,2);     -- prix catalogue (référence)
  v_price      numeric(12,2);     -- prix réellement facturé
  v_cost       numeric(12,2);
  v_stock      numeric(12,3);
  v_qty        numeric(12,3);
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

  -- 'credit' est accepté ici mais n'est pas un encaissement : la vente est
  -- créée, le stock part, et c'est record_credit_sale() qui la marque non
  -- encaissée et rattache le téléphone. Sans ce filet, un appel direct avec
  -- 'credit' produirait une vente comptée comme encaissée sans dette derrière.
  IF p_payment_method IS NULL
     OR p_payment_method NOT IN ('cash', 'momo', 'credit') THEN
    RAISE EXCEPTION 'Moyen de paiement invalide : %', p_payment_method USING ERRCODE = '22023';
  END IF;

  IF p_payment_method = 'credit' AND current_setting('credit.internal', true) IS DISTINCT FROM '1' THEN
    -- Garde-fou : create_sale() est exécutable par tout client authentifié. Un
    -- appel direct avec 'credit' créerait une vente comptée comme encaissée,
    -- sans dette derrière — exactement le trou que cette fonction comble.
    --
    -- record_credit_sale() pose credit.internal = '1' le temps de l'appel. Un
    -- GUC n'est pas modifiable par un client SQL ordinaire : seule une fonction
    -- SECURITY DEFINER peut le poser, et celle-ci l'est.
    RAISE EXCEPTION 'Utilisez record_credit_sale() pour une vente à crédit'
      USING ERRCODE = '22023';
  END IF;

  -- ── Valider chaque ligne AVANT toute écriture ──
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_items) AS e
    WHERE COALESCE(e->>'product_id', '') !~ '^[0-9a-fA-F-]{36}$'
       OR COALESCE(e->>'quantity', '') !~ '^[0-9]+([.,][0-9]{1,3})?$'
       OR (replace(e->>'quantity', ',', '.'))::numeric <= 0
       OR (replace(e->>'quantity', ',', '.'))::numeric > 1000000
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
             -- SUM conserve le fractionnaire : 1,2 + 0,8 = 2,0 et non 1.
             SUM((replace(e->>'quantity', ',', '.'))::numeric)::numeric(12,3) AS quantity,
             MIN((e->>'unit_price')::numeric) AS unit_price
        FROM jsonb_array_elements(p_items) AS e
       GROUP BY 1
    ) AS aggregated;

  -- ── Verrouiller les lignes produits et valider le stock ──
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

    v_price := COALESCE(v_agreed[v_i], v_list);

    v_total    := v_total + v_price * v_qtys[v_i];
    v_discount := v_discount + (v_list - v_price) * v_qtys[v_i];

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
  -- amount_received est ce qui est réellement rentré, et c'est la seule colonne
  -- qui décide du chiffre d'affaires. Une vente espèces ou MoMo vaut son prix :
  -- le client a payé, la monnaie a été rendue, le net encaissé est bien
  -- total_amount. Une vente à crédit est écrite à 0, puis record_credit_sale()
  -- y pose l'acompte — la seule fonction qui sait de combien il est.
  --
  -- Ce n'est pas de la copie : c'est ce qui garantit qu'un rapport en base de
  -- caisse ne peut pas diverger de la caisse. Sans cela, une vente espèces
  -- enregistrée à 0 disparaîtrait du chiffre d'affaires.
  INSERT INTO sales (
    user_id, total_amount, payment_method, client_name, note, invoice_number,
    amount_received
  ) VALUES (
    v_owner,
    v_total,
    p_payment_method,
    NULLIF(btrim(COALESCE(p_client_name, '')), ''),
    p_note,
    v_invoice,
    CASE WHEN p_payment_method = 'credit' THEN 0 ELSE v_total END
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

  RETURN jsonb_build_object(
    'id',              v_sale_id,
    'invoice_number',  v_invoice,
    'total_amount',    v_total,
    'discount_amount', v_discount,
    'at_loss_count',   v_at_loss
  );
END;
$$;

REVOKE ALL ON FUNCTION create_sale(jsonb, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_sale(jsonb, text, text, text) TO authenticated;

COMMENT ON COLUMN products.unit IS
  'Unité de vente : pce, kg, L, botte, sachet, tabla. Affichage seulement — '
  'la quantité reste un nombre dans cette unité. Un produit vendu en sachet et '
  'au kilo doit être deux produits.';
