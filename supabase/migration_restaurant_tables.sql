-- ============================================================
-- MIGRATION RESTAURATION : TABLES & COMMANDE OUVERTE
-- À exécuter dans Supabase SQL Editor, après migration_domain.sql
--
-- Le service d'un restaurant n'est pas un encaissement : c'est une commande
-- qui vit, sur une table, avant d'être soldée. On l'ajoute SANS toucher aux
-- ventes : `sales` reste la seule source de vérité du chiffre d'affaires, et
-- une table n'est qu'un conteneur de commande.
--
-- Découpage :
--   restaurant_tables  la salle (nom, zone, places, active)
--   restaurant_orders  une commande ouverte, avec son état d'avancement
--   restaurant_order_items  les lignes : plat, quantité, prix convenu,
--                           note cuisine, état (à envoyer / envoyé / servi)
--
-- Multi-tenant : tout passe par get_business_owner_id(), comme le reste.
-- Un employé encaisse en salle : il écrit dans les commandes, il ne décide
-- ni de la salle (écriture patron + manager uniquement).
-- ============================================================

-- ─── 1. La salle ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS restaurant_tables (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name        text NOT NULL,
  zone        text NOT NULL DEFAULT 'Salle',
  seats       int,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT restaurant_tables_name_len CHECK (length(btrim(name)) BETWEEN 1 AND 40)
);

CREATE INDEX IF NOT EXISTS idx_restaurant_tables_owner
  ON restaurant_tables(owner_id, name);

-- ─── 2. La commande ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS restaurant_orders (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  table_id     uuid REFERENCES restaurant_tables(id) ON DELETE SET NULL,
  -- null = commande à emporter : elle n'occupe aucune table.
  customer_name text,
  status       text NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open', 'bill_requested', 'closed')),
  -- Acomptes déjà encaissés sur une table, avant la clôture. L'addition du
  -- Sprint 14 les déduira du solde : sans cette colonne, un acompte était
  -- un encaissement invisible dans la commande.
  amount_paid  numeric(12,2) NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
  opened_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  opened_at    timestamptz NOT NULL DEFAULT now(),
  closed_at    timestamptz,
  -- La vente écrite à la clôture : relie la commande au chiffre d'affaires
  -- sans le dupliquer. `sales.id` est un uuid, la FK tient.
  sale_id      uuid REFERENCES sales(id) ON DELETE SET NULL,

  CONSTRAINT restaurant_orders_closed_at CHECK (
    (status = 'closed' AND closed_at IS NOT NULL) OR (status <> 'closed' AND closed_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_restaurant_orders_open
  ON restaurant_orders(owner_id, opened_at DESC)
  WHERE status <> 'closed';

-- Une seule commande ouverte par table. Sans cet index unique, deux serveurs
-- ouvraient deux tickets sur la même table et l'addition aurait totalisé les
-- deux — l'erreur la plus coûteuse du métier, et la plus difficile à voir.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_restaurant_orders_open_table
  ON restaurant_orders(table_id)
  WHERE status <> 'closed';

-- ─── 3. Les lignes de commande ──────────────────────────────
CREATE TABLE IF NOT EXISTS restaurant_order_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    uuid NOT NULL REFERENCES restaurant_orders(id) ON DELETE CASCADE,
  product_id  uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  quantity    numeric(12,3) NOT NULL CHECK (quantity > 0),
  -- Prix convenu comme au POS : le patron de la table négocie.
  unit_price  numeric(12,2) NOT NULL CHECK (unit_price >= 0),
  -- Note cuisine : « peu épicé », « sans oignon », « à emporter ». Volontairement
  -- du texte libre : un serveur tape vite, une liste déroulante l'arrêterait.
  note        text,
  -- new = à envoyer en cuisine · sent = parti · served = servi
  status      text NOT NULL DEFAULT 'new'
                CHECK (status IN ('new', 'sent', 'served')),
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT restaurant_order_items_note_len CHECK (note IS NULL OR length(note) <= 300)
);

CREATE INDEX IF NOT EXISTS idx_restaurant_order_items_order
  ON restaurant_order_items(order_id, status);

-- ─── 4. RLS ─────────────────────────────────────────────────
-- Pattern du reste du projet : get_business_owner_id() résout le tenant, que
-- l'appelant soit le patron ou un employé de sa boutique.
ALTER TABLE restaurant_tables ENABLE ROW LEVEL SECURITY;
ALTER TABLE restaurant_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE restaurant_order_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "restaurant_tables_read" ON restaurant_tables;
CREATE POLICY "restaurant_tables_read" ON restaurant_tables
  FOR SELECT USING (owner_id = get_business_owner_id());

-- Écrire la salle est une décision de patron ou de manager, pas de caissier :
-- réorganiser les tables pendant le service n'appartient pas à un employé.
DROP POLICY IF EXISTS "restaurant_tables_write" ON restaurant_tables;
DROP POLICY IF EXISTS "restaurant_tables_manage" ON restaurant_tables;
CREATE POLICY "restaurant_tables_manage" ON restaurant_tables
  FOR ALL
  USING (
    owner_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM business_members bm
      WHERE bm.owner_id = restaurant_tables.owner_id
        AND bm.member_id = auth.uid()
        AND bm.role IN ('owner', 'manager')
    )
  )
  WITH CHECK (
    owner_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM business_members bm
      WHERE bm.owner_id = restaurant_tables.owner_id
        AND bm.member_id = auth.uid()
        AND bm.role IN ('owner', 'manager')
    )
  );

-- Un employé encaisse : il ouvre une commande (INSERT) et travaille ses lignes.
-- Il ne MODIFIE ni ne clôture la commande elle-même.
--
-- Deux policies distinctes plutôt qu'un FOR ALL : un FOR ALL donnerait au
-- caissier l'UPDATE, donc le droit de solder une addition — c'est-à-dire
-- d'écrire (ou non) la vente du patron.
DROP POLICY IF EXISTS "restaurant_orders_read" ON restaurant_orders;
CREATE POLICY "restaurant_orders_read" ON restaurant_orders
  FOR SELECT USING (owner_id = get_business_owner_id());

DROP POLICY IF EXISTS "restaurant_orders_open" ON restaurant_orders;
CREATE POLICY "restaurant_orders_open" ON restaurant_orders
  FOR INSERT
  WITH CHECK (
    owner_id = get_business_owner_id()
    AND status = 'open'
    AND closed_at IS NULL
  );

-- Clôture et avancement (bill_requested) : patron ou manager seulement.
DROP POLICY IF EXISTS "restaurant_orders_update" ON restaurant_orders;
CREATE POLICY "restaurant_orders_update" ON restaurant_orders
  FOR UPDATE
  USING (
    owner_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM business_members bm
      WHERE bm.owner_id = restaurant_orders.owner_id
        AND bm.member_id = auth.uid()
        AND bm.role IN ('owner', 'manager')
    )
  )
  WITH CHECK (
    owner_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM business_members bm
      WHERE bm.owner_id = restaurant_orders.owner_id
        AND bm.member_id = auth.uid()
        AND bm.role IN ('owner', 'manager')
    )
  );

-- Personne ne supprime une commande : elle s'annule en revenant au statut
-- ouvert ou se clôture. Une suppression laisserait une table occupée sans
-- commande, et le total du service disparaîtrait sans trace.
DROP POLICY IF EXISTS "restaurant_orders_no_delete" ON restaurant_orders;
CREATE POLICY "restaurant_orders_no_delete" ON restaurant_orders
  FOR DELETE USING (false);

DROP POLICY IF EXISTS "restaurant_order_items_read" ON restaurant_order_items;
CREATE POLICY "restaurant_order_items_read" ON restaurant_order_items
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM restaurant_orders ro
      WHERE ro.id = restaurant_order_items.order_id
        AND ro.owner_id = get_business_owner_id()
    )
  );

DROP POLICY IF EXISTS "restaurant_order_items_write" ON restaurant_order_items;
CREATE POLICY "restaurant_order_items_write" ON restaurant_order_items
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM restaurant_orders ro
      WHERE ro.id = restaurant_order_items.order_id
        AND ro.owner_id = get_business_owner_id()
        AND ro.status <> 'closed'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM restaurant_orders ro
      WHERE ro.id = restaurant_order_items.order_id
        AND ro.owner_id = get_business_owner_id()
        AND ro.status <> 'closed'
    )
  );

-- ─── 5. Vue de la salle ─────────────────────────────────────
-- Le plan de tables a besoin de l'état sans N requêtes : tables libres /
-- occupées / addition demandée, et le montant de la commande en cours.
-- WITH (security_invoker) dès la création et non par ALTER : sur une vue déjà
-- existante, un ALTER VIEW ... SET ne serait pas rejouable sans DROP.
CREATE OR REPLACE VIEW restaurant_floor
WITH (security_invoker = true)
AS
SELECT
  t.id,
  t.owner_id,
  t.name,
  t.zone,
  t.seats,
  t.is_active,
  o.id   AS order_id,
  o.status,
  o.customer_name,
  o.opened_at,
  o.amount_paid,
  COALESCE(
    (SELECT sum(i.quantity * i.unit_price) FROM restaurant_order_items i WHERE i.order_id = o.id),
    0
  ) AS order_total
FROM restaurant_tables t
LEFT JOIN restaurant_orders o
  ON o.table_id = t.id AND o.status <> 'closed';

COMMENT ON VIEW restaurant_floor IS
  'Plan des tables avec l''état de la commande en cours et son montant. '
  'security_invoker : les policies des tables sous-jacentes restent la seule '
  'source d''autorisation, une vue ne doit jamais les contourner.';

REVOKE ALL ON restaurant_floor FROM anon;
GRANT SELECT ON restaurant_floor TO authenticated, service_role;