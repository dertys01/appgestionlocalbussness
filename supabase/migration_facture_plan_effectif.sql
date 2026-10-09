-- ============================================================
-- migration_facture_plan_effectif.sql — la facture suit le plan EFFECTIF
-- À exécuter dans Supabase SQL Editor, APRÈS migration_facture_sequentielle.sql
-- ============================================================
--
-- BUG (cohérence de plan) : create_sale() lisait le plan BRUT
-- (`o.plan = 'pro'`) pour décider d'attribuer un numéro de facture, alors que
-- current_org_plan(), require_feature() et tous les écrans lisent le plan
-- EFFECTIF (essai Starter actif, période prépayée non échue).
--
-- Conséquence : une boutique Pro PRÉPAYÉE EXPIRÉE (plan = 'pro',
-- plan_valid_until dépassée) n'a plus accès aux rapports — require_feature la
-- refuse — mais continuait d'émettre des numéros « FAC-… » et le verrou client
-- peutDelivrerFacture() la croyait encore Pro, puisque le numéro existait.
-- Deux écrans de la même pièce qui ne disaient pas la même chose.
--
-- Ce que ça change : la décision de numéroter passe par le MÊME CASE que
-- current_org_plan() et check_product_limit() — plan effectif, essai et
-- échéance compris. Un essai Starter ne donne donc pas de facture (réservée au
-- Pro payé), et une période prépayée échue n'en donne plus.
--
-- Rejouable : CREATE OR REPLACE (signature inchangée), REVOKE/GRANT idempotents.
-- ============================================================

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
  v_annee      text;
  v_max_issued int;
  v_name       text;
  v_list       numeric(12,2);     -- prix catalogue (référence)
  v_price      numeric(12,2);     -- prix réellement facturé
  v_cost       numeric(12,2);
  v_stock      numeric(12,3);
  -- Quantité totale demandée pour un produit, toutes lignes confondues : c'est
  -- elle qu'on compare au stock, pas la quantité d'une ligne prise isolément.
  v_demande    numeric(12,3);
  v_qty        numeric(12,3);
  -- Le produit est-il un plat (produit avec recette) ? Un plat ne se stocke pas :
  -- ni contrôle, ni décrément — voir la boucle plus bas.
  v_est_plat   boolean;
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

  -- ── Agréger par (produit, prix) ──
  --
  -- L'agrégation se fait par produit ET par prix convenu, pas par produit seul.
  -- La version d'avant gardait MIN(unit_price) et REFUSAIT deux prix pour un même
  -- article — refus qui protégeait d'une sous-facturation, puisque le MIN perdait
  -- la différence. Mais le restaurant a le cas légitime : le même plat commandé
  -- deux fois avec deux options (une double portion, puis « bien cuit »). Cette
  -- ligne doit survivre à son prix.
  --
  -- Deux lignes au MÊME prix fusionnent toujours : 2 × « bien cuit » redeviennent
  -- une ligne de quantité 2, ce qui est le panier du comptoir.
  SELECT array_agg(product_id ORDER BY product_id, coalesce(unit_price, -1)),
         array_agg(quantity   ORDER BY product_id, coalesce(unit_price, -1)),
         array_agg(unit_price ORDER BY product_id, coalesce(unit_price, -1))
    INTO v_ids, v_qtys, v_agreed
    FROM (
      SELECT (e->>'product_id')::uuid AS product_id,
             -- SUM conserve le fractionnaire : 1,2 + 0,8 = 2,0 et non 1.
             SUM((replace(e->>'quantity', ',', '.'))::numeric)::numeric(12,3) AS quantity,
             (e->>'unit_price')::numeric AS unit_price
        FROM jsonb_array_elements(p_items) AS e
       GROUP BY 1, 3
    ) AS aggregated;

  -- ── Verrouiller les lignes produits et valider le stock ──
  --
  -- Le contrôle porte sur la quantité TOTALE par produit, pas sur chaque ligne :
  -- deux lignes du même produit verrouillent la même rangée, et vérifier 1 puis 1
  -- laisserait passer 2 sur un stock de 1 — l'erreur n'apparaîtrait qu'ensuite,
  -- en contrainte CHECK, avec un message que personne ne sait traduire.
  --
  -- UN PRODUIT QUI A UNE RECETTE EST UN PLAT, et la règle est différente : sa
  -- disponibilité vient de ses INGRÉDIENTS, pas de son propre stock. C'est ce
  -- que migration_recipes.sql dit depuis le début — « un plat se cuisine, il ne
  -- se stocke pas » — et create_sale() le contredisait : un plat à 0 (sa valeur
  -- naturelle) était refusé à la vente avec « Stock insuffisant pour « Riz gras »
  -- (disponible : 0, demandé : 1) », alors que ses ingrédients étaient là. Aucun
  -- plat du catalogue d'exemple n'était donc servable, et le blocage venait de
  -- la caisse, pas de la cuisine.
  --
  -- Le contrôle et le décrément sont donc sautés pour un plat ; c'est le
  -- déclencheur sale_items_consume_recipe qui refuse, ingredients vides, avec
  -- le bon message (« Stock insuffisant pour l'ingrédient « Riz blanc » »).
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

    v_est_plat := EXISTS (
      SELECT 1 FROM recipe_ingredients ri WHERE ri.dish_id = v_ids[v_i]
    );

    IF NOT v_est_plat THEN
      SELECT COALESCE(SUM(u.q), 0) INTO v_demande
        FROM unnest(v_qtys) WITH ORDINALITY AS u(q, n)
       WHERE u.n >= v_i AND v_ids[u.n] = v_ids[v_i];

      IF v_stock < v_demande THEN
        RAISE EXCEPTION 'Stock insuffisant pour « % » (disponible : %, demandé : %)',
          v_name, v_stock, v_demande USING ERRCODE = '23514';
      END IF;
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
  -- Plan EFFECTIF, comme current_org_plan() : essai Starter actif, période
  -- prépayée non échue. Un Pro échu ne numérote plus — la même vérité que les
  -- rapports, qui sont déjà verrouillés pour lui.
  SELECT CASE
           WHEN o.plan <> 'free' AND o.plan_valid_until IS NOT NULL
                AND o.plan_valid_until <= now() THEN 'free'
           WHEN o.plan = 'free' AND o.trial_ends_at > now() THEN 'starter'
           ELSE o.plan
         END
    INTO v_plan
    FROM organizations o
   WHERE o.id = v_owner;
  v_invoice := NULL;

  IF v_plan = 'pro' THEN
    v_annee := to_char(now(), 'YYYY');

    -- Réalignement AVANT de numéroter, dans la transaction de la vente.
    --
    -- La ligne organisation est verrouillée (FOR UPDATE) : deux caisses qui
    -- encaissent au même instant sont sérialisées ici, donc deux ventes ne
    -- peuvent pas lire le même compteur ni demander le même numéro suivant.
    --
    -- Le contrôle porte sur l'ANNÉE, pas sur toutes les factures : janvier
    -- repart légitimement à 1 (FAC-2026-00001 ≠ FAC-2027-00001 pour la
    -- contrainte d'unicité), et c'est ce qui rend inoffensive une facture de
    -- janvier saisie à la main.
    SELECT COALESCE(o.invoice_counter, 0),
           (SELECT COALESCE(MAX(substr(s.invoice_number, 10)::int), 0)
              FROM sales s
             WHERE s.user_id = o.id
               AND s.invoice_number ~ ('^FAC-' || v_annee || '-[0-9]+$'))
      INTO v_counter, v_max_issued
      FROM organizations o
     WHERE o.id = v_owner
     FOR UPDATE;

    -- Un compteur volontairement avancé n'est jamais reculé.
    IF v_counter < v_max_issued THEN
      v_counter := v_max_issued;
    END IF;

    -- Premier numéro libre à partir de v_counter + 1.
    --
    -- Après le réalignement ci-dessus, cette boucle tourne en principe zéro
    -- fois : elle ne sert que du cas résiduel — un numéro au bon gabarit mais
    -- hors suite (facture reprise d'un autre outil, compteur remis en arrière à
    -- la main). Mieux vaut une facture au numéro suivant qu'une violation
    -- d'unicité illisible à l'écran du commerçant. Bornée, elle ne boucle pas.
    --
    -- Le compteur est ensuite posé sur le numéro RÉELLEMENT retenu : il reste
    -- ainsi la vérité, et la vente suivante repart de là.
    FOR v_i IN 0 .. 1000 LOOP
      v_invoice := 'FAC-' || v_annee || '-' || lpad((v_counter + v_i + 1)::text, 5, '0');
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM sales s
         WHERE s.user_id = v_owner
           AND s.invoice_number = v_invoice
      );
    END LOOP;

    UPDATE organizations
       SET invoice_counter = substr(v_invoice, 10)::int
     WHERE id = v_owner;
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

    -- Un plat ne se stocke pas : on ne lui retire pas de quantité, et on
    -- n'écrit pas de mouvement de stock pour lui. Ce qui sort du stock, ce sont
    -- ses INGRÉDIENTS — et c'est le déclencheur sale_items_consume_recipe qui
    -- s'en charge, avec le contrôle qui va avec.
    --
    -- Sans ce IF, la ligne « Riz gras × 1 » essayait de passer son stock de 0 à
    -- −1 : la contrainte products_stock_qty_non_negative rejetait toute la
    -- vente, avec une erreur que personne ne sait traduire.
    IF NOT EXISTS (SELECT 1 FROM recipe_ingredients ri WHERE ri.dish_id = v_ids[v_i]) THEN
      UPDATE products SET stock_qty = stock_qty - v_qty WHERE id = v_ids[v_i];

      INSERT INTO stock_logs (
        user_id, product_id, product_name, movement_type,
        quantity_change, stock_before, stock_after, reference_id
      ) VALUES (
        v_owner, v_ids[v_i], v_name, 'sale',
        -v_qty, v_stock, v_stock - v_qty, v_sale_id
      );
    END IF;
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

-- Ce que la personne qui lit cette migration dans l'éditeur SQL doit savoir :
-- elle redépose un verrou de vente, et elle débloque les boutiques concernées.
COMMENT ON FUNCTION public.create_sale(jsonb, text, text, text) IS
  'Enregistre une vente et retourne son numéro de facture. Le compteur est '
  'réaligné sur les factures déjà émises pour l''année courante : une boutique '
  'dont le compteur a été désaligné (facture saisie à la main, restauration, '
  'bascule de plan) peut à nouveau vendre au lieu d''échouer sur une violation '
  'd''unicité qui la bloquait définitivement.';
