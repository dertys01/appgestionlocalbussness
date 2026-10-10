-- ============================================================
-- MIGRATION RESTAURATION : MODIFICATEURS, PLATS DU JOUR, POURBOIRE
-- À exécuter dans Supabase SQL Editor, après migration_recipes.sql
--
-- Sprint 16 — les finitions qui font la différence entre « une caisse qui
-- gère des plats » et « une caisse de restaurant ».
--
-- 1. MODIFICATEURS
--    « Poulet braisé », c'est trois plats différents : bien cuit, à point,
--    saignant. Sans option, le serveur note sur un ticket papier et le prix
--    facturé ne correspond pas à ce qui a été servi. Un modificateur porte
--    donc un NOM et un supplément — la cuisson ne coûte pas plus cher, mais
--    « double portion » ou « avec fromage » si.
--
-- 2. PLATS DU JOUR
--    Un restaurant ne sert pas la même carte tous les jours. Un plat absent de
--    l'offre du jour doit disparaître de la liste de commande : le garder
--    visible, c'est proposer un plat qu'on ne cuisine pas. `is_daily_special`
--    est un drapeau simple — pas une planification par jour de la semaine, qui
--    serait une vraie gestion de carte et mérite son propre écran.
--
-- 3. POURBOIRE
--    Au Bénin, le pourboire se laisse en espèces sur la table et n'arrive
--    jamais dans la caisse. Il n'est ni une recette ni un coût : c'est une
--    manne, encaissée hors application. On le note pour le savoir, sans
--    l'ajouter au chiffre d'affaires — sinon les rapports mensuels
--    surestimeraient le CA, et le patron paierait ses fees sur une recette
--    qu'il n'a pas eue.
--
-- Le ticket de cuisine garde son prix : une cuisine ne connaît pas les tarifs.
-- Les modificateurs y apparaissent en toutes lettres, par contre — « bien
-- cuit » sans prix est précisément l'information utile.
-- ============================================================

-- ─── 1. Modificateurs ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS product_modifiers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  product_id  uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name        text NOT NULL,
  -- Supplément facturé, jamais négatif : « sans lactose » ne rapporte pas.
  extra_price numeric(12,2) NOT NULL DEFAULT 0 CHECK (extra_price >= 0),
  -- Un modificateur peut être obligatoire (cuisson) ou au choix (sauce). Une
  -- cuisson obligatoire refusée à la commande bloquerait la vente : c'est le
  -- rôle du serveur, pas d'une contrainte SQL.
  is_required boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT product_modifiers_name_len CHECK (length(btrim(name)) BETWEEN 1 AND 60)
);

CREATE INDEX IF NOT EXISTS idx_product_modifiers_product
  ON product_modifiers(product_id);

ALTER TABLE product_modifiers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "modifiers_read" ON product_modifiers;
CREATE POLICY "modifiers_read" ON product_modifiers
  FOR SELECT USING (owner_id = get_business_owner_id());

-- Écrire la carte : patron ou manager, comme les recettes et la salle.
DROP POLICY IF EXISTS "modifiers_write" ON product_modifiers;
CREATE POLICY "modifiers_write" ON product_modifiers
  FOR ALL
  USING (
    owner_id = get_business_owner_id() AND can_manage_products()
  )
  WITH CHECK (
    owner_id = get_business_owner_id() AND can_manage_products()
  );

-- ─── 2. Choix du client sur une ligne de commande ───────────
ALTER TABLE restaurant_order_items
  ADD COLUMN IF NOT EXISTS modifier text;

ALTER TABLE restaurant_order_items
  ADD COLUMN IF NOT EXISTS extra_price numeric(12,2) NOT NULL DEFAULT 0;

-- ADD COLUMN IF NOT EXISTS est sans effet sur une colonne EXISTANTE : le CHECK
-- voyage avec elle. On garde donc les contraintes dans des blocs IF EXISTS,
-- séparés — c'est la seule forme rejouable ici, un ADD CONSTRAINT n'ayant pas
-- d'équivalent idempotent.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'restaurant_order_items_extra_price_check'
  ) THEN
    ALTER TABLE restaurant_order_items
      ADD CONSTRAINT restaurant_order_items_extra_price_check CHECK (extra_price >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'restaurant_order_items_modifier_len'
  ) THEN
    ALTER TABLE restaurant_order_items
      ADD CONSTRAINT restaurant_order_items_modifier_len
      CHECK (modifier IS NULL OR length(modifier) <= 120);
  END IF;
END;
$$;

-- ─── 3. Plat du jour ────────────────────────────────────────
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS is_daily_special boolean NOT NULL DEFAULT false;

-- ─── 4. Pourboire ───────────────────────────────────────────
ALTER TABLE restaurant_orders
  ADD COLUMN IF NOT EXISTS tip numeric(12,2) NOT NULL DEFAULT 0 CHECK (tip >= 0);

-- ─── 5. Le ticket de cuisine, avec les modificateurs ────────
-- DROP puis CREATE, et non CREATE OR REPLACE : la nouvelle colonne `modifier`
-- est insérée AU MILIEU de la liste (après `note`), et PostgreSQL refuse de
-- renommer une colonne existante — « cannot change name of view column status
-- to modifier ». C'est la seule raison du DROP ; la vue ne porte aucun état.
DROP VIEW IF EXISTS restaurant_kitchen_ticket;

CREATE VIEW restaurant_kitchen_ticket
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
  i.modifier,
  i.status,
  i.created_at
FROM restaurant_orders ro
LEFT JOIN restaurant_tables t ON t.id = ro.table_id
JOIN restaurant_order_items i ON i.order_id = ro.id
JOIN products p ON p.id = i.product_id
WHERE ro.status <> 'closed';

REVOKE ALL ON restaurant_kitchen_ticket FROM anon;
GRANT SELECT ON restaurant_kitchen_ticket TO authenticated, service_role;

COMMENT ON COLUMN restaurant_order_items.modifier IS
  'Modificateur choisi (cuisson, sauce, portion). Affiché tel quel au ticket de '
  'cuisine, SANS son prix : une cuisine ne connaît pas les tarifs.';

COMMENT ON COLUMN restaurant_orders.tip IS
  'Pourboire laissé sur la table. Informatif : il n''entre NI dans le chiffre '
  'd''affaires NI dans les recettes, c''est une manne encaissée hors application.';

-- ─── 6. Clôture : pourboire et modificateurs ────────────────
-- Le prix unitaire d'une ligne devient prix + supplément : c'est ce qui est
-- réellement servi. Le modificateur ne change que le prix, pas le stock
-- décrémenté — un supplément de fromage consomme le fromage, mais ce lien
-- ingredients n'est pas modélisé ici (les recettes le couvrent déjà).
CREATE OR REPLACE FUNCTION close_table_order(
  p_order_id       uuid,
  p_payment_method text,
  p_amount_paid    numeric(12,2) DEFAULT NULL,
  p_split_count    int          DEFAULT 1,
  p_client_phone   text         DEFAULT NULL,
  p_note           text         DEFAULT NULL,
  p_tip            numeric(12,2) DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner   uuid;
  v_order   restaurant_orders%ROWTYPE;
  v_items   jsonb;
  v_sale    jsonb;
  v_sale_id uuid;
  v_total   numeric(12,2);
  v_paid    numeric(12,2);
  v_tip     numeric(12,2);
  v_table   text;
BEGIN
  v_owner := get_business_owner_id();
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Non authentifié' USING ERRCODE = '28000';
  END IF;

  -- SECURITY DEFINER ignore les policies : le rôle se vérifie ici.
  --
  -- L'ADMINISTRATION de la salle est réservée au patron et aux managers — pas
  -- question de donner ce pouvoir à un caissier.
  --
  -- L'ENCAISSEMENT, en revanche, est ouvert à quiconque est dans l'équipe. La
  -- règle était ici plus stricte que sur la caisse, et c'était une incohérence
  -- coûteuse : create_sale() n'examine pas le rôle — un caissier encaisse au
  -- comptoir tous les jours — alors qu'il ne pouvait pas solder une table dont
  -- il venait de servir les plats. Dans un maquis, le personnel est employé :
  -- il ramasse l'argent, et il ne pouvait pas l'écrire. Le patron devait solder
  -- une addition après l'autre, ce qui est exactement le mode de
  -- fonctionnement que le logiciel était censé supprimer.
  --
  -- Ce que la vente reste patronale dans TOUS les cas : ci-dessous,
  -- create_sale() écrit la vente avec user_id = v_owner, jamais avec
  -- l'identifiant de celui qui appuie sur le bouton. Ouvrir l'encaissement au
  -- caissier ne déplace donc ni le chiffre d'affaires, ni le crédit de la vente,
  -- ni les commissions éventuelles. Il lui donne seulement le geste qu'il
  -- fait déjà au comptoir.
  --
  -- Le montant facturé est lu dans les LIGNES DE COMMANDE, jamais reçu du
  -- client : un caissier ne peut pas faire encaisser 100 F en appelant la
  -- fonction, le montant à payer est celui qui était affiché à l'écran.
  IF v_owner <> auth.uid()
     AND NOT EXISTS (
       SELECT 1 FROM business_members bm
        WHERE bm.member_id = auth.uid()
          AND bm.owner_id = v_owner
     ) THEN
    RAISE EXCEPTION 'Seul le patron, un manager ou un membre de l''équipe peut encaisser cette addition'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_order
    FROM restaurant_orders
   WHERE id = p_order_id AND owner_id = v_owner
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Commande introuvable' USING ERRCODE = 'P0002';
  END IF;
  IF v_order.status = 'closed' THEN
    RAISE EXCEPTION 'Cette addition est déjà soldée' USING ERRCODE = '22023';
  END IF;
  IF p_payment_method IS NULL OR p_payment_method NOT IN ('cash','momo','credit') THEN
    RAISE EXCEPTION 'Moyen de paiement invalide : %', p_payment_method USING ERRCODE = '22023';
  END IF;
  IF p_split_count IS NULL OR p_split_count < 1 OR p_split_count > 20 THEN
    RAISE EXCEPTION 'Nombre de parts invalide' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM restaurant_order_items WHERE order_id = p_order_id) THEN
    RAISE EXCEPTION 'Aucun plat à encaisser sur cette table' USING ERRCODE = '22023';
  END IF;

  -- Un pourboire négatif ou absurde (10 fois l'addition) est une faute de
  -- saisie. Le plafond est large mais fini : personne ne laisse 500 000 F
  -- de pourboire sur une table à 20 000 F.
  v_tip := round(COALESCE(p_tip, 0), 2);
  IF v_tip < 0 THEN
    RAISE EXCEPTION 'Le pourboire ne peut pas être négatif' USING ERRCODE = '22023';
  END IF;

  SELECT name INTO v_table FROM restaurant_tables WHERE id = v_order.table_id;
  v_table := COALESCE(v_table, 'à emporter');

  -- Le prix unitaire inclut le supplément du modificateur.
  --
  -- Regroupement par (produit, PRIX EFFECTIF), jamais par produit seul.
  -- L'ancien code faisait min(unit_price + extra_price) par produit : deux
  -- lignes du MÊME plat avec deux options différentes — une double portion
  -- puis « bien cuit » — étaient fusionnées, et seul le supplément le moins
  -- cher survivait. Une table à 10 500 F était encaissée 9 000 F, sans que
  -- l'écran et le reçu divergent : ils divergeaient du prix affiché.
  --
  -- La fusion reste juste quand elle doit l'être : deux lignes du même plat au
  -- MÊME prix (deux « bien cuit ») redeviennent une ligne de quantité 2, ce que
  -- create_sale() exige — il refuse deux prix différents pour un même article.
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'product_id', a.product_id, 'quantity', a.quantity, 'unit_price', a.unit_price)), '[]'::jsonb),
         coalesce(sum(a.quantity * a.unit_price), 0)
    INTO v_items, v_total
    FROM (
      SELECT i.product_id,
             sum(i.quantity)::numeric(12,3) AS quantity,
             (i.unit_price + i.extra_price)::numeric(12,2) AS unit_price
        FROM restaurant_order_items i
       WHERE i.order_id = p_order_id
       GROUP BY i.product_id, (i.unit_price + i.extra_price)
    ) AS a;

  IF p_payment_method = 'credit' THEN
    IF btrim(COALESCE(p_client_phone, '')) = '' THEN
      RAISE EXCEPTION 'Un numéro est requis pour une addition à crédit' USING ERRCODE = '22023';
    END IF;
    v_sale := record_credit_sale(
      v_items,
      COALESCE(NULLIF(btrim(v_order.customer_name), ''), 'Client table'),
      p_client_phone,
      COALESCE(p_note, 'Table ' || v_table),
      COALESCE(v_order.amount_paid, 0) + COALESCE(p_amount_paid, 0)
    );
  ELSE
    v_sale := create_sale(
      v_items, p_payment_method,
      NULLIF(btrim(COALESCE(v_order.customer_name, '')), ''),
      COALESCE(p_note, 'Table ' || v_table)
    );
  END IF;

  v_sale_id := (v_sale->>'id')::uuid;

  IF p_payment_method = 'credit' THEN
    v_paid := COALESCE(v_order.amount_paid, 0) + COALESCE(p_amount_paid, 0);
    IF v_paid > v_total THEN
      RAISE EXCEPTION 'Le montant versé (% F) dépasse l''addition (% F)', v_paid, v_total
        USING ERRCODE = '22023';
    END IF;
  ELSE
    v_paid := v_total;
  END IF;

  UPDATE restaurant_orders
     SET status = 'closed', closed_at = now(), sale_id = v_sale_id,
         split_count = p_split_count, payment_method = p_payment_method,
         amount_paid = v_paid, tip = v_tip
   WHERE id = p_order_id;

  -- Le pourboire est HORS du total_amount de la vente : une manne n'est pas
  -- une recette. Le renvoyer à part permet à l'écran de dire « 36 000 + 5 000
  -- de pourboire » sans que la caisse ne compte 41 000.
  RETURN jsonb_build_object(
    'sale_id',        v_sale_id,
    'invoice_number', v_sale->>'invoice_number',
    'total_amount',   v_total,
    'amount_paid',    v_paid,
    'tip',            v_tip,
    'total_with_tip', v_total + v_tip,
    'split_count',    p_split_count,
    'per_share',      round(v_total / p_split_count, 2)
  );
END;
$$;

REVOKE ALL ON FUNCTION close_table_order(uuid, text, numeric, int, text, text, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION close_table_order(uuid, text, numeric, int, text, text, numeric) TO authenticated;

-- La version à 6 arguments est RETIRÉE : PostgREST résout par NOMBRE
-- d'arguments, et deux signatures proches créeraient une ambiguïté silencieuse
-- (« function close_table_order(...) is not unique »). Seule la 7-arg reste.
DROP FUNCTION IF EXISTS close_table_order(uuid, text, numeric, int, text, text);

COMMENT ON FUNCTION close_table_order(uuid, text, numeric, int, text, text, numeric) IS
  'Solde une addition : les lignes (modificateur inclus) deviennent une vente via '
  'create_sale(), la commande est close. Le fractionnement n''écrit QU''une vente. '
  'Le pourboire est enregistré mais HORS du chiffre d''affaires : c''est une '
  'manne, pas une recette.';

-- ─── 7. Réservations ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS restaurant_reservations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  customer_name text NOT NULL,
  -- Le premier slot sert : « 12h30 » plutôt que « 2026-10-04 12:30 », le patron
  -- n'a qu'un service par jour à retenir.
  slot_at      timestamptz NOT NULL,
  party_size   int NOT NULL DEFAULT 2 CHECK (party_size > 0),
  phone        text,
  table_id     uuid REFERENCES restaurant_tables(id) ON DELETE SET NULL,
  -- confirmed = le patron a appelé · seated = le client est arrivé · done = parti
  status       text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'confirmed', 'seated', 'done', 'no_show')),
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT restaurant_reservations_name_len CHECK (length(btrim(customer_name)) BETWEEN 1 AND 80)
);

CREATE INDEX IF NOT EXISTS idx_restaurant_reservations_slot
  ON restaurant_reservations(owner_id, slot_at)
  WHERE status NOT IN ('done', 'no_show');

ALTER TABLE restaurant_reservations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "reservations_read" ON restaurant_reservations;
CREATE POLICY "reservations_read" ON restaurant_reservations
  FOR SELECT USING (owner_id = get_business_owner_id());

-- Écrire une réservation n'est pas un acte de gestion : un caissier prend
-- les réservations au téléphone. Il ne les annule pas pour autant — une
-- résiliation est une décision du patron.
DROP POLICY IF EXISTS "reservations_write" ON restaurant_reservations;
CREATE POLICY "reservations_write" ON restaurant_reservations
  FOR ALL
  USING (owner_id = get_business_owner_id())
  WITH CHECK (owner_id = get_business_owner_id());