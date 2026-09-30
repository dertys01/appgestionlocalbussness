-- ============================================================================
--  GESTIONLOCAL — SCHÉMA COMPLET
--  À coller dans : Supabase Dashboard → SQL Editor → New query → Run
--
--  Les 15 migrations concaténées, dans l'ordre d'application. Ce
--  fichier est pratique pour partir d'une base vide ; sur une base existante,
--  préfère la migration concernée seule.
--
--  ⚠ Ordre obligatoire. migration_team.sql avant migration_saas.sql (la policy
--    « Employé lit l'org de son patron » référence business_members) ;
--    migration_profitability.sql après migration_sales_rpc.sql (create_sale()
--    écrit sale_items.unit_cost) ; migration_profitability_fix.sql après
--    migration_profitability.sql.
--
--  Rejouable : peut être exécuté plusieurs fois sans effet de bord.
-- ============================================================================


-- ============================================================
-- SCHEMA MVP AppGestionLocalBusiness
-- ============================================================

-- Extension UUID
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- TABLE : products
-- ============================================================
CREATE TABLE IF NOT EXISTS products (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  sku           TEXT,                        -- code-barres / référence
  price_buy     NUMERIC(12, 2) NOT NULL DEFAULT 0,
  price_sell    NUMERIC(12, 2) NOT NULL DEFAULT 0,
  stock_qty     INTEGER NOT NULL DEFAULT 0,
  min_stock_level INTEGER NOT NULL DEFAULT 5,
  category      TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- TABLE : sales
-- ============================================================
CREATE TABLE IF NOT EXISTS sales (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  total_amount  NUMERIC(12, 2) NOT NULL DEFAULT 0,
  payment_method TEXT NOT NULL DEFAULT 'cash',  -- 'cash' | 'momo'
  note          TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- TABLE : sale_items
-- ============================================================
CREATE TABLE IF NOT EXISTS sale_items (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sale_id       UUID NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id    UUID NOT NULL REFERENCES products(id),
  product_name  TEXT NOT NULL,               -- snapshot du nom au moment de la vente
  quantity      INTEGER NOT NULL,
  unit_price    NUMERIC(12, 2) NOT NULL,
  subtotal      NUMERIC(12, 2) NOT NULL
);

-- ============================================================
-- TABLE : stock_logs  (audit de tous les mouvements)
-- ============================================================
CREATE TABLE IF NOT EXISTS stock_logs (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  product_id    UUID NOT NULL REFERENCES products(id),
  product_name  TEXT NOT NULL,
  movement_type TEXT NOT NULL,               -- 'sale' | 'restock' | 'adjustment'
  quantity_change INTEGER NOT NULL,          -- négatif pour une vente
  stock_before  INTEGER NOT NULL,
  stock_after   INTEGER NOT NULL,
  reference_id  UUID,                        -- sale_id si movement_type = 'sale'
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE products   ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales      ENABLE ROW LEVEL SECURITY;
ALTER TABLE sale_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_logs ENABLE ROW LEVEL SECURITY;

-- products
DROP POLICY IF EXISTS "user_products" ON products;
CREATE POLICY "user_products" ON products
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- sales
DROP POLICY IF EXISTS "user_sales" ON sales;
CREATE POLICY "user_sales" ON sales
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- sale_items : accessible si la vente appartient à l'utilisateur
DROP POLICY IF EXISTS "user_sale_items" ON sale_items;
CREATE POLICY "user_sale_items" ON sale_items
  USING (
    EXISTS (SELECT 1 FROM sales WHERE sales.id = sale_items.sale_id AND sales.user_id = auth.uid())
  );

-- stock_logs
DROP POLICY IF EXISTS "user_stock_logs" ON stock_logs;
CREATE POLICY "user_stock_logs" ON stock_logs
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ============================================================
-- TRIGGER : met à jour updated_at sur products
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- DROP préalable : sans lui, la seconde exécution échoue en 42710
-- « trigger already exists » et interrompt le script en cours de route.
DROP TRIGGER IF EXISTS products_updated_at ON products;
CREATE TRIGGER products_updated_at
  BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- DONNÉES DE TEST (optionnel)
-- ============================================================
-- INSERT INTO products (user_id, name, sku, price_buy, price_sell, stock_qty, min_stock_level, category)
-- VALUES (auth.uid(), 'Samsung Galaxy A05', 'SM-A055F', 55000, 72000, 8, 3, 'smartphones');


-- ============================================================
-- MIGRATION : Équipe & Journal d'activité
-- ============================================================

-- Table membres de l'équipe
CREATE TABLE IF NOT EXISTS business_members (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  owner_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  member_id   UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  member_name TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'employee',
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(owner_id, member_id)
);

-- Journal d'activité
CREATE TABLE IF NOT EXISTS activity_logs (
  id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  business_owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  actor_id          UUID NOT NULL,
  actor_email       TEXT NOT NULL,
  actor_name        TEXT,
  action            TEXT NOT NULL,
  description       TEXT NOT NULL,
  metadata          JSONB,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

-- RLS
ALTER TABLE business_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_logs    ENABLE ROW LEVEL SECURITY;

-- business_members : le patron gère ses membres
DROP POLICY IF EXISTS "owner_manage_members" ON business_members;
CREATE POLICY "owner_manage_members" ON business_members
  USING (auth.uid() = owner_id)
  WITH CHECK (auth.uid() = owner_id);

-- business_members : chaque employé voit son propre lien
DROP POLICY IF EXISTS "member_view_own" ON business_members;
CREATE POLICY "member_view_own" ON business_members
  FOR SELECT USING (auth.uid() = member_id);

-- activity_logs : insert libre (actor = soi-même)
DROP POLICY IF EXISTS "activity_insert" ON activity_logs;
CREATE POLICY "activity_insert" ON activity_logs
  FOR INSERT WITH CHECK (auth.uid() = actor_id);

-- activity_logs : le patron et ses employés peuvent lire
DROP POLICY IF EXISTS "activity_read" ON activity_logs;
CREATE POLICY "activity_read" ON activity_logs
  FOR SELECT USING (
    auth.uid() = business_owner_id OR
    EXISTS (
      SELECT 1 FROM business_members
      WHERE owner_id = business_owner_id AND member_id = auth.uid()
    )
  );

-- Fonction : retourne le user_id du patron (pour employé → owner_id, pour patron → lui-même)
CREATE OR REPLACE FUNCTION get_business_owner_id()
RETURNS UUID AS $$
  SELECT COALESCE(
    (SELECT owner_id FROM business_members WHERE member_id = auth.uid() LIMIT 1),
    auth.uid()
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Mise à jour des politiques RLS existantes pour supporter les employés

DROP POLICY IF EXISTS "user_products" ON products;
DROP POLICY IF EXISTS "user_products" ON products;
CREATE POLICY "user_products" ON products
  USING (user_id = get_business_owner_id())
  WITH CHECK (user_id = get_business_owner_id());

DROP POLICY IF EXISTS "user_sales" ON sales;
DROP POLICY IF EXISTS "user_sales" ON sales;
CREATE POLICY "user_sales" ON sales
  USING (user_id = get_business_owner_id())
  WITH CHECK (user_id = get_business_owner_id());

DROP POLICY IF EXISTS "user_sale_items" ON sale_items;
DROP POLICY IF EXISTS "user_sale_items" ON sale_items;
CREATE POLICY "user_sale_items" ON sale_items
  USING (
    EXISTS (
      SELECT 1 FROM sales
      WHERE sales.id = sale_items.sale_id
        AND sales.user_id = get_business_owner_id()
    )
  );

DROP POLICY IF EXISTS "user_stock_logs" ON stock_logs;
DROP POLICY IF EXISTS "user_stock_logs" ON stock_logs;
CREATE POLICY "user_stock_logs" ON stock_logs
  USING (user_id = get_business_owner_id())
  WITH CHECK (user_id = get_business_owner_id());


-- ============================================================
-- MIGRATION SaaS — GestionLocal
-- A exécuter dans Supabase SQL Editor
-- ============================================================

-- ─── 1. TABLE ORGANIZATIONS ─────────────────────────────────
-- id = auth.uid() du patron (aucune migration de données requise :
-- les colonnes user_id existantes sont déjà l'org_id)
CREATE TABLE IF NOT EXISTS organizations (
  id          uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name        text NOT NULL,
  slug        text UNIQUE NOT NULL,
  logo_url    text,
  plan        text NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'starter', 'pro')),
  timezone    text NOT NULL DEFAULT 'Africa/Porto-Novo',
  currency    text NOT NULL DEFAULT 'XOF',
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);

-- Trigger updated_at
CREATE OR REPLACE FUNCTION update_org_timestamp()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS organizations_updated_at ON organizations;
CREATE TRIGGER organizations_updated_at
  BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION update_org_timestamp();

-- RLS
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Patron lit sa propre org" ON organizations;
CREATE POLICY "Patron lit sa propre org" ON organizations
  FOR SELECT USING (auth.uid() = id);

DROP POLICY IF EXISTS "Employé lit l'org de son patron" ON organizations;
CREATE POLICY "Employé lit l'org de son patron" ON organizations
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM business_members
      WHERE member_id = auth.uid() AND owner_id = organizations.id
    )
  );

DROP POLICY IF EXISTS "Patron modifie sa propre org" ON organizations;
CREATE POLICY "Patron modifie sa propre org" ON organizations
  FOR UPDATE USING (auth.uid() = id);

DROP POLICY IF EXISTS "Patron crée son org" ON organizations;
CREATE POLICY "Patron crée son org" ON organizations
  FOR INSERT WITH CHECK (auth.uid() = id);

-- ─── 2. TABLE SUBSCRIPTIONS ──────────────────────────────────
CREATE TABLE IF NOT EXISTS subscriptions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  stripe_customer_id       text UNIQUE,
  stripe_subscription_id   text UNIQUE,
  plan                     text NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'starter', 'pro')),
  status                   text NOT NULL DEFAULT 'active',
  current_period_end       timestamptz,
  created_at               timestamptz DEFAULT now(),
  updated_at               timestamptz DEFAULT now()
);

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Patron lit ses abonnements" ON subscriptions;
CREATE POLICY "Patron lit ses abonnements" ON subscriptions
  FOR SELECT USING (org_id = auth.uid());

-- Seul le service role peut écrire (via webhook Stripe)
DROP POLICY IF EXISTS "Service role gère les abonnements" ON subscriptions;
CREATE POLICY "Service role gère les abonnements" ON subscriptions
  FOR ALL USING (auth.role() = 'service_role');

-- ─── 3. ONBOARDING FLAG ─────────────────────────────────────
-- Ajouter une colonne onboarding_done à organizations (ALTER idempotent)
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS onboarding_done boolean DEFAULT false;

-- ─── 4. CRÉER UNE ORG POUR LES UTILISATEURS EXISTANTS ───────
-- (exécuter une seule fois — idempotent grâce à ON CONFLICT DO NOTHING)
INSERT INTO organizations (id, name, slug, plan, onboarding_done)
SELECT
  u.id,
  COALESCE(u.raw_user_meta_data->>'business_name', split_part(u.email, '@', 1)),
  lower(regexp_replace(
    COALESCE(u.raw_user_meta_data->>'business_name', split_part(u.email, '@', 1)),
    '[^a-z0-9]', '-', 'g'
  )) || '-' || left(u.id::text, 8),
  'free',
  true  -- utilisateurs existants = onboarding déjà fait
FROM auth.users u
WHERE NOT EXISTS (
  SELECT 1 FROM organizations WHERE id = u.id
);


-- ============================================================
-- MIGRATION PLAN LIMITS — GestionLocal
-- A exécuter dans Supabase SQL Editor
-- Enforce les limites de produits au niveau DB (inviolable)
-- ============================================================

CREATE OR REPLACE FUNCTION check_product_limit()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  org_plan text;
  product_count int;
  plan_limit int;
BEGIN
  SELECT plan INTO org_plan FROM organizations WHERE id = NEW.user_id;

  SELECT COUNT(*) INTO product_count
  FROM products WHERE user_id = NEW.user_id;

  plan_limit := CASE org_plan
    WHEN 'free'    THEN 30
    WHEN 'starter' THEN 200
    WHEN 'pro'     THEN 2147483647
    ELSE 30
  END;

  IF product_count >= plan_limit THEN
    RAISE EXCEPTION 'Limite de produits atteinte pour le plan % (max %). Passez à un plan supérieur.', org_plan, plan_limit;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_product_limit ON products;
CREATE TRIGGER enforce_product_limit
  BEFORE INSERT ON products
  FOR EACH ROW EXECUTE FUNCTION check_product_limit();


-- ============================================================
-- MIGRATION INVOICES — GestionLocal
-- A exécuter dans Supabase SQL Editor
-- ============================================================

-- Champs facturation dans organizations
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS ifu             text;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS address         text;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS invoice_counter integer NOT NULL DEFAULT 0;

-- Nom du client optionnel sur une vente (pour facture normalisée)
ALTER TABLE sales ADD COLUMN IF NOT EXISTS client_name text;


-- ============================================================
-- MIGRATION WEBHOOK LOGS — GestionLocal
-- A exécuter dans Supabase SQL Editor
-- Table pour tracer les événements Stripe reçus en prod
-- ============================================================

CREATE TABLE IF NOT EXISTS webhook_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id     text UNIQUE NOT NULL,
  event_type   text NOT NULL,
  org_id       text,
  status       text NOT NULL DEFAULT 'received',  -- received | processed | error
  error        text,
  received_at  timestamptz DEFAULT now()
);

ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;
-- Pas de lecture publique : accessible uniquement via service role key


-- ============================================================
-- MIGRATION INDEXES — GestionLocal
-- A exécuter dans Supabase SQL Editor
-- ============================================================

-- products
CREATE INDEX IF NOT EXISTS idx_products_user_id     ON products(user_id);
CREATE INDEX IF NOT EXISTS idx_products_name        ON products(name);
CREATE INDEX IF NOT EXISTS idx_products_category    ON products(category);

-- sales
CREATE INDEX IF NOT EXISTS idx_sales_user_id        ON sales(user_id);
CREATE INDEX IF NOT EXISTS idx_sales_created_at     ON sales(created_at DESC);

-- sale_items
CREATE INDEX IF NOT EXISTS idx_sale_items_sale_id   ON sale_items(sale_id);

-- stock_logs
CREATE INDEX IF NOT EXISTS idx_stock_logs_product_id ON stock_logs(product_id);

-- activity_logs
CREATE INDEX IF NOT EXISTS idx_activity_logs_owner_id   ON activity_logs(business_owner_id);
CREATE INDEX IF NOT EXISTS idx_activity_logs_created_at ON activity_logs(created_at DESC);


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


-- ============================================================
-- MIGRATION RÔLES & MULTI-TENANT — GestionLocal
-- À exécuter dans Supabase SQL Editor (après migration_team.sql)
--
-- Corrige trois failles d'autorisation :
--
--  1. Un employé héritait du tenant complet via get_business_owner_id() :
--     la policy "user_products" était un ALL, donc une caissière pouvait
--     `DELETE FROM products` ou `UPDATE products SET price_sell = 1`
--     depuis devtools, alors que l'UI annonce l'inverse
--     (OnboardingWizard : « ✗ Modifier les produits »).
--
--  2. `activity_logs.business_owner_id` n'était pas validé à l'insertion :
--     n'importe quel utilisateur authentifié pouvait forger une entrée
--     dans le journal d'une autre organisation.
--
--  3. Un employé pouvait se créer sa propre organisation
--     (INSERT organizations ... WITH CHECK (auth.uid() = id)) et donc
--     forker ses données hors du tenant de son patron.
-- ============================================================

-- ─── 1. search_path sur la fonction existante ───────────────
-- SECURITY DEFINER sans search_path figé : un objet créé dans un schema
-- contrôlé par un attaquant pourrait prendre le dessus.
-- CREATE OR REPLACE et non DROP/CREATE : les policies RLS de migration_team.sql
-- dépendent de cette fonction, un DROP serait refusé (« other objects depend
-- on it »). La signature est inchangée, les attributs sont modifiables ainsi.
CREATE OR REPLACE FUNCTION get_business_owner_id()
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT owner_id FROM business_members WHERE member_id = auth.uid() LIMIT 1),
    auth.uid()
  );
$$;

-- ─── 2. Un membre appartient à un seul business ──────────────
-- La contrainte UNIQUE(owner_id, member_id) autorisait un même compte dans
-- plusieurs organisations. SupabaseProvider résout l'appartenance avec un
-- maybeSingle() : au-delà d'une ligne, la requête échoue, l'erreur est
-- avalée par un catch{}, ownerId reste null et l'app affiche
-- « Configuration requise », avec un chemin qui crée une nouvelle organisation.
DO $$
DECLARE
  duplicated integer;
BEGIN
  SELECT count(*) INTO duplicated FROM (
    SELECT member_id FROM business_members
     GROUP BY member_id HAVING count(*) > 1
  ) AS d;

  IF duplicated > 0 THEN
    RAISE EXCEPTION
      'Migration annulée : % compte(s) appartiennent à plusieurs organisations. '
      'Supprimez les liens superflus de business_members puis relancez.',
      duplicated;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_business_members_member_id
  ON business_members(member_id);

-- ─── 3. Droits d'écriture sur le catalogue ──────────────────
-- Vrai si l'utilisateur est le patron du tenant résolu, ou un membre dont le
-- rôle est 'owner' ou 'manager' (porte de sortie pour étoffer le modèle).
CREATE OR REPLACE FUNCTION can_manage_products()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT get_business_owner_id() = auth.uid()
      OR EXISTS (
        SELECT 1 FROM business_members
         WHERE member_id = auth.uid()
           AND owner_id = get_business_owner_id()
           AND role IN ('owner', 'manager')
      );
$$;

-- Lecture : tout le tenant, comme avant.
--
-- "user_products" vient de migration_team.sql et est déclarée FOR ALL : la
-- laisser en place maintiendrait l'accès en écriture du séparé. C'est
-- imperatif, pas défensif — les policies RLS s'additionnent (OR), elles ne se
-- remplacent pas.
DROP POLICY IF EXISTS "user_products"  ON products;
DROP POLICY IF EXISTS "products_read"  ON products;
DROP POLICY IF EXISTS "products_read" ON products;
CREATE POLICY "products_read" ON products
  FOR SELECT USING (user_id = get_business_owner_id());

-- Écriture : patron / manager uniquement.
DROP POLICY IF EXISTS "products_insert" ON products;
DROP POLICY IF EXISTS "products_insert" ON products;
CREATE POLICY "products_insert" ON products
  FOR INSERT WITH CHECK (can_manage_products() AND user_id = get_business_owner_id());

DROP POLICY IF EXISTS "products_update" ON products;
DROP POLICY IF EXISTS "products_update" ON products;
CREATE POLICY "products_update" ON products
  FOR UPDATE USING (can_manage_products())
  WITH CHECK (can_manage_products() AND user_id = get_business_owner_id());

DROP POLICY IF EXISTS "products_delete" ON products;
DROP POLICY IF EXISTS "products_delete" ON products;
CREATE POLICY "products_delete" ON products
  FOR DELETE USING (can_manage_products());

-- ─── 4. Journal d'activité : le tenant est imposé par la base ─
DROP POLICY IF EXISTS "activity_insert" ON activity_logs;
DROP POLICY IF EXISTS "activity_insert" ON activity_logs;
CREATE POLICY "activity_insert" ON activity_logs
  FOR INSERT WITH CHECK (
    actor_id = auth.uid()
    AND business_owner_id = get_business_owner_id()
  );

-- ─── 5. Un employé ne peut pas créer sa propre organisation ─
DROP POLICY IF EXISTS "Patron crée son org" ON organizations;
DROP POLICY IF EXISTS "Patron crée son org" ON organizations;
CREATE POLICY "Patron crée son org" ON organizations
  FOR INSERT WITH CHECK (
    auth.uid() = id
    AND NOT EXISTS (SELECT 1 FROM business_members WHERE member_id = auth.uid())
  );


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


-- ============================================================
-- MIGRATION PRODUITS ARCHIVÉS + MARGE — GestionLocal
-- À exécuter dans Supabase SQL Editor, après migration_roles.sql
--
-- 1. Archivage : la suppression définitive d'un produit est impossible dès
--    qu'il a été vendu (sale_items.product_id et stock_logs.product_id
--    référencent products sans ON DELETE CASCADE). Le message d'erreur
--    proposait « désactivez-le », mais aucune colonne n'existait : le chemin
--    était un cul-de-sac. Un produit vendu était donc immortel.
--
-- 2. Coût au moment de la vente : la marge n'était calculable qu'en
--    recoupant le prix d'achat actuel par nom de produit — donc fausse dès
--    qu'un prix changeait. On fige le coût dans sale_items.
-- ============================================================

-- ─── 1. Archivage des produits ─────────────────────────────
ALTER TABLE products ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
ALTER TABLE products ADD COLUMN IF NOT EXISTS archived_at timestamptz;

-- Un produit ne peut être archivé que s'il n'a jamais été vendu : sinon on
-- perdrait la cohérence de l'historique.
CREATE OR REPLACE FUNCTION archive_product(p_product_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner  uuid := get_business_owner_id();
  v_sold   integer;
BEGIN
  IF NOT can_manage_products() THEN
    RAISE EXCEPTION 'Droits insuffisants' USING ERRCODE = '42501';
  END IF;

  SELECT count(*) INTO v_sold FROM sale_items WHERE product_id = p_product_id;
  IF v_sold > 0 THEN
    RAISE EXCEPTION 'Impossible d''archiver : ce produit apparaît dans % vente(s). '
      'Mettez son stock à 0 et renommez-le « % (épuisé) ».', v_sold,
      (SELECT name FROM products WHERE id = p_product_id)
      USING ERRCODE = '23503';
  END IF;

  UPDATE products
     SET is_active = false, archived_at = now()
   WHERE id = p_product_id AND user_id = v_owner;
END;
$$;

-- Restauration (l'UI d'archivage n'existe pas encore, mais la porte reste ouverte).
CREATE OR REPLACE FUNCTION restore_product(p_product_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := get_business_owner_id();
BEGIN
  IF NOT can_manage_products() THEN
    RAISE EXCEPTION 'Droits insuffisants' USING ERRCODE = '42501';
  END IF;

  UPDATE products
     SET is_active = true, archived_at = NULL
   WHERE id = p_product_id AND user_id = v_owner;
END;
$$;

REVOKE ALL ON FUNCTION archive_product(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION archive_product(uuid) TO authenticated;
REVOKE ALL ON FUNCTION restore_product(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION restore_product(uuid) TO authenticated;

-- ─── 2. Coût figé au moment de la vente ────────────────────
-- Sans ce snapshot, la marge d'hier se recalculait avec le prix d'achat
-- d'aujourd'hui : silencieusement fausse.
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS unit_cost numeric(12,2);
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS product_id_archived uuid;

-- Remplissage rétroactif des lignes existantes.
UPDATE sale_items si
   SET unit_cost = p.price_buy,
       product_id_archived = si.product_id
  FROM products p
 WHERE p.id = si.product_id AND si.unit_cost IS NULL;

-- Empêche de modifier un coût après coup (traçabilité comptable).
CREATE OR REPLACE FUNCTION freeze_sale_item_cost()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.unit_cost IS DISTINCT FROM NEW.unit_cost
     AND OLD.sale_id IS NOT NULL THEN
    RAISE EXCEPTION 'Le coût au moment de la vente est figé (produit %, vente %)',
      OLD.product_name, OLD.sale_id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS sale_items_freeze_cost ON sale_items;
CREATE TRIGGER sale_items_freeze_cost
  BEFORE UPDATE ON sale_items
  FOR EACH ROW EXECUTE FUNCTION freeze_sale_item_cost();

-- ─── 3. Rentabilité par produit ───────────────────────────
--
-- Fonction et non vue : une VUE PostgREST s'exécute avec les droits de son
-- propriétaire et contourne la RLS de products. Filtrer explicitement par
-- get_business_owner_id() serait le remède, mais cela casse dès qu'aucun
-- utilisateur n'est résolu (clé service role : auth.uid() est NULL, vue vide),
-- et oblige à dupliquer la règle de tenancy.
--
-- Une fonction SECURITY INVOKER s'exécute avec les droits de l'appelant :
-- PostgREST applique donc les policies RLS de products et de sale_items, qui
-- gèrent déjà l'isolation. Aucun filtre à maintenir ici.
CREATE OR REPLACE FUNCTION get_product_profitability()
RETURNS TABLE (
  id                 uuid,
  name               text,
  category           text,
  unit_cost          numeric(12,2),
  unit_price         numeric(12,2),
  stock_qty          integer,
  units_sold         bigint,
  revenue            numeric,
  cost_of_goods      numeric,
  gross_profit       numeric,
  margin_pct         numeric,
  -- Prix moyen réellement encaissé. Diffère de unit_price (catalogue courant)
  -- dès qu'une vente a été négociée : c'est ce prix-là qui a rapporté.
  avg_sold_price     numeric(12,2),
  -- Total concédé sur le produit, en FCFA.
  discount_given     numeric,
  -- Volume vendu sous le prix d'achat, en unités. Non nul = du stock écoulé
  -- à perte, ce qu'un commerçant doit voir sans que la vente soit bloquée.
  units_sold_at_loss bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    p.id,
    p.name,
    p.category,
    COALESCE(p.price_buy, 0)                     AS unit_cost,
    p.price_sell                                 AS unit_price,
    p.stock_qty,
    COALESCE(SUM(si.quantity), 0)                AS units_sold,
    COALESCE(SUM(si.subtotal), 0)                AS revenue,
    COALESCE(SUM(si.unit_cost * si.quantity), 0) AS cost_of_goods,
    COALESCE(SUM(si.subtotal - si.unit_cost * si.quantity), 0) AS gross_profit,
    CASE
      WHEN COALESCE(SUM(si.subtotal), 0) > 0
        THEN ROUND(
          100 * SUM(si.subtotal - si.unit_cost * si.quantity)
          / SUM(si.subtotal), 1)
      ELSE NULL
    END                                          AS margin_pct,
    CASE
      WHEN COALESCE(SUM(si.quantity), 0) > 0
        THEN ROUND(SUM(si.subtotal) / SUM(si.quantity), 2)
      ELSE NULL
    END                                          AS avg_sold_price,
    -- list_price est NULL sur les ventes antérieures au prix négocié : on
    -- traite l'absence comme « pas de remise » plutôt que de fausser l'écart.
    COALESCE(SUM(
      (COALESCE(si.list_price, si.unit_price) - si.unit_price) * si.quantity
    ), 0)                                        AS discount_given,
    COALESCE(SUM(si.quantity) FILTER (
      WHERE si.unit_cost IS NOT NULL AND si.unit_price < si.unit_cost
    ), 0)                                        AS units_sold_at_loss
  FROM products p
  LEFT JOIN sale_items si ON si.product_id = p.id
  -- Les produits archivés restent hors du tableau de bord : leur historique
  -- est conservé en base, ils ne sont plus pilotés.
  WHERE p.is_active
  GROUP BY p.id, p.name, p.category, p.price_buy, p.price_sell, p.stock_qty;
$$;

COMMENT ON FUNCTION get_product_profitability() IS
  'Rentabilité par produit. L''isolation repose sur la RLS de products (SECURITY INVOKER). '
  'sale_items.unit_cost, figé au moment de la vente, fait foi pour l''historique.';

REVOKE ALL ON FUNCTION get_product_profitability() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_product_profitability() TO authenticated;
GRANT EXECUTE ON FUNCTION get_product_profitability() TO service_role;


-- ============================================================
-- MIGRATION DÉPENSES — GestionLocal
-- À exécuter dans Supabase SQL Editor, après migration_profitability.sql
--
-- Le chiffre d'affaires ne prouve rien : 457 000 FCFA de CA peuvent
-- correspondre à un commerce déficitaire si le loyer, les salaires et
-- l'électricité ne sont pas saisis. Ce module enregistre les charges et
-- calcule le résultat net.
--
--   1. expense_categories — plan de comptes par organisation
--   2. expenses           — les charges
--   3. get_cash_flow()    — résultat par jour
--
-- Choix : le jour d'une dépense est calculé par le client et stocké en
-- `date`. Les ventes restent horodatées en timestamptz et sont ramenées au
-- jour via le fuseau de l'organisation. C'est le seul endroit où les deux
-- representations coexistent ; get_cash_flow() fait la conversion.
-- ============================================================

-- ─── 1. Plan de comptes ────────────────────────────────────
-- Par organisation, et non global : deux boutiques n'ont pas les mêmes
-- charges, et une catégorie partagée exposerait le nom des comptes de l'une
-- à l'autre via les policies.
CREATE TABLE IF NOT EXISTS expense_categories (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name       text NOT NULL,
  icon       text,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT expense_categories_org_name_key UNIQUE (user_id, name)
);

ALTER TABLE expense_categories ENABLE ROW LEVEL SECURITY;

-- Séparée par organisation : chaque boutique voit son seul plan de comptes.
DROP POLICY IF EXISTS "expense_categories_read" ON expense_categories;
DROP POLICY IF EXISTS "expense_categories_read" ON expense_categories;
CREATE POLICY "expense_categories_read" ON expense_categories
  FOR SELECT USING (user_id = get_business_owner_id());

DROP POLICY IF EXISTS "expense_categories_write" ON expense_categories;
DROP POLICY IF EXISTS "expense_categories_write" ON expense_categories;
CREATE POLICY "expense_categories_write" ON expense_categories
  FOR ALL USING (can_manage_products() AND user_id = get_business_owner_id())
  WITH CHECK (can_manage_products() AND user_id = get_business_owner_id());

-- Jeu de comptes par défaut, créé à la première visite du module.
--
-- Aucun paramètre : le tenant est résolu par get_business_owner_id(), comme
-- partout ailleurs. Une signature exposant p_owner permettrait à un client
-- d'appeler le seed pour l'organisation d'un autre.
--
-- ON CONFLICT DO NOTHING porte sur (user_id, name) : rejouer la migration
-- ou revenir dans l'application ne duplique rien.
CREATE OR REPLACE FUNCTION seed_expense_categories()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := get_business_owner_id();
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Non authentifié' USING ERRCODE = '28000';
  END IF;

  INSERT INTO expense_categories (user_id, name, icon, sort_order) VALUES
    (v_owner, 'Loyer',            'building', 10),
    (v_owner, 'Salaires',         'users',    20),
    (v_owner, 'Électricité',      'zap',      30),
    (v_owner, 'Eau',              'droplet',  40),
    (v_owner, 'Transport',        'truck',    50),
    (v_owner, 'Communication',    'wifi',     60),
    (v_owner, 'Fournitures',      'package',  70),
    (v_owner, 'Entretien',        'tool',     80),
    (v_owner, 'Impôts et taxes',  'receipt',  90),
    (v_owner, 'Crédit bancaire',  'credit-card', 100),
    (v_owner, 'Autre',            'dots',     999)
  ON CONFLICT (user_id, name) DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION seed_expense_categories() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION seed_expense_categories() TO authenticated;
GRANT EXECUTE ON FUNCTION seed_expense_categories() TO service_role;

-- ─── 2. Les dépenses ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS expenses (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  category   text NOT NULL,
  label      text NOT NULL,               -- ex : « Loyer janvier »
  amount     numeric(12,2) NOT NULL,
  day        date NOT NULL,               -- date locale de la boutique
  note       text,
  created_at timestamptz NOT NULL DEFAULT now(),

  -- Une charge négative fausserait le résultat net.
  CONSTRAINT expenses_amount_positive CHECK (amount > 0),
  CONSTRAINT expenses_label_not_blank CHECK (length(btrim(label)) > 0)
);

ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;

-- Lecture : tout le tenant, comme les ventes.
DROP POLICY IF EXISTS "expenses_read" ON expenses;
DROP POLICY IF EXISTS "expenses_read" ON expenses;
CREATE POLICY "expenses_read" ON expenses
  FOR SELECT USING (user_id = get_business_owner_id());

-- Écriture : patron / manager, même règle que le catalogue.
DROP POLICY IF EXISTS "expenses_insert" ON expenses;
DROP POLICY IF EXISTS "expenses_insert" ON expenses;
CREATE POLICY "expenses_insert" ON expenses
  FOR INSERT WITH CHECK (can_manage_products() AND user_id = get_business_owner_id());

DROP POLICY IF EXISTS "expenses_update" ON expenses;
DROP POLICY IF EXISTS "expenses_update" ON expenses;
CREATE POLICY "expenses_update" ON expenses
  FOR UPDATE USING (can_manage_products())
  WITH CHECK (can_manage_products() AND user_id = get_business_owner_id());

DROP POLICY IF EXISTS "expenses_delete" ON expenses;
DROP POLICY IF EXISTS "expenses_delete" ON expenses;
CREATE POLICY "expenses_delete" ON expenses
  FOR DELETE USING (can_manage_products());

CREATE INDEX IF NOT EXISTS idx_expenses_user_day     ON expenses(user_id, day DESC);
CREATE INDEX IF NOT EXISTS idx_expenses_user_category ON expenses(user_id, category);

-- ─── 3. Résultat journalier ────────────────────────────────
-- SECURITY INVOKER : l'isolation vient de la RLS de sales et expenses.
-- Aucune règle de tenancy dupliquée.
CREATE OR REPLACE FUNCTION get_cash_flow(p_from date, p_to date)
RETURNS TABLE (
  day          date,
  revenue      numeric,
  expenses     numeric,
  net          numeric,
  transactions bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH bounds AS (
    -- Fuseau de l'organisation, avec repli sur celui du pays si absent.
    SELECT COALESCE(
             (SELECT o.timezone FROM organizations o
               WHERE o.id = get_business_owner_id()),
             'Africa/Porto-Novo'
           ) AS tz
  ),
  sales_by_day AS (
    SELECT
      (s.created_at AT TIME ZONE (SELECT tz FROM bounds))::date AS d,
      SUM(s.total_amount) AS revenue,
      COUNT(*)           AS tx
    FROM sales s
    WHERE (s.created_at AT TIME ZONE (SELECT tz FROM bounds))::date
          BETWEEN p_from AND p_to
    GROUP BY 1
  ),
  expenses_by_day AS (
    SELECT x.day AS d, SUM(x.amount) AS spent
    FROM expenses x
    WHERE x.day BETWEEN p_from AND p_to
    GROUP BY 1
  )
  SELECT
    COALESCE(s.d, x.d)                                AS day,
    COALESCE(s.revenue, 0)                            AS revenue,
    COALESCE(x.spent, 0)                              AS expenses,
    COALESCE(s.revenue, 0) - COALESCE(x.spent, 0)     AS net,
    COALESCE(s.tx, 0)                                 AS transactions
  FROM sales_by_day s
  FULL OUTER JOIN expenses_by_day x ON s.d = x.d
  ORDER BY 1;
$$;

COMMENT ON FUNCTION get_cash_flow(date, date) IS
  'Résultat journalier : CA − charges. L''isolation vient de la RLS de sales '
  'et expenses (SECURITY INVOKER). Repli sur Africa/Porto-Novo si la timezone '
  'de l''organisation est absente.';

REVOKE ALL ON FUNCTION get_cash_flow(date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_cash_flow(date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION get_cash_flow(date, date) TO service_role;

-- ─── 4. Signature obsolète ─────────────────────────────────
-- La version initiale de cette migration exposait
-- seed_expense_categories(p_owner uuid). PostgREST ne la faisait pas
-- correspondre à un appel sans argument (« Could not find the function … without
-- parameters »). Elle est remplacée ci-dessus ; on retire l'ancienne pour ne
-- pas laisser deux fonctions au même nom.
DROP FUNCTION IF EXISTS seed_expense_categories(uuid);


-- ============================================================
-- MIGRATION INVITATIONS — GestionLocal
-- À exécuter dans Supabase SQL Editor, après migration_expenses.sql
--
-- L'ajout d'un employé demandait au patron d'inventer un mot de passe et de
-- le transmettre par un canal non chiffré (WhatsApp, papier). C'est le chemin
-- le plus probable pour qu'un accès client soit compromis, et cela suppose
-- aussi que le commerce possède déjà une boîte mail.
--
-- On remplace ceflux par une invitation :
--
--   1. Le patron saisit l'email, reçoit un lien à transmettre
--   2. L'employé ouvre le lien, choisit son propre mot de passe
--   3. redeem_invitation() lie le compte à la boutique, de façon atomique
--
-- Le jeton ne transite jamais par l'API en clair après la création : il est
-- stocké tel quel, comme un secret à usage unique. La table est par ailleurs
-- inaccessible au client (RLS + RLS du patron), donc seul le service_role la
-- lit.
-- ============================================================

-- ─── 1. Les invitations ────────────────────────────────────
CREATE TABLE IF NOT EXISTS employee_invitations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email       text NOT NULL,
  role        text NOT NULL DEFAULT 'employee' CHECK (role IN ('employee', 'manager')),
  token       text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  accepted_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT employee_invitations_email_lower CHECK (email = lower(btrim(email))),
  CONSTRAINT employee_invitations_token_len   CHECK (length(token) >= 32)
);

ALTER TABLE employee_invitations ENABLE ROW LEVEL SECURITY;

-- Le patron voit et gère ses invitations. Un employé n'en a pas : get_business_owner_id()
-- renverrait son patron, il pourrait donc lire les invitations de la boutique
-- et s'inviter lui-même. On vérifie explicitement qu'il est le patron.
DROP POLICY IF EXISTS "invitations_owner_read" ON employee_invitations;
DROP POLICY IF EXISTS "invitations_owner_read" ON employee_invitations;
CREATE POLICY "invitations_owner_read" ON employee_invitations
  FOR SELECT USING (auth.uid() = owner_id);

DROP POLICY IF EXISTS "invitations_owner_write" ON employee_invitations;
DROP POLICY IF EXISTS "invitations_owner_write" ON employee_invitations;
CREATE POLICY "invitations_owner_write" ON employee_invitations
  FOR ALL USING (auth.uid() = owner_id) WITH CHECK (auth.uid() = owner_id);

-- Index sur owner_id : le patron liste ses invitations à chaque affichage.
CREATE INDEX IF NOT EXISTS idx_employee_invitations_owner
  ON employee_invitations(owner_id, created_at DESC);

-- ─── 2. Remboursement atomique ──────────────────────────────
-- L'employé s'inscrit depuis un lien ; cette fonction consume l'invitation et
-- crée le lien de membre en une transaction. FOR UPDATE sérialise deux
-- usages simultanés du même lien : le second reçoit "déjà utilisée" au lieu de
-- créer un second membre.
--
-- SECURITY DEFINER est nécessaire : l'appelant n'est pas encore membre de la
-- équipe, donc la policy member_view_own ne lui accorde rien. La fonction
-- est révoquée au public et accordée au service_role, qui est le seul à
-- l'appeler (la route d'acceptation, via la clé service role).
CREATE OR REPLACE FUNCTION redeem_invitation(
  p_token       text,
  p_member_id   uuid,
  p_member_name text
)
RETURNS TABLE (owner_id uuid, email text, member_name text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inv employee_invitations%ROWTYPE;
BEGIN
  SELECT * INTO v_inv
    FROM employee_invitations
    WHERE token = p_token
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cette invitation est introuvable ou a été révoquée.'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_inv.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Cette invitation a déjà été utilisée.'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_inv.expires_at < now() THEN
    RAISE EXCEPTION 'Cette invitation a expiré. Demandez un nouveau lien à votre patron.'
      USING ERRCODE = 'P0002';
  END IF;

  -- L'email saisi doit être celui invité : sinon un lien peut être intercepté
  -- et réutilisé pour s'attribuer la boutique.
  -- La colonne est qualifiée : « email » seul serait ambigu entre auth.users et
  -- la table RETURNS (owner_id, email, member_name).
  IF NOT EXISTS (
    SELECT 1 FROM auth.users u
    WHERE u.id = p_member_id
      AND lower(btrim(u.email)) = v_inv.email
  ) THEN
    RAISE EXCEPTION 'Ce lien invite uniquement %', v_inv.email
      USING ERRCODE = 'P0002';
  END IF;

  IF length(btrim(p_member_name)) = 0 THEN
    RAISE EXCEPTION 'Le nom est obligatoire.' USING ERRCODE = '22023';
  END IF;

  INSERT INTO business_members (owner_id, member_id, member_name, role)
  SELECT v_inv.owner_id, p_member_id, btrim(p_member_name), v_inv.role
  WHERE NOT EXISTS (
    SELECT 1 FROM business_members x
    WHERE x.owner_id = v_inv.owner_id AND x.member_id = p_member_id
  );

  UPDATE employee_invitations ei SET accepted_at = now() WHERE ei.id = v_inv.id;

  RETURN QUERY SELECT v_inv.owner_id, v_inv.email, btrim(p_member_name);
END;
$$;

REVOKE ALL ON FUNCTION redeem_invitation(text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION redeem_invitation(text, uuid, text) TO service_role;

COMMENT ON FUNCTION redeem_invitation(text, uuid, text) IS
  'Consomme une invitation et lie le compte à la boutique. Vérifie que le compte '
  'correspond à l''email invité, refuse une invitation déjà utilisée ou expirée. '
  'Appelée uniquement par le service_role.';

COMMENT ON TABLE employee_invitations IS
  'Invitations d''équipe en attente. Le jeton est un secret à usage unique, '
  'expirant après 7 jours ; il est transmis au patron pour un envoi WhatsApp '
  'ou tout autre canal, jamais par email.';

-- ─── 3. Nettoyage ───────────────────────────────────────────
-- Les invitations acceptées ne servent plus à rien. Sans cette étape la table
-- grossit indéfiniment et conserve des emails d'employés partis.
-- Le token étant consommé et l'email de l'employé devenu inutile, la suppression est sans
-- risque : l'invitation n'a plus de valeur d'accès.
--
-- À appeler périodiquement (pg_cron côté Supabase, ou à la main) :
--
--   SELECT purge_accepted_invitations();
--
CREATE OR REPLACE FUNCTION purge_accepted_invitations(p_days int DEFAULT 7)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted bigint;
BEGIN
  DELETE FROM employee_invitations
    WHERE accepted_at IS NOT NULL
      AND accepted_at < now() - make_interval(days => p_days);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION purge_accepted_invitations(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_accepted_invitations(int) TO service_role;


-- ============================================================
-- CORRECTIF MARGE — create_sale() ne figeait pas le coût
-- À exécuter dans Supabase SQL Editor
--
-- SYMPTÔME
--   Rapports → Rentabilité affiche « coût des marchandises 0 F », une marge
--   brute égale au chiffre d'affaires, un taux de 100 % et un tiret « — »
--   dans la colonne % de chaque produit.
--
-- CAUSE
--   sale_items.unit_cost est à NULL sur toutes les ventes.
--
--   L'ordre d'application des migrations masque le problème :
--     · migration_sales_rpc.sql     définit create_sale()
--     · migration_profitability.sql AJOUTE la colonne unit_cost, remplit
--                                  l'existant, et pose un trigger qui interdit
--                                  de la modifier ensuite
--
--   La deuxième migration ne redéfinit pas create_sale(). Or la version de
--   create_sale() déployée à l'époque écrivait déjà invoice_number mais pas
--   encore unit_cost. Chaque vente depuis lors a donc inséré une ligne sans
--   coût — et le trigger de figeage a ensuite interdit toute correction, ce
--   qui est le comportement voulu pour une comptabilité mais masque ici un
--   déploiement incomplet.
--
--   Ce n'est pas une erreur de saisie : un produit sans prix d'achat donnerait
--   0, jamais NULL. Le NULL prouve que la colonne n'était pas fournie.
--
-- CORRECTIF — deux parties
--   1. Ce fichier : remplir unit_cost des lignes existantes, puis recréer le
--      trigger de figeage.
--   2. migration_sales_rpc.sql, à réappliquer juste après : il redéfinit
--      create_sale() pour qu'il fige désormais le coût.
--
-- ⚠ L'étape 1 utilise le prix d'achat d'AUJOURD'HUI, pas celui du jour de la
--   vente : le historique devient approximatif. Acceptable pour des ventes de
--   test du jour. Sur une boutique avec de l'antériorité, il faut ressaisir
--   les coûts historiques.
-- ============================================================

-- ─── 1. Remplissage des coûts manquants ───────────────────
-- Le trigger interdit toute modification d'un coût déjà figé ; il refuse donc
-- aussi le remplissage des lignes vides. On le retire, on remplit, on le recrée.

DROP TRIGGER IF EXISTS sale_items_freeze_cost ON sale_items;

UPDATE sale_items si
   SET unit_cost = p.price_buy,
       product_id_archived = COALESCE(si.product_id_archived, si.product_id)
  FROM products p
 WHERE p.id = si.product_id
   AND si.unit_cost IS NULL;

-- Un produit supprimé (archivé puis retiré du catalogue) ne laisse plus de
-- ligne à rejoindre : sa vente historique reste sans coût, donc comptée à
-- 100 % de marge. Le signaler vaut mieux qu'un zéro silencieux.
--
-- SELECT p.name, count(*) AS ventes_sans_cout
--   FROM sale_items si
--   LEFT JOIN products p ON p.id = si.product_id
--  WHERE si.unit_cost IS NULL
--  GROUP BY p.name;

DROP TRIGGER IF EXISTS sale_items_freeze_cost ON sale_items;
CREATE TRIGGER sale_items_freeze_cost
  BEFORE UPDATE ON sale_items
  FOR EACH ROW EXECUTE FUNCTION freeze_sale_item_cost();

-- ─── 2. create_sale() doit de nouveau figer le coût ───────
-- Réappliquez migration_sales_rpc.sql juste après ce fichier. Il est
-- idempotent (CREATE OR REPLACE partout) et redéfinit create_sale() avec
-- l'insertion de unit_cost qui manquait à la version déployée.
--
-- Vérification après coup :
--
--   SELECT count(*) FILTER (WHERE unit_cost IS NULL) AS sans_cout,
--          count(*) AS total
--     FROM sale_items;


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
DROP POLICY IF EXISTS "suppliers_read" ON suppliers;
CREATE POLICY "suppliers_read" ON suppliers
  FOR SELECT USING (user_id = get_business_owner_id());

-- Écriture : patron / manager, même règle que le catalogue produits.
DROP POLICY IF EXISTS "suppliers_insert" ON suppliers;
DROP POLICY IF EXISTS "suppliers_insert" ON suppliers;
CREATE POLICY "suppliers_insert" ON suppliers
  FOR INSERT WITH CHECK (can_manage_products() AND user_id = get_business_owner_id());

DROP POLICY IF EXISTS "suppliers_update" ON suppliers;
DROP POLICY IF EXISTS "suppliers_update" ON suppliers;
CREATE POLICY "suppliers_update" ON suppliers
  FOR UPDATE USING (can_manage_products())
  WITH CHECK (can_manage_products() AND user_id = get_business_owner_id());

DROP POLICY IF EXISTS "suppliers_delete" ON suppliers;
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
