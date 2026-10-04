-- ============================================================
-- MIGRATION RESTAURATION : CLÔTURE D'ADDITION
-- À exécuter dans Supabase SQL Editor, après migration_restaurant_tables.sql
--
-- Le Sprint 13 a créé la commande qui vit sur sa table. Elle ne vendait rien :
-- `sales` restait la seule source de vérité du chiffre d'affaires, donc une
-- table servie n'était dans AUCUN rapport. Ce sprint la relie au comptoir.
--
-- close_table_order() fait trois choses dans UNE transaction :
--   1. transforme les lignes de commande en articles de vente
--   2. passe par create_sale() — donc décrément de stock, coût figé, prix
--      convenu, numéro de facture, journal : aucune logique dupliquée
--   3. clôture la commande et la rattache à la vente écrite
--
-- L'addition partagée ne crée pas N ventes. Dans un restaurant, trois
-- convives à 12 000 F sont UNE vente de 36 000 F : le fractionnement sert à
-- afficher le compte de chacun, jamais à gonfler le chiffre d'affaires.
--
-- Ce que le fractionnement n'est PAS :
--   - un encaissement en N fois (chaque fois une vente distincte fausserait
--     les rapports de rentabilité, qui comptent par vente) ;
--   - un droit de encaisser seulement une part : qui paie pour toute la table ?
--     La table est soldée quand le TOTAL est réglé.
-- ============================================================

-- ─── 1. Colonnes de clôture ─────────────────────────────────
-- part_count : combien de parts l'addition est répartie en (1 = table entière).
ALTER TABLE restaurant_orders
  ADD COLUMN IF NOT EXISTS split_count int NOT NULL DEFAULT 1
  CHECK (split_count BETWEEN 1 AND 20);

ALTER TABLE restaurant_orders
  ADD COLUMN IF NOT EXISTS payment_method text
  CHECK (payment_method IS NULL OR payment_method IN ('cash', 'momo', 'credit'));

-- Le ticket de cuisine s'imprime à la commande, pas à la clôture : la cuisine
-- a déjà cuisine quand l'addition arrive. On note donc ce qui est parti.
ALTER TABLE restaurant_order_items
  ADD COLUMN IF NOT EXISTS sent_at timestamptz;

-- ─── 2. Ticket de cuisine ───────────────────────────────────
-- Une vue, pas une table : le ticket est une LECTURE de la commande au moment
-- où la cuisine l'imprime. Le stocker dupliquerait l'état et pourrait diverger
-- de la commande — exactement ce que le stock figé à la vente évite pour le coût.
CREATE OR REPLACE VIEW restaurant_kitchen_ticket
WITH (security_invoker = true)
AS
SELECT
  ro.id            AS order_id,
  t.name           AS table_name,
  t.zone           AS zone,
  ro.opened_at,
  i.id             AS item_id,
  p.name           AS product_name,
  i.quantity,
  i.note,
  i.status,
  i.created_at
FROM restaurant_orders ro
LEFT JOIN restaurant_tables t ON t.id = ro.table_id
JOIN restaurant_order_items i ON i.order_id = ro.id
JOIN products p ON p.id = i.product_id
-- Une commande close n'a plus de cuisine à faire : son ticket est clos.
WHERE ro.status <> 'closed';

COMMENT ON VIEW restaurant_kitchen_ticket IS
  'Ticket de cuisine : les plats d''une commande, SANS PRIX. Une cuisine ne '
  'connaît pas les tarifs. security_invoker : les policies des tables '
  'sous-jacentes restent la seule autorisation.';

REVOKE ALL ON restaurant_kitchen_ticket FROM anon;
GRANT SELECT ON restaurant_kitchen_ticket TO authenticated, service_role;

-- ─── 3. Clôture ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION close_table_order(
  p_order_id      uuid,
  p_payment_method text,
  p_amount_paid   numeric(12,2) DEFAULT NULL,
  p_split_count   int          DEFAULT 1,
  p_client_phone  text         DEFAULT NULL,
  p_note          text         DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner    uuid;
  v_order    restaurant_orders%ROWTYPE;
  v_items    jsonb;
  v_sale     jsonb;
  v_sale_id  uuid;
  v_total    numeric(12,2);
  v_paid     numeric(12,2);
BEGIN
  v_owner := get_business_owner_id();
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Non authentifié' USING ERRCODE = '28000';
  END IF;

  -- ── Le rôle, explicitement ──
  -- SECURITY DEFINER s'exécute avec les droits du propriétaire de la fonction :
  -- les policies de restaurant_orders sont donc IGNORÉES. Sans ce contrôle, un
  -- simple caissier du tenant pourrait appeler la fonction et solder une
  -- addition, c'est-à-dire écrire la vente du patron. La policy de mise à jour
  -- ne protège plus rien ici — c'est la fonction qui protège.
  -- Le patron n'est PAS membre de sa propre boutique : il n'a pas de ligne dans
  -- business_members. Le test doit donc accepter le propriétaire lui-même, ou un
  -- membre de rôle owner/manager.
  IF v_owner <> auth.uid()
     AND NOT EXISTS (
       SELECT 1 FROM business_members bm
        WHERE bm.member_id = auth.uid()
          AND bm.owner_id = v_owner
          AND bm.role IN ('owner', 'manager')
     ) THEN
    RAISE EXCEPTION 'Seul le patron ou un manager peut encaisser une addition'
      USING ERRCODE = '42501';
  END IF;

  -- ── Verrouiller la commande ──
  -- FOR UPDATE sérialise deux clôtures simultanées de la même table : sans lui,
  -- les deux écrivent une vente et le total de l'addition est doublé.
  SELECT * INTO v_order
    FROM restaurant_orders
   WHERE id = p_order_id
     AND owner_id = v_owner
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Commande introuvable' USING ERRCODE = 'P0002';
  END IF;

  IF v_order.status = 'closed' THEN
    RAISE EXCEPTION 'Cette addition est déjà soldée' USING ERRCODE = '22023';
  END IF;

  IF p_payment_method IS NULL
     OR p_payment_method NOT IN ('cash', 'momo', 'credit') THEN
    RAISE EXCEPTION 'Moyen de paiement invalide : %', p_payment_method USING ERRCODE = '22023';
  END IF;

  IF p_split_count IS NULL OR p_split_count < 1 OR p_split_count > 20 THEN
    RAISE EXCEPTION 'Nombre de parts invalide' USING ERRCODE = '22023';
  END IF;

  -- ── La commande doit avoir des plats ──
  IF NOT EXISTS (SELECT 1 FROM restaurant_order_items WHERE order_id = p_order_id) THEN
    RAISE EXCEPTION 'Aucun plat à encaisser sur cette table' USING ERRCODE = '22023';
  END IF;

  -- ── Les lignes deviennent des articles de vente ──
  -- create_sale() refuse deux prix différents pour le même article — c'est
  -- justifié au comptoir, où deux lignes du même produit ne peuvent être que
  -- la même commande. Sur une table, c'est différent : le patron négocie, et
  -- « un poulet à 4 000 puis un autre à 4 500 » est une chose réelle. On
  -- regroupe donc par produit et on retient le prix le plus bas : c'est la
  -- remise que la table a obtenue, appliquée à toutes les lignes de ce plat.
  --
  -- Le total est recalculé à partir de ce regroupement, jamais à partir d'une
  -- somme de lignes : les deux doivent coïncider, sinon la facture et l'écran
  -- montreraient deux montants différents.
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'product_id', a.product_id,
           'quantity',   a.quantity,
           'unit_price', a.unit_price
         )), '[]'::jsonb),
         coalesce(sum(a.quantity * a.unit_price), 0)
    INTO v_items, v_total
    FROM (
      SELECT i.product_id,
             sum(i.quantity)::numeric(12,3)            AS quantity,
             min(i.unit_price)::numeric(12,2)          AS unit_price
        FROM restaurant_order_items i
       WHERE i.order_id = p_order_id
       GROUP BY i.product_id
    ) AS a;

  -- ── Encaissement ──
  -- create_sale() fait le travail lourd : atomicité, stock, coût figé, numéro
  -- de facture, journal. On l'appelle, on ne le réécrit pas.
  IF p_payment_method = 'credit' THEN
    -- Vente à crédit : elle passe par record_credit_sale(), qui rattache le
    -- client et gère l'acompte. Sans elle, create_sale('credit') refuse (le
    -- garde-fou credit.internal) et la dette n'existerait pas.
    IF btrim(COALESCE(p_client_phone, '')) = '' THEN
      RAISE EXCEPTION 'Un numéro est requis pour une addition à crédit' USING ERRCODE = '22023';
    END IF;

    v_sale := record_credit_sale(
      v_items,
      COALESCE(NULLIF(btrim(v_order.customer_name), ''), 'Client table'),
      p_client_phone,
      COALESCE(p_note, format('Table %s', COALESCE((SELECT name FROM restaurant_tables WHERE id = v_order.table_id), 'à emporter'))),
      COALESCE(v_order.amount_paid, 0) + COALESCE(p_amount_paid, 0)
    );
  ELSE
    v_sale := create_sale(
      v_items,
      p_payment_method,
      NULLIF(btrim(COALESCE(v_order.customer_name, '')), ''),
      COALESCE(p_note, format('Table %s', COALESCE((SELECT name FROM restaurant_tables WHERE id = v_order.table_id), 'à emporter')))
    );
  END IF;

  v_sale_id := (v_sale->>'id')::uuid;

  -- ── Ce qui a été réellement encaissé ──
  -- Une addition espèces est soldée en totalité ; un acompte a pu être versé
  -- avant (amount_paid) et le reste est donné maintenant. Le crédit déduit ce
  -- qu'il a reçu, on ne fait donc qu'y ajouter ce qui est versé ici.
  IF p_payment_method = 'credit' THEN
    v_paid := COALESCE(v_order.amount_paid, 0) + COALESCE(p_amount_paid, 0);
    IF v_paid > v_total THEN
      RAISE EXCEPTION
        'Le montant versé (% F) dépasse l''addition (% F)', v_paid, v_total
        USING ERRCODE = '22023';
    END IF;
  ELSE
    v_paid := v_total + COALESCE(p_amount_paid, 0);
  END IF;

  -- ── Clôture ──
  -- status, closed_at et sale_id ensemble : la contrainte de
  -- migration_restaurant_tables.sql l'exige, et sale_id relie la commande à la
  -- vente sans la dupliquer.
  UPDATE restaurant_orders
     SET status = 'closed',
         closed_at = now(),
         sale_id = v_sale_id,
         split_count = p_split_count,
         payment_method = p_payment_method,
         amount_paid = v_paid
   WHERE id = p_order_id;

  RETURN jsonb_build_object(
    'sale_id',        v_sale_id,
    'invoice_number', v_sale->>'invoice_number',
    'total_amount',   v_total,
    'amount_paid',    v_paid,
    'split_count',    p_split_count,
    -- Le compte de chaque part, arrondi au franc. Le reste éventuel porte sur
    -- la dernière part : une addition de 100 F en 3 ne peut pas donner
    -- 33,33 × 3 = 99,99 et perdre 1 F sans que personne ne sache où il est passé.
    'per_share',      round(v_total / p_split_count, 2)
  );
END;
$$;

REVOKE ALL ON FUNCTION close_table_order(uuid, text, numeric, int, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION close_table_order(uuid, text, numeric, int, text, text) TO authenticated;

COMMENT ON FUNCTION close_table_order(uuid, text, numeric, int, text, text) IS
  'Solde une addition de table : transforme les lignes en vente via create_sale(), '
  'puis clôture la commande. Le fractionnement ne multiplie PAS les ventes — trois '
  'convives à 12 000 F font une vente de 36 000 F, répartie en 3 parts pour '
  'l''affichage seulement.';

-- ─── 4. Marquer « parti en cuisine » ────────────────────────
-- Un service en salle doit pouvoir dire « c'est parti » sans passer par
-- l'interface : c'est une action de terrain, elle se fait d'un geste.
-- La ligne doit être 'new' : on ne ré-expédie pas un plat déjà servi, et on ne
-- touche pas une commande close.
CREATE OR REPLACE FUNCTION send_order_items(p_order_id uuid)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid;
  v_sent  int;
BEGIN
  v_owner := get_business_owner_id();
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Non authentifié' USING ERRCODE = '28000';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM restaurant_orders
     WHERE id = p_order_id AND owner_id = v_owner AND status <> 'closed'
  ) THEN
    RAISE EXCEPTION 'Commande introuvable ou déjà soldée' USING ERRCODE = 'P0002';
  END IF;

  UPDATE restaurant_order_items
     SET status = 'sent', sent_at = now()
   WHERE order_id = p_order_id
     AND status = 'new';

  GET DIAGNOSTICS v_sent = ROW_COUNT;
  RETURN v_sent;
END;
$$;

REVOKE ALL ON FUNCTION send_order_items(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION send_order_items(uuid) TO authenticated;