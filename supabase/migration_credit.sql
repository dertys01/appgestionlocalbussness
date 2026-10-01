-- ============================================================
-- CRÉDIT CLIENT — le carnet de dette
-- À exécuter dans Supabase SQL Editor
--
-- LE PROBLÈME
--   « Je te dois 5 000, tu me paieras au prochain marché » représente une part
--   considérable du chiffre d'affaires d'une boutique de quartier. Aujourd'hui
--   create_sale() n'accepte que 'cash' et 'momo' : il n'y a aucune place pour une
--   dette, et le carnet papier reste la seule source de vérité. La caisse ne sait
--   rien de ce qu'elle a cédé, et ne peut pas le réclamer.
--
-- LE CHOIX COMPTABLE — RECETTE À L'ENCAISSEMENT
--   Une vente à crédit N'ENTRE PAS dans le chiffre d'affaires tant qu'elle n'est
--   pas réglée. C'est la solution prudente : un chiffre d'affaires gonflé par
--   des dettes qu'on ne recouvrera pas donne une fausse lecture de la santé du
--   commerce — et l'écran « Charges » calcule un résultat net à partir de ce
--   chiffre. Un commerçant qui accorde 200 000 F de crédit se verrait ruiner sur
--   le papier.
--
--   Conséquence assumée : les dettes apparaissent nulle part dans les rapports.
--   Elles ont leur propre écran, qui est le bon endroit pour les suivre.
--
--   Le STOCK, lui, part immédiatement. La marchandise quitte la boutique, et
--   Prévisions doit savoir qu'elle n'est plus là — sinon il recommandera de
--   commander du stock déjà cédé.
--
-- CE QUI DISTINGUE LE STOCK DE L'ARGENT
--   `sales.settled` sépare les deux : FALSE = les unités sont parties, l'argent
--   n'est pas rentré. Les rapports de CA et de marge filtrent sur settled = true ;
--   les quantités vendues comptent toutes, car c'est un fait physique.
--
-- ⚠ DEFAULT TRUE, et c'est volontaire : toutes les ventes existantes sont cash
--   ou MoMo, donc encaissées. Sans ce défaut, le changement de colonne ferait
--   disparaître tout l'historique du chiffre d'affaires.
-- ============================================================

-- ─── 1. Vente encaissée ou non ─────────────────────────────
ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS settled boolean NOT NULL DEFAULT true;

ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS client_phone text;

COMMENT ON COLUMN sales.settled IS
  'FALSE = vente à crédit : le stock est parti, l''argent n''est pas rentré. '
  'Les rapports de chiffre d''affaires et de marge ne comptent que settled = true. '
  'Défaut TRUE : les ventes cash et MoMo sont encaissées par nature.';

-- Un numéro de téléphone est l'identité réelle d'un client d'informel — le nom
-- change, « Maman Koffi » se mariera. La dette s'y rattache.
--
-- NOT VALID : la contrainte ne vérifie que les lignes neuves. Les ventes cash et
-- MoMo existantes ont settled = true, donc la colonne client_phone reste NULL
-- pour toutes — les valider retroactivement n'aurait aucun sens.
--
-- DROP préalable : une contrainte s'ajoute avec ALTER TABLE ADD CONSTRAINT, qui
-- n'a pas de IF NOT EXISTS. Sans ce DROP, la seconde exécution échoue en
-- 42710 et interrompt le script.
ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_credit_needs_phone;
ALTER TABLE sales ADD CONSTRAINT sales_credit_needs_phone
  CHECK (settled OR client_phone IS NOT NULL) NOT VALID;

-- Index partiel : seules les ventes à crédit portent un numéro, et c'est
-- ~10 % des lignes sur un commerce qui prête.
CREATE INDEX IF NOT EXISTS idx_sales_credit
  ON sales(user_id, created_at DESC) WHERE NOT settled;

CREATE INDEX IF NOT EXISTS idx_sales_settled
  ON sales(user_id, settled, created_at DESC);


-- ─── 2. Les dettes ─────────────────────────────────────────

-- Un numéro par boutique : deux fiches pour le même numéro scinderait la dette
-- en deux et le commerçant croirait avoir deux débiteurs.
CREATE TABLE IF NOT EXISTS customer_debts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  phone       text NOT NULL,
  name        text,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT customer_debts_phone_unique UNIQUE (user_id, phone),
  -- Le stock de chiffres suffit : la comparaison se fait sur la forme, pas sur
  -- le format. '+229 97 00 00 00' et '22997000000' désignent le même client.
  CONSTRAINT customer_debts_phone_digits CHECK (phone ~ '^[0-9]{8,15}$')
);

ALTER TABLE customer_debts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "debts_read" ON customer_debts;
CREATE POLICY "debts_read" ON customer_debts
  FOR SELECT USING (user_id = get_business_owner_id());

DROP POLICY IF EXISTS "debts_insert" ON customer_debts;
CREATE POLICY "debts_insert" ON customer_debts
  FOR INSERT WITH CHECK (can_manage_products() AND user_id = get_business_owner_id());

DROP POLICY IF EXISTS "debts_update" ON customer_debts;
CREATE POLICY "debts_update" ON customer_debts
  FOR UPDATE USING (can_manage_products())
  WITH CHECK (can_manage_products() AND user_id = get_business_owner_id());

DROP POLICY IF EXISTS "debts_delete" ON customer_debts;
CREATE POLICY "debts_delete" ON customer_debts
  FOR DELETE USING (can_manage_products());

CREATE INDEX IF NOT EXISTS idx_customer_debts_user ON customer_debts(user_id);

DROP TRIGGER IF EXISTS customer_debts_updated_at ON customer_debts;
CREATE TRIGGER customer_debts_updated_at
  BEFORE UPDATE ON customer_debts
  FOR EACH ROW EXECUTE FUNCTION update_org_timestamp();


-- ─── 3. Les versements ────────────────────────────────────
CREATE TABLE IF NOT EXISTS credit_payments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  debt_id    uuid NOT NULL REFERENCES customer_debts(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  amount     numeric(12,2) NOT NULL,
  day        date NOT NULL,
  method     text NOT NULL DEFAULT 'cash',
  note       text,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT credit_payments_amount_positive CHECK (amount > 0),
  CONSTRAINT credit_payments_method_valid   CHECK (method IN ('cash', 'momo'))
);

ALTER TABLE credit_payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "payments_read" ON credit_payments;
CREATE POLICY "payments_read" ON credit_payments
  FOR SELECT USING (user_id = get_business_owner_id());

DROP POLICY IF EXISTS "payments_insert" ON credit_payments;
CREATE POLICY "payments_insert" ON credit_payments
  FOR INSERT WITH CHECK (can_manage_products() AND user_id = get_business_owner_id());

-- Suppression interdite : effacer un versement ferait réapparaître une dette
-- déjà encaissée. On ne corrige que par un nouveau versement.
DROP POLICY IF EXISTS "payments_delete" ON credit_payments;
CREATE POLICY "payments_delete" ON credit_payments
  FOR DELETE USING (false);

CREATE INDEX IF NOT EXISTS idx_credit_payments_debt ON credit_payments(debt_id, day DESC);
CREATE INDEX IF NOT EXISTS idx_credit_payments_user ON credit_payments(user_id, day DESC);
