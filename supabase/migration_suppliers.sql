-- ============================================================
-- MIGRATION FOURNISSEURS — GestionLocal
-- À exécuter dans Supabase SQL Editor, après migration_profitability_fix.sql
--
-- Où s'en fournisseurs trouve-t-il sa valeur, dans un marché où l'informel
-- domine ? Trois usages concrets, par ordre d'importance :
--
--   1. Retrouver le prix. Un commerçant qui achète à un grossiste de Cokhan
--      veut savoir où il s'est fourni le mois dernier et à quel prix. Sans
--      fournisseur, products.price_buy est écrasé à chaque nouveau prix et
--      l'historique d'achat disparaît.
--
--   2. Savoir qui appeler quand un stock baisse. Prévisions → rupture
--      indique « commander », mais pas « auprès de qui ».
--
--   3. Évaluer la dépendance. Un commerce dont 80 % du chiffre d'affaires
--      vient d'un seul fournisseur est en danger ; l'application ne peut pas
--      le dire aujourd'hui.
--
-- ⚠ Ce que ce n'est PAS : ni un registre de conformité MECeF/DGI, ni une
--   comptabilité fournisseurs. Aucun montant d'achat, aucune échéance, aucun
--   règlement n'est enregistré ici. Pour l'informel, le relevé de prix et le
--   carnet suffisent ; une facture normalisée reste le vrai chantier, et il
--   est traité séparément.
--
-- Choix : un fournisseur par produit, et non une table de liaison.
-- Un article a un fournisseur principal ; le prix d'achat est unique dans
-- products. Une table de liaison supposerait plusieurs prix d'achat
-- simultanés, que le modèle ne sait pas représenter. Si un jour un même
-- article arrive à deux prix selon le fournisseur, c'est deux articles.
-- ============================================================

-- ─── 1. Les fournisseurs ──────────────────────────────────
CREATE TABLE IF NOT EXISTS suppliers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name        text NOT NULL,
  phone       text,
  address     text,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  -- Un fournisseur porte un nom : « Adresse email invalide » dans ce champ
  -- déplacerait la faute vers une donnée de contact.
  CONSTRAINT suppliers_name_not_blank CHECK (length(btrim(name)) > 0)
);

ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;

-- Par organisation, comme le plan de comptes des charges. Deux boutiques
-- n'ont pas les mêmes grossistes, et un catalogue partagé exposerait l'un à
-- l'autre via les policies.
DROP POLICY IF EXISTS "suppliers_read" ON suppliers;
CREATE POLICY "suppliers_read" ON suppliers
  FOR SELECT USING (user_id = get_business_owner_id());

-- Écriture : patron / manager, même règle que le catalogue produits.
DROP POLICY IF EXISTS "suppliers_insert" ON suppliers;
CREATE POLICY "suppliers_insert" ON suppliers
  FOR INSERT WITH CHECK (can_manage_products() AND user_id = get_business_owner_id());

DROP POLICY IF EXISTS "suppliers_update" ON suppliers;
CREATE POLICY "suppliers_update" ON suppliers
  FOR UPDATE USING (can_manage_products())
  WITH CHECK (can_manage_products() AND user_id = get_business_owner_id());

DROP POLICY IF EXISTS "suppliers_delete" ON suppliers;
CREATE POLICY "suppliers_delete" ON suppliers
  FOR DELETE USING (can_manage_products());

CREATE INDEX IF NOT EXISTS idx_suppliers_user_name ON suppliers(user_id, name);

-- La liste des fournisseurs est affichée par ordre alphabétique à chaque
-- ouverture du formulaire produit : l'index couvre ce tri.
-- DROP avant CREATE : sans lui, la seconde exécution échoue en 42710
-- « trigger already exists », ce qui interromp le script en cours de route.
DROP TRIGGER IF EXISTS suppliers_updated_at ON suppliers;
CREATE TRIGGER suppliers_updated_at
  BEFORE UPDATE ON suppliers
  FOR EACH ROW EXECUTE FUNCTION update_org_timestamp();


-- ─── 2. Rattachement du produit ────────────────────────────
-- ON DELETE SET NULL, et non CASCADE : supprimer un fournisseur ne doit pas
-- supprimer les articles qui en dépendent. Le produit perd son fournisseur et
-- garde son prix d'achat, son stock et son historique de ventes.
--
-- C'est le même arbitrage que l'archivage produit : dans un commerce réel,
-- on ne supprime pas un fournisseur, on l'oublie. La suppression reste
-- possible depuis l'écran Fournisseurs, avec confirmation explicite.
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS supplier_id uuid REFERENCES suppliers(id) ON DELETE SET NULL;

-- Index partiel : seuls les articles rattachés sont indexés, ce qui reste
-- négligeable sur un catalogue de quelques milliers.
CREATE INDEX IF NOT EXISTS idx_products_supplier
  ON products(supplier_id) WHERE supplier_id IS NOT NULL;


-- ─── 3. Un fournisseur ne peut pas être volé d'une autre boutique ─
-- La RLS de products vérifie user_id = get_business_owner_id() : elle protège
-- le PRODUIT, jamais le fournisseur auquel il est rattaché. Un patron pouvait
-- donc écrire l'identifiant d'un fournisseur d'une autre boutique dans sa
-- colonne supplier_id — la contrainte de clé étrangère l'accepte, puisque
-- l'identifiant existe bien.
--
-- Ce n'est pas une question de propreté : la vue products_with_supplier fait
-- un LEFT JOIN, et la jointure rattacherait alors ce fournisseur à l'écran. La
-- RLS de suppliers masque le nom (ligne invisible, valeur NULL), mais le
-- principe d'isolation est rompu et l'UUID se devine par force brute.
--
-- Une contrainte CHECK ne peut pas consulter une autre table ; seul un trigger
-- le peut. SECURITY DEFINER parce que l'appelant n'a pas à lire suppliers.
CREATE OR REPLACE FUNCTION check_product_supplier_tenant()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.supplier_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM suppliers s
        WHERE s.id = NEW.supplier_id
          AND s.user_id = NEW.user_id
     ) THEN
    RAISE EXCEPTION 'Ce fournisseur n''appartient pas à votre boutique'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION check_product_supplier_tenant() FROM PUBLIC;

DROP TRIGGER IF EXISTS products_supplier_same_tenant ON products;
CREATE TRIGGER products_supplier_same_tenant
  BEFORE INSERT OR UPDATE OF supplier_id ON products
  FOR EACH ROW EXECUTE FUNCTION check_product_supplier_tenant();


-- ─── 4. Vue : articles et fournisseur d'un coup ───────────
-- Évite au formulaire produit deux requêtes et un raccordement manuel. Les
-- produits sans fournisseur sont conservés (LEFT JOIN) : ils sont la majorité
-- au démarrage, et les filtrer les ferait disparaître.
--
-- SECURITY INVOKER : l'isolation vient de la RLS de products et suppliers.
-- Une vue en SECURITY DEFINER contournerait les policies et exposerait le
-- catalogue d'un autre tenant — c'est précisément ce qu'on a déjà corrigé
-- pour la rentabilité.
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
LEFT JOIN suppliers s ON s.id = p.supplier_id;

COMMENT ON VIEW products_with_supplier IS
  'Catalogue avec le fournisseur principal. Les produits sans fournisseur sont '
  'conservés. security_invoker : l''isolation vient de la RLS de products et '
  'suppliers, pas d''une vue qui la contournerait.';

REVOKE ALL ON products_with_supplier FROM PUBLIC;
GRANT SELECT ON products_with_supplier TO authenticated;
GRANT SELECT ON products_with_supplier TO service_role;


-- ─── 5. Diagnostic ────────────────────────────────────────
-- Vérifier que le trigger a bien été créé une seule fois :
--
--   SELECT count(*) AS triggers
--     FROM pg_trigger WHERE tgname = 'suppliers_updated_at';
