-- ============================================================================
--  GESTIONLOCAL — SCHÉMA COMPLET
--  À coller dans : Supabase Dashboard → SQL Editor → New query → Run
--
--  Les 22 migrations concaténées, dans l'ordre d'application. Ce
--  fichier est pratique pour partir d'une base vide ; sur une base existante,
--  préfère la migration concernée seule.
--
--  ⚠ Ordre obligatoire. migration_team.sql avant migration_saas.sql (la policy
--    « Employé lit l'org de son patron » référence business_members) ;
--    migration_profitability.sql après migration_sales_rpc.sql (create_sale()
--    écrit sale_items.unit_cost) ; migration_profitability_fix.sql après
--    migration_profitability.sql.
--    migration_security.sql DOIT fermer la série : elle pose le verrou de
--    organizations.plan, le RLS de rate_limits, l'index unique de
--    subscriptions et les policies de business_members. Placée avant, elle
--    serait annulée par les migrations suivantes.
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
-- rattachée à sa vente.
ALTER TABLE sales ADD COLUMN IF NOT EXISTS invoice_number text;

-- ⚠ L'unicité est PAR BOUTIQUE, pas globale.
--
-- Le compteur (organizations.invoice_counter) appartient à une boutique, mais
-- l'index portait sur la seule colonne invoice_number : les deux premières
-- boutiques Pro de la plateforme produisaient toutes deux « FAC-2026-00001 », et
-- la seconde se faisait refuser sa vente. Sa caisse était morte — le défaut le
-- plus grave possible chez un client payant. Reproduit avant correction : la
-- boutique B ne pouvait plus encaisser.
--
-- Ce n'est pas seulement un choix technique : la numérotation des factures est
-- une séquence par contribuable, pas par pays. Deux commerces différents ont
-- chacun leur première facture au numéro 1, et c'est légal. L'unicité globale
-- n'avait aucun sens.
--
-- Le DROP est nécessaire : CREATE UNIQUE INDEX IF NOT EXISTS ne remplace pas
-- un index déjà présent, il en laisse un autre — la correction ne s'appliquerait
-- jamais sur une base existante.
DROP INDEX IF EXISTS idx_sales_invoice_number;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_invoice_number
  ON sales(user_id, invoice_number) WHERE invoice_number IS NOT NULL;

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
-- VERROU DE PLAN CÔTÉ SERVEUR
-- À exécuter dans Supabase SQL Editor
--
-- LE TROU
--   Les écrans Rapports, Prévisions et Dettes sont verrouillés par un test de
--   plan dans le navigateur : le menu affiche un cadenas, et un client en plan
--   gratuit est redirigé vers Paramètres. C'est vrai, et c'est sans valeur.
--
--   Le verrou est côté client, donc contournable en une ligne depuis la console
--   du navigateur :
--
--     supabase.rpc('get_product_profitability')
--
--   La clé anon est publique — elle est dans le bundle JS, que le navigateur
--   télécharge. Un concurrent, un-client, ou un Stall qui veut voir la marge de
--   la boutique d'à côté n'a rien à faire de plus. Il n'est même pas nécessaire
--   d'être connecté : il suffit d'être le propriétaire de sa boutique, ce que
--   l'inscription en plan gratuit donne en trente secondes. La RLS isole les
--   boutiques entre elles, donc il ne verra que SES chiffres — mais il verra
--   tous les chiffres payants, gratuitement.
--
-- CE QUE CELA FAIT PERDRE
--   Le plan Starter vend 3 000 FCFA/mois, le Pro 9 000. Si les rapports sont
--   accessibles à tous, personne n'a de raison de payer : c'est le produit
--   entier qui devient gratuit. Le cadenas dans le menu continuait de dire le
--   contraire.
--
-- LE PRINCIPE
--   Une règle de monétisation ne peut pas vivre dans le navigateur. Le plan est
--   relu en base, à chaque appel, et l'appel est refusé si le plan ne suit pas.
--   Le client ne fait que refléter la décision — il n'est plus l'arbitre.
--
-- ⚠ Ce n'est PAS une sécurité de confidentialité : la RLS s'en charge, et elle
--   fonctionne. C'est une règle commerciale, et c'est précisément le genre de
--   règle qu'un client contourne sans le vouloir, en gardant un onglet ouvert
--   d'un essai terminé. Le contrôle doit être là où la décision se prend.
--
-- CE QUI N'EST PAS VERROUILLÉ, ET POURQUOI
--   La caisse, le stock, les ventes, l'équipe, les invitations, les dettes.
--   Un client doit pouvoir VENDRE : c'est l'application. Verrouiller la
--   vente décourage, il faut donc laisser passer tout ce qui fait tourner le
--   commerce, et ne verrouiller que ce qui est un avantage payant.
--
-- DEUX COUCHES, VOLONTAIREMENT : le plan et les limites restent aussi dans le
--   client (PLAN_LIMITS), pour afficher des cadenas et des messages sans
--   aller-retour réseau. Cette migration ne le remplace pas, elle le renforce :
--   si les deux divergent un jour, c'est la base qui tranche.
-- ============================================================

-- ─── 1. Lire le plan de la boutique ────────────────────────
-- La source de vérité est organizations.plan, déjà utilisée par le trigger de
-- limite de produits : le contrôle de plan ne peut pas utiliser une autre
-- colonne, sinon les deux se désynchronisent.
--
-- COALESCE sur 'free' : une organisation sans plan est traitée comme gratuit.
-- Le doute doit coûter cher au vendeur, jamais au client.
CREATE OR REPLACE FUNCTION current_org_plan()
RETURNS text
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT o.plan FROM organizations o WHERE o.id = get_business_owner_id()),
    'free'
  );
$$;

REVOKE ALL ON FUNCTION current_org_plan() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION current_org_plan() TO authenticated;
GRANT EXECUTE ON FUNCTION current_org_plan() TO service_role;

COMMENT ON FUNCTION current_org_plan() IS
  'Plan de la boutique appelante. Défaut « free » : en cas de doute, un client '
  'est traité comme gratuit. SECURITY INVOKER, la RLS de organizations suffit.';


-- ─── 2. Exiger une fonctionnalité ──────────────────────────
-- Lève une exception si le plan ne permet pas p_feature. Le message est en
-- français et nomme le plan à prendre : c'est ce que le client affiche quand
-- l'appel échoue, et un message technique serait incompréhensible pour un
-- commerçant.
--
-- VOLATILE, et c'est délibéré : la fonction lève une exception, donc elle n'est
-- pas « pure ». Une fonction STABLE serait susceptible d'être évaluée une seule
-- fois par le planificateur, ou écartée s'il juge le résultat inutilisable —
-- deux façons discrètes de laisser passer un client en plan gratuit.
--
-- SECURITY INVOKER : elle ne fait que lire organizations, dont la RLS renvoie
-- la ligne de l'appelant. Rien à contourner.
CREATE OR REPLACE FUNCTION require_feature(p_feature text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_plan    text;
  v_requis  text;
  v_rang_plan   int;
  v_rang_requis int;
BEGIN
  -- Les mêmes quotas que PLAN_LIMITS côté client. Les tenir à jour à deux
  -- endroits est un risque assumé : c'est la base qui tranche, donc un oubli
  -- côté client ne donne accès à rien.
  v_requis := CASE p_feature
    WHEN 'reports'   THEN 'starter'   -- rentabilité, charges, dettes
    WHEN 'forecast'  THEN 'pro'       -- prévisions de réapprovisionnement
    WHEN 'exportCsv' THEN 'starter'
    ELSE NULL
  END;

  -- Fonctionnalité inconnue : on refuse. Une faute de frappe dans le nom ne
  -- doit pas se traduire par un accès accordé.
  IF v_requis IS NULL THEN
    RAISE EXCEPTION 'Fonctionnalité inconnue : %', p_feature USING ERRCODE = '22023';
  END IF;

  -- CONTEXTE SANS UTILISATEUR = CONFIANCE, PAS PLAN GRATUIT.
  --
  -- Aucun utilisateur résolu ne signifie pas un client gratuit : cela veut dire
  -- clé service_role, script d'administration, migration, ETL. Ces contextes
  -- sont déjà de confiance maximale — ils ont tous les droits sur toutes les
  -- boutiques — donc les bloquer au motif du plan n'aurait aucun sens.
  --
  -- Ce n'est pas une brèche : le rôle anon n'a aucun droit d'exécution sur ces
  -- fonctions (les GRANT vont à authenticated et service_role), et un appel
  -- authentifié a toujours un claim `sub`. Seuls service_role et les scripts
  -- arrivent ici avec un propriétaire NULL.
  IF get_business_owner_id() IS NULL THEN
    RETURN true;
  END IF;

  v_plan := current_org_plan();

  -- Comparaison par rang plutôt que par liste : ajouter un plan plus tard ne
  -- demande pas de réécrire les conditions. Les rangs sont mis dans des
  -- variables car un CASE nu comme opérande de comparaison n'est pas accepté
  -- par le parseur PL/pgSQL — il s'arrête sur « syntax error at end of input »,
  -- sans nommer la ligne fautive.
  v_rang_plan := CASE v_plan
    WHEN 'pro'     THEN 3
    WHEN 'starter' THEN 2
    ELSE 1
  END;

  v_rang_requis := CASE v_requis
    WHEN 'pro'     THEN 3
    WHEN 'starter' THEN 2
    ELSE 1
  END;

  IF v_rang_plan < v_rang_requis THEN
    RAISE EXCEPTION
      'La fonctionnalité « % » nécessite le plan % (plan actuel : %).',
      p_feature, v_requis, v_plan
      USING ERRCODE = '42501';
  END IF;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION require_feature(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION require_feature(text) TO authenticated;
GRANT EXECUTE ON FUNCTION require_feature(text) TO service_role;

COMMENT ON FUNCTION require_feature(text) IS
  'Lève une exception si le plan de la boutique ne permet pas la fonctionnalité. '
  'À appeler dans les fonctions payantes : le contrôle de plan ne peut pas '
  'vivre dans le navigateur, où un simple appel RPC le contourne.';


-- ─── 3. Les quantités vendues, pour les Prévisions ────────
-- Nouvelle fonction, et pas un simple verrou sur la requête existante : le
-- module Prévisions lisait sale_items ligne à ligne pour compter lui-même les
-- quantités vendues. Il ramenait donc TOUTES les lignes de vente de la période
-- dans le navigateur d'un client en plan gratuit — le chiffre d'affaires, jour
-- par jour, produit par produit. Un verrou posé sur l'écran n'aurait protégé
-- que l'affichage ; il fallait protéger les données.
--
-- La fonction retourne le même agrégat, calculé en base. Un client gratuit
-- reçoit une erreur, pas le chiffre d'affaires des trois derniers mois.
--
-- SECURITY INVOKER : l'isolation vient de la RLS de sale_items et sales. Le
-- contrôle de plan est ajouté, ce qui est une autre question.
DROP FUNCTION IF EXISTS get_units_sold_since(integer);
CREATE FUNCTION get_units_sold_since(p_days integer DEFAULT 30)
RETURNS TABLE (
  product_id uuid,
  quantity   numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  -- Le garde s'exécute avant l'agrégat : un client sans le plan ne voit pas
  -- les quantités, même agrégées. `true` pour laisser passer la ligne, et
  -- l'exception est levée par require_feature() si le plan ne suffit pas.
  SELECT si.product_id, SUM(si.quantity)
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
   WHERE (SELECT true FROM require_feature('forecast'))
     -- Borne basse : un nombre négatif ou absurde ne doit pas transformer la
     -- requête en plein scan de l'historique du client.
     AND p_days BETWEEN 1 AND 3650
     AND s.created_at >= now() - make_interval(days => p_days)
   GROUP BY si.product_id;
$$;

REVOKE ALL ON FUNCTION get_units_sold_since(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_units_sold_since(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION get_units_sold_since(integer) TO service_role;

COMMENT ON FUNCTION get_units_sold_since(integer) IS
  'Quantités vendues par produit sur les N derniers jours, agrégées en base. '
  'Remplace la lecture ligne à ligne de sale_items : le client ne reçoit plus '
  'l''historique complet. Exige le plan pro (fonctionnalité forecast).';


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


-- ============================================================
-- ACOMPTE — le client paie une partie, reste devoir l'autre
-- À exécuter dans Supabase SQL Editor
--
-- LE MANQUE
--   « Laisse-moi 50 000 sur 130 000, je passe demain » est le geste le plus
--   courant d'une boutique de quartier — plus courant que le crédit total. Or le
--   choix « Crédit » signifiait 100 % à découvert : impossible d'enregistrer un
--   acompte. Le commerçant devait soit tout encaisser (et inventer un montant),
--   soit tout laisser à découvert (et laisser le client avec plus de dette que
--   ce qu'il doit). Aucune des deux ne décrit la réalité.
--
-- LA RÈGLE
--   Une seule colonne decide de tout : sales.amount_received, ce qui est
--   RÉELLEMENT rentré. Le chiffre d'affaires vaut SUM(amount_received), point.
--   Il n'existe plus aucun filtre « vente encaissée ou non » dans les rapports :
--   un rapport en base de caisse n'a pas besoin de savoir si une vente est
--   soldée, seulement ce qu'elle a rapporté.
--
--   Pour une vente espèces ou MoMo, amount_received = total_amount : le client
--   a payé, la monnaie a été rendue, le net encaissé est bien le prix. Pour un
--   crédit sans acompte, 0. Pour un crédit avec acompte, l'acompte.
--
--   La dette d'un client devient alors triviale et juste par construction :
--
--     reste dû = SUM(total_amount - amount_received) sur ses ventes non soldées
--
--   C'est vrai par définition, sans soustraire un journal de versements dont la
--   répartition sur les ventes n'était pas tracée. Les versements restent
--   enregistré dans credit_payments — c'est l'historique, la date, le moyen de
--   paiement — mais plus l'état de la dette.
--
-- ⚠ DEFAULT 0 puis remplissage : la colonne ne doit pas valoir total_amount par
--   défaut, sinon la recette à l'encaissement disparaît d'un coup. Le remplissage
--   est fait juste après, vente par vente, FIFO compris.
-- ============================================================

ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS amount_received numeric(12,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN sales.amount_received IS
  'Ce qui est réellement rentré pour cette vente. Le chiffre d''affaires vaut '
  'SUM(amount_received) sur la periode : c''est de la base de caisse, donc la '
  'caisse et le chiffre d''affaires ne peuvent pas diverger. Égal à '
  'total_amount pour une vente espèces ou MoMo. Pour un crédit, l''acompte puis '
  'les versements, dans cet ordre.';


-- ─── Remplissage des ventes déjà enregistrées ──────────────
-- Le cas n'est pas théorique : une boutique en essai a déjà des ventes. Sans
-- remplissage, une vente espèces ancienne vaudrait 0 encaissé et disparaîtrait
-- du chiffre d'affaires.
--
-- Les ventes cash et MoMo sont intégralement encaissées par nature : c'est
-- exact, pas une approximation. Les ventes à crédit soldées l'étaient par le
-- FIFO de migration_credit_fns.sql : leur montant a été couvert.
--
-- Les ventes à crédit ouvertes sont plus délicates : des versements ont pu être
-- enregistrés pour ce client sans que leur répartition sur ses ventes ait été
-- tracée — l'ancienne version de pay_customer_debt() déduisait la dette d'un
-- cumul, sans garder la trace de ce qui couvrait quoi. On reconstitue donc la
-- répartition en FIFO, avec exactement la même règle que la fonction. C'est la
-- seule écriture compatible : sinon le solde affiché au commerçant changerait du
-- jour au lendemain, le pire moment pour perdre sa confiance.
--
-- ⚠ La boucle porte sur un client, puis sur ses ventes. L'inverse n'est pas
--   possible : référencer v_sale dans la requête qui remplit le curseur v_sale
--   est interdit — « record v_sale is not assigned yet ». Deux boucles
--   imbriquées, parce qu'il faut un reliquat par client.
DO $$
DECLARE
  v_client  record;
  v_sale    record;
  v_restant numeric(12,2);
  v_montant numeric(12,2);
BEGIN
  -- Ventes cash et MoMo : intégralement encaissées.
  UPDATE sales
     SET amount_received = total_amount
   WHERE payment_method IN ('cash', 'momo');

  -- Ventes à crédit déjà soldées : couvertes.
  UPDATE sales
     SET amount_received = total_amount
   WHERE payment_method = 'credit' AND settled;

  -- Ventes à crédit ouvertes : on redistribue les versements, client par client.
  --
  -- Le test sur credit_payments évite un plantage sur une base neuve, où la
  -- table n'existe pas encore et où il n'y a de toute façon rien à
  -- redistribuer.
  IF to_regclass('public.credit_payments') IS NULL THEN
    RETURN;
  END IF;

  FOR v_client IN
    SELECT DISTINCT user_id, client_phone
      FROM sales
     WHERE payment_method = 'credit'
       AND NOT settled
       AND client_phone IS NOT NULL
  LOOP
    -- Tout ce que ce client a versé, tous droits confondus.
    v_restant := COALESCE(
      (SELECT SUM(cp.amount)
         FROM credit_payments cp
         JOIN customer_debts d ON d.id = cp.debt_id
        WHERE d.user_id = v_client.user_id
          AND d.phone = v_client.client_phone), 0);

    FOR v_sale IN
      SELECT s.id, s.total_amount
        FROM sales s
       WHERE s.user_id = v_client.user_id
         AND s.client_phone = v_client.client_phone
         AND NOT s.settled
       ORDER BY s.created_at ASC
    LOOP
      EXIT WHEN v_restant <= 0;

      v_montant := LEAST(v_restant, v_sale.total_amount);

      -- On ne marque pas settled ici. Le soldage est le travail de
      -- pay_customer_debt(), et le faire aussi ici créerait deux endroits qui
      -- décident de la même chose — dont un qui s'exécute une fois, à la
      -- migration, et ne se rejouera jamais.
      UPDATE sales SET amount_received = v_montant WHERE id = v_sale.id;
      v_restant := v_restant - v_montant;
    END LOOP;
  END LOOP;
END;
$$;

-- Contrôle d'intégrité : une vente ne peut pas avoir reçu plus que son prix.
-- Un bug de répartition se verrait ici immédiatement, plutôt que dans un
-- chiffre d'affaires faux trois mois plus tard.
ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_amount_received_sane;
ALTER TABLE sales ADD CONSTRAINT sales_amount_received_sane
  CHECK (amount_received >= 0 AND amount_received <= total_amount);


-- ─── Le défaut qui rend la colonne infalsifiable ───────────
-- Une vente espèces porte DEFAULT 0 sur amount_received, parce que c'est la
-- seule valeur correcte pour un crédit. Mais une insertion directe en SQL —
-- import, script de reprise, migration future, un test — ne passe pas par
-- create_sale(), et laisserait donc amount_received à 0 sur une vente
-- entièrement payée. Conséquence : une vente de 20 000 F qui disparaît du
-- chiffre d'affaires sans lever la moindre erreur, et la caisse ne tombe plus
-- d'accord avec le rapport.
--
-- Le trigger referme la faille sans changer le défaut : si la vente n'est pas à
-- crédit et que rien n'a été renseigné, ce qui est rentré ne peut être que le
-- prix. create_sale() continue d'écrire la colonne explicitement, donc il n'y a
-- pas de double règle — le trigger ne rattrape que ce qui a été oublié.
--
-- ⚠ Un trigger de ce type ne peut pas être « après coup » : il doit être
--   AVANT INSERT. Et il ne touche pas au crédit, dont le montant dépend de
--   l'acompte versé — seul record_credit_sale() sait de combien il est.
--
-- La fonction est créée AVANT le trigger : PostgreSQL ne vérifie pas l'existence
-- de la fonction au CREATE TRIGGER, il échoue seulement à la première insertion.
-- Sur une base neuve, la migration se termine donc « avec succès » et la
-- première vente échoue — l'erreur la plus différée et la plus coûteuse.
CREATE OR REPLACE FUNCTION fill_amount_received()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Vente à crédit : la valeur par défaut 0 est la bonne. Ne rien faire, et
  -- surtout ne pas deviner — un acompte est une information, pas une
  -- déduction.
  IF NEW.payment_method = 'credit' THEN
    RETURN NEW;
  END IF;

  -- Le total peut être NULL sur une insertion partielle, d'où le COALESCE.
  IF COALESCE(NEW.amount_received, 0) = 0 THEN
    NEW.amount_received := COALESCE(NEW.total_amount, 0);
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION fill_amount_received() IS
  'Renseigne amount_received sur une vente non crédit si elle a été omise. '
  'Sans ce trigger, une insertion directe en SQL laisserait une vente payée à 0 '
  'et la ferait disparaître du chiffre d''affaires sans erreur. Le crédit est '
  'laissé à 0 : seul record_credit_sale() connaît l''acompte.';

DROP TRIGGER IF EXISTS sales_fill_amount_received ON sales;
CREATE TRIGGER sales_fill_amount_received
  BEFORE INSERT ON sales
  FOR EACH ROW
  EXECUTE FUNCTION fill_amount_received();


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
--
-- ⚠ DROP avant CREATE : la signature de retour a changé (avg_sold_price,
--   discount_given, units_sold_at_loss pour le prix négocié). PostgreSQL refuse
--   en 42P13 de remplacer une fonction dont le type de retour diffère — les
--   paramètres OUT font partie de la signature. Le DROP doit précéder, sinon
--   le script s'interrompt et le reste de la migration n'est pas appliqué.
DROP FUNCTION IF EXISTS get_product_profitability();

CREATE FUNCTION get_product_profitability()
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
  units_sold_at_loss bigint,
  -- Montant cédé à crédit et non encore encaissé, sur ce produit. N'entre pas
  -- dans revenue ni gross_profit : la recette à l'encaissement est le choix
  -- prudent, sinon un commerçant qui prête verrait son chiffre d'affaires
  -- gonflé par une dette qu'il ne recouvrera peut-être jamais.
  unsettled_credit numeric
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
    -- FAIT PHYSIQUE : tout ce qui est sorti, y compris cédé à crédit. Prévisions
    -- s'en sert pour estimer la rotation, et la marchandise est bien partie.
    COALESCE(SUM(si.quantity), 0)                AS units_sold,
    -- FAIT FINANCIER : ce qui est réellement rentré, au prorata de l'acompte.
    --
    -- Une vente de 130 000 dont 50 000 sont versés compte pour 50 000. Pas
    -- 130 000 (le commerçant n'a pas encaissé le reste) ni 0 (il a bien reçu
    -- 50 000, sa caisse ne peut pas être en désaccord avec son chiffre
    -- d'affaires). C'est de la base de caisse, appliquée ligne par ligne.
    --
    -- Le ratio est NULLIF sur total_amount : une vente gratuite — prix 0 —
    -- donnerait une division par zéro, et ferait échouer toute la requête.
    -- COALESCE le ramène à 0, ce qui est correct : rien n'a été encaissé.
    COALESCE(SUM(si.subtotal * COALESCE(s.amount_received / NULLIF(s.total_amount, 0), 0)), 0)
                                                        AS revenue,
    -- Le coût suit la même clé. Reconnaître la recette sans son coût donnerait
    -- une marge qui monte à chaque vente à crédit, ce qui est l'inverse de la
    -- réalité : le coût de la marchandise est engagé dès qu'elle sort.
    COALESCE(SUM(si.unit_cost * si.quantity * COALESCE(s.amount_received / NULLIF(s.total_amount, 0), 0)), 0)
                                                        AS cost_of_goods,
    COALESCE(SUM((si.subtotal - si.unit_cost * si.quantity) * COALESCE(s.amount_received / NULLIF(s.total_amount, 0), 0)), 0)
                                                        AS gross_profit,
    -- Le taux de marge est insensible au prorata : le ratio s'annule. Une vente
    -- à moitié encaissée affiche donc le VRAI taux de marge du produit, et non un
    -- taux dégradé par un encaissement partiel. C'est ce qu'un commerçant veut
    -- savoir : « sur ce produit, je gagne combien ».
    CASE
      WHEN COALESCE(SUM(si.subtotal * COALESCE(s.amount_received / NULLIF(s.total_amount, 0), 0)), 0) > 0
        THEN ROUND(
          100 * SUM((si.subtotal - si.unit_cost * si.quantity) * COALESCE(s.amount_received / NULLIF(s.total_amount, 0), 0))
          / SUM(si.subtotal * COALESCE(s.amount_received / NULLIF(s.total_amount, 0), 0)), 1)
      ELSE NULL
    END                                          AS margin_pct,
    -- Prix moyen RÉALISÉ par unité : chiffre d'affaires encaissé divisé par
    -- quantité vendue. Sur une vente à moitié payée, c'est la moitié du prix
    -- catalogue — c'est ce que le client a réellement payé pour ces unités.
    CASE
      WHEN COALESCE(SUM(si.quantity), 0) > 0
        THEN ROUND(
          SUM(si.subtotal * COALESCE(s.amount_received / NULLIF(s.total_amount, 0), 0))
          / SUM(si.quantity), 2)
      ELSE NULL
    END                                          AS avg_sold_price,
    -- list_price est NULL sur les ventes antérieures au prix négocié : on
    -- traite l'absence comme « pas de remise » plutôt que de fausser l'écart.
    COALESCE(SUM(
      (COALESCE(si.list_price, si.unit_price) - si.unit_price) * si.quantity
    ), 0)                                        AS discount_given,
    COALESCE(SUM(si.quantity) FILTER (
      WHERE si.unit_cost IS NOT NULL AND si.unit_price < si.unit_cost
    ), 0)                                        AS units_sold_at_loss,
    -- Informatif : ce qui reste dû sur ce produit. N'entre dans aucun total.
    --
    -- ⚠ La parenthèse de SUM se ferme AVANT le FILTER : c'est SUM(expr) FILTER
    --   (WHERE ...), pas SUM(expr FILTER (WHERE ...)). La seconde forme est un
    --   « syntax error at or near "FILTER" » sans indication de ligne, et le
    --   message ne dit rien de la parenthèse mal placée. Compter les parenthèses ne suffit
    --   pas : elles sont équilibrées dans les deux écritures.
    COALESCE(SUM(si.subtotal * (1 - COALESCE(s.amount_received / NULLIF(s.total_amount, 0), 0)))
                 FILTER (WHERE NOT s.settled), 0) AS unsettled_credit
  FROM products p
  LEFT JOIN sale_items si ON si.product_id = p.id
  -- La jointure sur sales est nécessaire pour lire amount_received. LEFT JOIN
  -- et non INNER : les produits sans vente doivent apparaître avec des zéros.
  LEFT JOIN sales s ON s.id = si.sale_id
  -- VERROU DE PLAN. Le cadenas du menu ne protège rien : cette fonction est
  -- appelable directement en RPC, et l'appel ne respecte aucun plan côté
  -- client. Sans cette condition, un client en plan gratuit obtient sa
  -- rentabilité — prix d'achat, prix de vente, marge unitaire — en appelant
  -- depuis la console du navigateur. Il paie 0 F ce qui vaut 3 000 F/mois.
  --
  -- `SELECT true FROM require_feature('reports')` renvoie true si le plan
  -- suffit, et lève une exception sinon. require_feature est VOLATILE, donc le
  -- planificateur ne peut pas l'écarter ni la calculer une fois pour toutes.
  -- Voir migration_plan_gate.sql.
  WHERE p.is_active
    AND (SELECT true FROM require_feature('reports'))
  -- Les produits archivés restent hors du tableau de bord : leur historique
  -- est conservé en base, ils ne sont plus pilotés.
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
      -- Base de caisse, sans exception : le chiffre d'affaires est ce qui est
      -- réellement rentré, et amount_received est la seule colonne qui le sait.
      -- Une vente espèces vaut son prix, une vente à crédit vaut son acompte,
      -- et un règlement encaissé aujourd'hui sur une vente d'hier est
      -- imputé... à la date de la vente, pas à celle du versement.
      --
      -- Ce dernier point est un choix, et il faut le dire : le résultat net est
      -- rattaché à la journée où la vente a eu lieu, même si l'argent est rentré
      -- trois semaines plus tard. Rattacher au jour du versement donnerait un
      -- résultat net qui bouge le jour où le client paie, sur une journée où
      -- aucune vente n'a été faite — impossible à lire pour un commerçant, et
      -- sans rapport avec ce que sa caisse contient réellement.
      SUM(s.amount_received) AS revenue,
      COUNT(*)              AS tx
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
  -- VERROU DE PLAN. Même raison que get_product_profitability() : l'appel RPC
  -- contourne le cadenas du menu. Ici, ce que le client gratuit lirait est le
  -- résultat net par jour — exactement ce qui se trouve au bas de la page
  -- « Charges », la ligne que le plan vend.
  -- require_feature est VOLATILE : elle ne peut être ni écartée ni mise en
  -- cache par le planificateur. FULL OUTER JOIN produit toujours au moins une
  -- ligne, donc le garde est toujours atteint.
  WHERE (SELECT true FROM require_feature('reports'))
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


-- ============================================================
-- CRÉDIT CLIENT — fonctions
-- À exécuter après migration_credit.sql
--
-- Trois opérations :
--   1. record_credit_sale()  — une vente à crédit et sa fiche client
--   2. pay_customer_debt()   — un encaissement, soldant les ventes par ordre
--                              d'ancienneté
--   3. get_customer_debts()  — le solde par client
--
-- L'ordre d'ancienneté est le bon ordre en informel : la dette la plus vieille
-- est celle qu'il faut relancer en premier, et le commerçant ne raisonne pas
-- par vente mais par « ce qu'il me doit au total ».
-- ============================================================

-- ─── 1. Normaliser un numéro ──────────────────────────────
-- '+229 97 00 00 00', '22997000000' et '97000000' désignent le même client.
-- Sans cela, « +229 97… » et « 97… » créeraient deux dettes distinctes pour une
-- seule personne, et le commerçant croirait avoir deux débiteurs.
--
-- IMMUTABLE et sans accès table : accordable au client, qui normalise avant
-- d'envoyer, sans aller-retour réseau à chaque saisie.
CREATE OR REPLACE FUNCTION normalize_phone(p_phone text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_digits text;
BEGIN
  v_digits := regexp_replace(COALESCE(p_phone, ''), '[^0-9]', '', 'g');

  IF v_digits = '' THEN
    RETURN NULL;
  END IF;

  -- 8 chiffres = numéro local béninois, on préfixe l'indicatif pays.
  IF length(v_digits) = 8 THEN
    v_digits := '229' || v_digits;
  END IF;

  IF length(v_digits) < 8 OR length(v_digits) > 15 THEN
    RETURN NULL;
  END IF;

  RETURN v_digits;
END;
$$;

REVOKE ALL ON FUNCTION normalize_phone(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION normalize_phone(text) TO authenticated;
GRANT EXECUTE ON FUNCTION normalize_phone(text) TO service_role;


-- ─── 2. Enregistrer une vente à crédit ────────────────────
-- Séparée de create_sale() volontairement : la vente à crédit a des contraintes
-- propres — téléphone obligatoire, pas de recette immédiate — et les mélanger
-- dans une fonction déjà surchargée rendrait les deux chemins illisibles.
--
-- La vente passe par create_sale() avec payment_method = 'credit', puis on
-- marque settled = false. Le stock est donc décrémenté exactement comme pour
-- une vente cash : la marchandise est partie.
--
-- p_advance est l'acompte : ce que le client donne sur-le-champ. Laissé vide ou
-- à 0, c'est un crédit total — le comportement d'origine. C'est le cas le plus
-- courant en boutique de quartier : « donne-moi 50 000, je passe demain ».
--
-- L'acompte est enregistré comme un versement dans credit_payments, avec la
-- date du jour. C'est ce qui permet de dire au client, sur WhatsApp ou au
-- comptoir, « tu as déjà payé 50 000 » sans que personne ait à recalculer. Il ne
-- sert PAS à calculer la dette : celle-ci se lit dans amount_received.
--
-- SECURITY DEFINER : l'appelant n'est pas encore connu de la boutique, et
-- create_sale() l'est déjà.
CREATE OR REPLACE FUNCTION record_credit_sale(
  p_items        jsonb,
  p_client_name  text,
  p_client_phone text,
  p_note         text DEFAULT NULL,
  p_advance      numeric(12,2) DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner   uuid;
  v_phone   text;
  v_sale    jsonb;
  v_sale_id uuid;
  v_debt_id uuid;
  v_total   numeric(12,2);
  v_name    text;
  v_avance  numeric(12,2);
  v_du      numeric(12,2);
BEGIN
  v_owner := get_business_owner_id();
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Non authentifié' USING ERRCODE = '28000';
  END IF;

  IF btrim(COALESCE(p_client_name, '')) = '' THEN
    RAISE EXCEPTION 'Indiquez le nom du client' USING ERRCODE = '22023';
  END IF;

  v_phone := normalize_phone(p_client_phone);
  IF v_phone IS NULL THEN
    -- Sans numéro, la dette n'est rattachable à personne et la relance WhatsApp
    -- devient impossible. On refuse plutôt que d'accepter une dette orpheline
    -- qu'on ne pourra pas suivre.
    RAISE EXCEPTION 'Le numéro de téléphone est obligatoire pour une vente à crédit'
      USING ERRCODE = '22023';
  END IF;

  -- Un acompte négatif serait un remboursement, et un remboursement est un
  -- autre geste : il se fait sur l'écran Dettes, pas en cassant la vente. Un
  -- acompte supérieur au prix, de même — c'est un trop-perçu, pas un acompte.
  v_avance := round(COALESCE(p_advance, 0), 2);
  IF v_avance < 0 THEN
    RAISE EXCEPTION 'L''avance versée ne peut pas être négative' USING ERRCODE = '22023';
  END IF;

  -- Le nom va avec la vente : c'est ce que le commerçant voit sur son reçu, même
  -- si le client change ensuite de nom d'enregistrement.
  v_name := btrim(p_client_name);

  -- create_sale() fait le travail lourd : atomicité, stock, coût figé, prix
  -- négocié. On passe par lui plutôt que de dupliquer.
  --
  -- credit.internal lève le garde-fou qui refuse 'credit' : sans lui,
  -- create_sale() ne pourrait pas être appelé avec ce moyen de paiement. Le GUC
  -- est remis à NULL juste après — la transaction l'annulerait de toute façon,
  -- mais le laisser posé ferait passer une vente à crédit encodée en dur pour un
  -- appel direct suivant, dans la même session.
  PERFORM set_config('credit.internal', '1', true);
  v_sale := create_sale(p_items, 'credit', v_name, p_note);
  PERFORM set_config('credit.internal', NULL, true);
  v_sale_id := (v_sale->>'id')::uuid;
  v_total := (v_sale->>'total_amount')::numeric(12,2);

  IF v_avance > v_total THEN
    RAISE EXCEPTION
      'L''avance versée (% F) dépasse le prix de la vente (% F)', v_avance, v_total
      USING ERRCODE = '22023';
  END IF;

  -- amount_received porte ce qui est réellement rentré : c'est la seule colonne
  -- qui décide du chiffre d'affaires. settled reste dérivé — il ne sert plus
  -- qu'à l'indexation des dettes en cours.
  UPDATE sales
     SET amount_received = v_avance,
         settled = (v_avance >= v_total),
         client_phone = v_phone
   WHERE id = v_sale_id;

  -- Fiche client créée à la première dette, réutilisée ensuite. ON CONFLICT DO
  -- UPDATE garde le nom à jour : « Maman Koffi » devient « Mme Koffi ».
  INSERT INTO customer_debts (user_id, phone, name)
  VALUES (v_owner, v_phone, v_name)
  ON CONFLICT (user_id, phone) DO UPDATE
    SET name = EXCLUDED.name,
        updated_at = now();

  SELECT id INTO v_debt_id
    FROM customer_debts
   WHERE user_id = v_owner AND phone = v_phone;

  -- L'acompte entre aussi dans l'historique des versements. Pas pour calculer la
  -- dette — ça, c'est amount_received — mais pour que la question « il m'a déjà
  -- donné combien ? » ait une réponse datée, avec son moyen de paiement. C'est
  -- aussi ce que l'écran Dettes affiche en « versements », et ce qu'un client
  -- conteste éventuellement.
  IF v_avance > 0 THEN
    INSERT INTO credit_payments (debt_id, user_id, amount, day, method, note)
    VALUES (v_debt_id, v_owner, v_avance, current_date, 'cash',
            'Acompte versé à la vente');
  END IF;

  v_du := v_total - v_avance;

  RETURN jsonb_build_object(
    'id',              v_sale_id,
    'total_amount',    v_total,
    -- Reste à recouvrer, renvoyé pour que l'écran n'ait pas à le recalculer et
    -- risquer un arrondi différent de celui de la base.
    'amount_advance',  v_avance,
    'amount_due',      v_du,
    'invoice_number',  v_sale->>'invoice_number',
    'debt_id',         v_debt_id,
    'client_phone',    v_phone
  );
END;
$$;

REVOKE ALL ON FUNCTION record_credit_sale(jsonb, text, text, text, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_credit_sale(jsonb, text, text, text, numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION record_credit_sale(jsonb, text, text, text, numeric) TO service_role;

-- L'ancienne version à quatre arguments est retirée. CREATE OR REPLACE ajoute
-- bien le paramètre p_advance, mais sur une base où la version à quatre
-- arguments a déjà été créée, celle-ci reste : PostgREST la verrait et
-- mapperait l'appel sur l'ancienne, sans l'acompte. Deux fonctions de même nom
-- et d'arités différentes, c'est le piège qui rend les erreurs illisibles.
DROP FUNCTION IF EXISTS record_credit_sale(jsonb, text, text, text);

COMMENT ON FUNCTION record_credit_sale(jsonb, text, text, text, numeric) IS
  'Vente à crédit. p_advance est l''acompte versé sur-le-champ : laissé vide ou '
  'à 0, c''est un crédit total. L''acompte compte au chiffre d''affaires le jour '
  'même et réduit d''autant la dette. Le stock part dans tous les cas.';


-- ─── 3. Encaisser un versement ────────────────────────────
-- Solde les ventes les plus anciennes d'abord. Un règlement partiel est la
-- norme : « je te paye 3 000 sur les 8 000 ».
--
-- L'algorithme est volontairement simple : on parcourt les ventes non soldées par
-- ancienneté, et on rembourse chacune du reliquat de trésorerie. Ce qui reste à
-- la fin est la dette. Une version plus savante répartirait au prorata, mais le
-- commerçant ne raisonne pas en tantimes de ventes — il veut « ce qui reste ».
--
-- Le surplus va au crédit du client : il n'est ni perdu ni compté en recette. Le
-- commerce l'inscrit en dette fournisseur, qui est une autre fonctionnalité.
--
-- SECURITY DEFINER : le solde croise sales et credit_payments sur le numéro de
-- téléphone, ce qu'aucune policy RLS ne peut exprimer.
CREATE OR REPLACE FUNCTION pay_customer_debt(
  p_debt_id uuid,
  p_amount  numeric(12,2),
  p_method  text DEFAULT 'cash',
  p_note    text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner        uuid;
  v_phone        text;
  v_user_id      uuid;
  v_restant      numeric(12,2);
  v_avant        numeric(12,2);
  -- Ce qui manque sur la vente en cours de traitement. Différent de v_restant,
  -- qui est le reliquat de trésorerie : les deux se confondent vite, et les
  -- confondre ferait solder une vente par de l'argent destiné à une autre.
  v_du           numeric(12,2);
  v_reglees      int := 0;
  v_sale         record;
BEGIN
  v_owner := get_business_owner_id();
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Non authentifié' USING ERRCODE = '28000';
  END IF;

  -- Sans FOR UPDATE explicite ici, deux caisses encaissant en même temps
  -- pourraient toutes deux solder la même vente. Verrou de ligne sur la fiche.
  SELECT phone, user_id INTO v_phone, v_user_id
    FROM customer_debts
   WHERE id = p_debt_id
   FOR UPDATE;

  IF NOT FOUND OR v_user_id <> v_owner THEN
    -- Message identique à « introuvable » : un patron ne doit pas pouvoir
    -- deviner l'existence d'une fiche d'un autre tenant.
    RAISE EXCEPTION 'Client introuvable' USING ERRCODE = 'P0002';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Montant de versement invalide' USING ERRCODE = '22023';
  END IF;

  IF p_method IS NULL OR p_method NOT IN ('cash', 'momo') THEN
    RAISE EXCEPTION 'Moyen de paiement invalide : %', p_method USING ERRCODE = '22023';
  END IF;

  -- Solde avant versement : ce qui manque sur les ventes ouvertes de ce client.
  -- Une simple somme de Differences, juste par construction. La version
  -- précédente soustrayait un cumul de versements d'un cumul de prix, et
  -- reconstituait la répartition dans la boucle — deux calculs à tenir d'accord,
  -- donc une occasion de diverger. Ici il n'y a rien à reconstituer.
  SELECT COALESCE(SUM(s.total_amount - s.amount_received), 0) INTO v_avant
    FROM sales s
   WHERE s.user_id = v_owner AND s.client_phone = v_phone AND NOT s.settled;

  IF v_avant <= 0 THEN
    RAISE EXCEPTION 'Ce client n''a pas de dette en cours' USING ERRCODE = '22023';
  END IF;

  INSERT INTO credit_payments (debt_id, user_id, amount, day, method, note)
  VALUES (p_debt_id, v_owner, p_amount, current_date, p_method,
          NULLIF(btrim(COALESCE(p_note, '')), ''));

  -- Répartit le versement sur les ventes ouvertes, de la plus ancienne à la plus
  -- récente. Chaque vente reçoit ce qui lui manque, pas plus.
  --
  -- On boucle sur un curseur simple, sans FOR UPDATE : le verrou utile est posé
  -- sur la fiche client plus haut, ce qui sérialise deux caisses encaissant pour
  -- le même client. Verrouiller aussi chaque ligne ici n'apporte rien et, dans un
  -- FOR ... LOOP PL/pgSQL, n'itère pas sur la snapshot attendue.
  --
  -- Le reliquat porte aussi les acomptes déjà versés à la vente : c'est
  -- amount_received qui dit ce qui a été couvert, pas le montant de ce versement.
  -- C'est ce qui rend le calcul insensible à l'ordre des appels — deux versements
  -- de 8 000 puis 12 000 soldent une vente de 20 000, comme un seul de 20 000.
  v_restant := p_amount;

  FOR v_sale IN
    SELECT s.id, s.total_amount, s.amount_received
      FROM sales s
     WHERE s.user_id = v_owner
       AND s.client_phone = v_phone
       AND NOT s.settled
     ORDER BY s.created_at ASC
  LOOP
    EXIT WHEN v_restant <= 0;

    -- Ce qui manque sur CETTE vente, l'acompte éventuel étant déjà déduit.
    v_du := v_sale.total_amount - v_sale.amount_received;

    IF v_restant >= v_du THEN
      UPDATE sales
         SET amount_received = total_amount,
             settled = true
       WHERE id = v_sale.id;
      v_restant := v_restant - v_du;
      v_reglees := v_reglees + 1;
    ELSE
      -- Paiement partiel : la vente reste ouverte, et ce reliquat devient du
      -- chiffre d'affaires encaissé dès aujourd'hui.
      UPDATE sales SET amount_received = amount_received + v_restant WHERE id = v_sale.id;
      v_restant := 0;
    END IF;
  END LOOP;

  -- Solde final : ce qui n'a pas couvert une vente entière reste dû.
  SELECT COALESCE(SUM(s.total_amount - s.amount_received), 0) INTO v_restant
    FROM sales s
   WHERE s.user_id = v_owner AND s.client_phone = v_phone AND NOT s.settled;

  UPDATE customer_debts SET updated_at = now() WHERE id = p_debt_id;

  RETURN jsonb_build_object(
    'debt_id',        p_debt_id,
    'amount_paid',    p_amount,
    'balance_before', v_avant,
    'balance_after',  GREATEST(v_restant, 0),
    'sales_settled',  v_reglees
  );
END;
$$;

REVOKE ALL ON FUNCTION pay_customer_debt(uuid, numeric, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pay_customer_debt(uuid, numeric, text, text) TO authenticated;


-- ─── 4. Les soldes ────────────────────────────────────────
-- Fonction plutôt que vue : le solde se lit dans sales.amount_received, et une
-- vue SECURITY DEFINER contournerait la RLS de sales.
-- SECURITY INVOKER : l'isolation vient de la RLS de sales et customer_debts.
--
-- Le solde est une somme de différences : ce qui manque sur chaque vente ouverte.
-- Les versements n'y entrent pas. C'est la conséquence directe de l'acompte — si
-- le prix est 130 000, l'acompte 50 000 et le reste 80 000, la dette est 80 000
-- parce que amount_received vaut 50 000, pas parce qu'on a soustrait 50 000 d'un
-- journal. Un seul calcul, aucune répartition à reconstituer.
--
-- ⚠ DROP avant CREATE, et c'est obligatoire : ajouter total_paid au RETURNS
--   TABLE change le type de retour. Les paramètres OUT font partie de la
--   signature, donc PostgreSQL refuse en 42P13 « cannot change return type of
--   existing function » et interrompt le script AU MILIEU — les GRANT et les
--   COMMENT qui suivent ne sont jamais appliqués, et la fonction reste celle
--   d'avant. C'est l'erreur 42P13 déjà documentée dans le README, rencontrée
--   une fois de plus parce que le piège est réel et non théorique.
DROP FUNCTION IF EXISTS get_customer_debts();

CREATE FUNCTION get_customer_debts()
RETURNS TABLE (
  debt_id         uuid,
  phone           text,
  name            text,
  total_due       numeric,
  last_sale_at    timestamptz,
  sales_count     bigint,
  oldest_sale_at  timestamptz,
  payments_count  bigint,
  last_payment_at date,
  -- Ce que le client a déjà versé sur ses ventes en cours. Affiché à côté du
  -- solde : « 130 000 dont 50 000 déjà payés » est plus parlant qu'un 80 000
  -- nu, et c'est la phrase à prononcer au comptoir.
  total_paid      numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH dues AS (
    SELECT
      s.user_id,
      s.client_phone,
      SUM(s.total_amount - s.amount_received) AS total_due,
      SUM(s.amount_received)                 AS total_paid,
      COUNT(*)                               AS sales_count,
      MAX(s.created_at)                      AS last_sale_at,
      MIN(s.created_at)                      AS oldest_sale_at
    FROM sales s
    WHERE NOT s.settled AND s.client_phone IS NOT NULL
    GROUP BY s.user_id, s.client_phone
  ), soldes AS (
    SELECT
      d.id,
      d.user_id,
      d.phone,
      d.name,
      GREATEST(COALESCE(u.total_due, 0), 0) AS total_due,
      u.last_sale_at,
      COALESCE(u.sales_count, 0) AS sales_count,
      u.oldest_sale_at,
      COALESCE(u.total_paid, 0) AS total_paid,
      (SELECT COUNT(*) FROM credit_payments cp2 WHERE cp2.debt_id = d.id) AS payments_count,
      (SELECT MAX(cp3.day) FROM credit_payments cp3 WHERE cp3.debt_id = d.id) AS last_payment_at
    FROM customer_debts d
    LEFT JOIN dues u ON u.user_id = d.user_id AND u.client_phone = d.phone
  )
  SELECT s.id, s.phone, s.name, s.total_due, s.last_sale_at, s.sales_count,
         s.oldest_sale_at, s.payments_count, s.last_payment_at, s.total_paid
    FROM soldes s
   WHERE s.user_id = get_business_owner_id()
     -- VERROU DE PLAN. Le carnet de dette fait partie des rapports : c'est ce
     -- qui est vendu avec le plan Starter. Sans ce garde, un client en plan
     -- gratuit liste ses débiteurs en appelant la fonction en RPC, alors que le
     -- cadenas de l'onglet l'en empêche dans l'interface.
     --
     -- Le solde d'un client n'est pas une information anodine : c'est la liste
     -- des personnes qui doivent de l'argent à la boutique, avec leur numéro de
     -- téléphone. Le RLS protège le voisin, pas le plan.
     AND (SELECT true FROM require_feature('reports'))
     -- Une dette soldée n'a plus rien à réclamer. Sans ce critère, la fiche
     -- persiste et l'écran montre un client à 0 F comme s'il devait de l'argent.
     AND s.total_due > 0
   ORDER BY s.oldest_sale_at ASC NULLS LAST;
$$;

REVOKE ALL ON FUNCTION get_customer_debts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_customer_debts() TO authenticated;

COMMENT ON FUNCTION get_customer_debts() IS
  'Soldes débiteurs, du plus ancien au plus récent. Le solde est la somme de ce '
  'qui manque sur chaque vente ouverte (total_amount - amount_received), donc il '
  'intègre les acomptes versés à la vente. total_paid indique ce qui a déjà été '
  'versé sur ces ventes. Une dette soldée n''apparaît plus. Le client est '
  'identifié par son numéro de téléphone, pas par son nom.';

COMMENT ON FUNCTION pay_customer_debt(uuid, numeric, text, text) IS
  'Enregistre un versement et le répartit sur les ventes à crédit les plus '
  'anciennes d''abord. Un règlement partiel est la norme, et il devient du '
  'chiffre d''affaires encaissé dès le jour même. Le surplus reste au crédit du '
  'client : il n''est ni perdu ni compté en recette.';


-- ============================================================
-- PROGRAMME BÊTA — 10 comptes en accès complet
-- À exécuter dans Supabase SQL Editor
--
-- LE BESOIN
--   Tester en grandeur nature, avec des gens qui ne sont pas le développeur.
--   Dix amis s'inscrivent, ils ouvrent l'application, ils la cassent, et ils
--   disent ce qui manque. C'est le seul moyen de trouver les défauts qu'aucun
--   test automatique ne voit — un prix qui ne s'affiche pas sur un petit
--   écran, un libellé que personne ne comprend, un geste que la caissière ne
--   fait pas parce qu'il n'y est pas.
--
-- POURQUOI UN TRIGGER ET PAS L'APPLICATION
--   Trois chemins créent une organisation : /api/register, la page
--   /register en deux étapes, et l'onboarding de la page d'accueil. Les
--   modifier tous serait trois endroits à tenir d'accord, et le quatrième
--   chemin oublié donnerait un compte gratuit sans qu'on le voie.
--
--   Le trigger est le seul point par où passe toute création de boutique. Il
--   s'applique donc partout, y compris aux chemins qu'on n'a pas prévus, et il
--   ne demande aucune modification de l'application.
--
-- UNE PLACE, PAS UNE PROMESSE
--   Le programme est un budget de 10 places, pas un code d'accès. Il n'y a rien
--   à distribuer et donc rien à trouver : le 11e compte s'inscrit normalement,
--   en gratuit. Une fois les 10 pris, le programme est fermé et le comportement
--   redevient exactement celui d'une inscription normale.
--
--   Fermer définitivement :  SELECT close_beta_program();
--   Changer le nombre de places : UPDATE beta_program SET slots_total = 20;
--   Tout révoquer d'un coup : SELECT revoke_all_beta();
--
-- CE QUI N'EST PAS FAIT, ET POURQUOI
--   Pas de date d'expiration. Une date non appliquée par un trigger planifié
--   est pire qu'aucune date : on croit que l'accès s'arrêtera tout seul, et il
--   ne s'arrête pas. Le budget est fermé par une commande explicite, donc ce
--   qui est promis est ce qui se produit.
--
--   Pas d'accès « illimité » distinct. Un compte bêta est un compte Pro. Une
--   neuvième façon de dire « actif » serait une neuvième source de vérité.
-- ============================================================

-- ─── 1. Le budget ─────────────────────────────────────────
-- Une seule ligne, contrainte à l'identifiant 1 : il n'y a pas de deuxième
-- ligne à créée, donc pas d'état ambigu sur « combien de places restent ».
CREATE TABLE IF NOT EXISTS beta_program (
  id           int PRIMARY KEY DEFAULT 1,
  -- Modifiable à tout moment par un simple UPDATE. 10 par défaut, ce qui est la
  -- demande initiale.
  slots_total  int  NOT NULL DEFAULT 10,
  slots_used   int  NOT NULL DEFAULT 0,
  open         boolean NOT NULL DEFAULT true,
  -- Rappel de pourquoi le programme existe, et jusqu'à quand. Servira au moment
  -- de décider quoi faire des comptes bêta.
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT beta_program_singleton   CHECK (id = 1),
  CONSTRAINT beta_program_cap_positif CHECK (slots_total >= 0),
  -- L'invariant central : impossible d'avoir servi plus de places que le budget.
  -- Une inscription concurrente qui chercherait à dépasser le plafond violerait
  -- cette contrainte et la transaction entière serait annulée, plutôt que de
  -- laisser un onzième compte Pro.
  CONSTRAINT beta_program_dans_le_budget CHECK (slots_used >= 0 AND slots_used <= slots_total)
);

INSERT INTO beta_program (id, slots_total, note)
VALUES (1, 10, 'Dix comptes en accès Pro pour les tests en conditions réelles.')
ON CONFLICT (id) DO UPDATE
  SET note = EXCLUDED.note;
-- ⚠ ON CONFLICT ne touche PAS slots_used : rejouer la migration ne doit pas
--   réinitialiser le compteur, sinon une réapplication donnerait 10 places
--   neuves et le programme ne se fermerait jamais.


-- ─── 2. Qui a eu une place ────────────────────────────────
-- Pas seulement un journal : cette table est l'outil de travail du test. Les
-- colonnes de retour existent pour ça, sinon l'information se perd dans des
-- messages privés et ne sert à rien.
CREATE TABLE IF NOT EXISTS beta_access (
  user_id    uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  email      text,
  plan       text NOT NULL DEFAULT 'pro' CHECK (plan IN ('free', 'starter', 'pro')),
  granted_at timestamptz NOT NULL DEFAULT now(),

  -- Le matériau du debriefing, écrit au fil de l'eau.
  avis       text,   -- ce que la personne a dit, en ses mots
  bugs       text,   -- ce qui ne marche pas, avec la façon de reproduire
  manques    text,   -- ce qui manque, ce qu'elle aurait aimé avoir
  teste_le   date,

  CONSTRAINT beta_access_one_row_per_shop CHECK (user_id IS NOT NULL)
);

COMMENT ON TABLE beta_access IS
  'Comptes bêta et retours associés. Les colonnes avis / bugs / manques sont le '
  'point d''accumulation des retours de test : à remplir au fil des tests, puis '
  'à relire dans cet ordre pour décider quoi corriger.';

-- Aucune policy : ces tables sont des outils d'administration. Le trigger qui
-- écrit dedans est SECURITY DEFINER, donc il n'en a pas besoin, et le client
-- n'a rien à y voir. Un testeur ne doit pas pouvoir élargir son accès lui-même.
ALTER TABLE beta_program  ENABLE ROW LEVEL SECURITY;
ALTER TABLE beta_access   ENABLE ROW LEVEL SECURITY;
ALTER TABLE beta_program  FORCE ROW LEVEL SECURITY;
ALTER TABLE beta_access   FORCE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_beta_access_granted ON beta_access(granted_at DESC);

-- ─── 3. L'attribution ─────────────────────────────────────
-- Le travail est partagé par deux triggers, et ce n'est pas un détail de style :
-- beta_access référence organizations, donc la ligne doit EXISTER avant d'y
-- écrire. Un seul trigger BEFORE — le plus naturel, puisque c'est lui qui
-- modifie NEW.plan — violerait la clé étrangère à chaque inscription, ce que
-- PostgreSQL refuse avec « insert or update on table beta_access violates
-- foreign key constraint ».
--
--   BEFORE INSERT  consomme une place et passe NEW.plan à 'pro'
--   AFTER  INSERT  enregistre la fiche, maintenant que la boutique existe
--
-- La décision est transmise par un GUC, remis à NULL dans tous les cas. Le motif
-- est le même que credit.internal dans create_sale() : un état de session, donc
-- non modifiable par un client SQL ordinaire, qui ne laisse rien entre deux
-- requêtes. Si le trigger AFTER levait une exception, l'INSERT entier serait
-- annulé — Trigger et transaction, donc aucune place consommée sans boutique.
--
-- Le point clé de la consommation : un UPDATE unique, gardé par une condition, et
-- non un SELECT suivi d'un UPDATE.
--
-- Deux inscriptions simultanées lisent toutes deux slots_used = 9 et se croient
-- toutes deux autorisées. Avec un seul UPDATE ... WHERE slots_used <
-- slots_total, PostgreSQL reverifie la condition apres avoir pris le verrou de
-- ligne : la seconde transaction voit slots_used = 10, ne modifie aucune ligne,
-- et l'INSERT ne consomme aucune place. C'est ce qui rend le plafond exact sous
-- concurrence, sans SERIALIZABLE ni reessai.
CREATE OR REPLACE FUNCTION beta_claim_slot()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pris int;
BEGIN
  PERFORM set_config('beta.granted', '0', true);

  -- Programme fermé : on ne touche à rien.
  IF NOT EXISTS (SELECT 1 FROM beta_program WHERE id = 1 AND open) THEN
    RETURN NEW;
  END IF;

  UPDATE beta_program
     SET slots_used = slots_used + 1,
         updated_at = now()
   WHERE id = 1
     AND open
     AND slots_used < slots_total;

  GET DIAGNOSTICS v_pris = ROW_COUNT;

  -- Plus de place : la boutique est créée en gratuit, sans aucune trace. C'est
  -- le comportement normal d'une inscription, pas une erreur — le onzième ami
  -- doit pouvoir s'inscrire, simplement sans l'accès complet.
  IF v_pris = 0 THEN
    RETURN NEW;
  END IF;

  PERFORM set_config('beta.granted', '1', true);
  NEW.plan := 'pro';
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION beta_record_access()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email   text;
  v_accorde text;
BEGIN
  -- La décision est LUE avant d'être effacée. L'inverse — effacer puis lire —
  -- lirait toujours NULL, donc aucune fiche ne serait jamais écrite, et le
  -- programme accorderait l'accès sans rien enregistrer : le pire des deux
  -- mondes, puisque le plafond serait consommé sans que personne sache à qui.
  v_accorde := current_setting('beta.granted', true);
  PERFORM set_config('beta.granted', NULL, true);

  IF v_accorde IS DISTINCT FROM '1' THEN
    RETURN NULL;
  END IF;

  -- L'email est sur auth.users, pas sur organizations. Le sous-requête tolère son
  -- absence : une organisation créée hors du flux d'inscription (script,
  -- importation) reçoit une place sans email, ce qui reste identifiable par
  -- l'identifiant.
  SELECT u.email INTO v_email FROM auth.users u WHERE u.id = NEW.id;

  INSERT INTO beta_access (user_id, email, plan)
  VALUES (NEW.id, v_email, 'pro')
  ON CONFLICT (user_id) DO UPDATE
    SET plan = EXCLUDED.plan;

  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION beta_claim_slot() IS
  'Consomme une place du budget bêta et passe la boutique en Pro. Sans quoi la '
  'boutique est créée en gratuit. L''attribution est atomique : sous '
  'concurrence, le plafond reste exact.';

COMMENT ON FUNCTION beta_record_access() IS
  'Enregistre la fiche bêta, après coup : beta_access référence organizations, la '
  'ligne doit donc exister avant. Ne fait rien si aucune place n''a été '
  'consommée par beta_claim_slot().';

DROP TRIGGER IF EXISTS trg_beta_claim_slot ON organizations;
CREATE TRIGGER trg_beta_claim_slot
  BEFORE INSERT ON organizations
  FOR EACH ROW
  EXECUTE FUNCTION beta_claim_slot();

DROP TRIGGER IF EXISTS trg_beta_record_access ON organizations;
CREATE TRIGGER trg_beta_record_access
  AFTER INSERT ON organizations
  FOR EACH ROW
  EXECUTE FUNCTION beta_record_access();

-- ─── 4. Commandes d'administration ────────────────────────
-- Ce que le propriétaire du projet executera. Elles sont en SQL et non dans
-- l'application : ce sont des decisions de gestion, pas des fonctionnalites.

-- Ferme le programme. Les comptes deja servis gardent leur acces : fermer
-- arrete les inscriptions, ca ne retire rien a ceux qui sont deja testes.
CREATE OR REPLACE FUNCTION close_beta_program()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE beta_program
     SET open = false,
         updated_at = now(),
         note = COALESCE(note, '') || ' — programme clos.'
   WHERE id = 1;
$$;

-- Rouvre, et ajuste le budget. Pratique pour une deuxieme vague de testeurs.
CREATE OR REPLACE FUNCTION set_beta_slots(p_total int)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE beta_program
     SET slots_total = p_total,
         open = true,
         updated_at = now()
   WHERE id = 1;
$$;

-- Retombe tout le monde en gratuit et vide le compteur. Le geste de fermeture
-- reelle : sans lui, dix boutiques Pro continueraient d'etre Pro indefiniment.
-- Les commentaires de retour sont conserves : ils sont le prix du test.
CREATE OR REPLACE FUNCTION revoke_all_beta()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_n int;
BEGIN
  UPDATE organizations o
     SET plan = 'free'
   WHERE o.id IN (SELECT user_id FROM beta_access);

  GET DIAGNOSTICS v_n = ROW_COUNT;

  UPDATE beta_access SET plan = 'free';
  UPDATE beta_program
     SET slots_used = 0,
         open = false,
         updated_at = now()
   WHERE id = 1;

  -- %s et non %d : le spécificateur « d » de format() n'est pas accepté par
  -- toutes les versions de PostgreSQL, et l'échec ici serait bien pire que la
  -- révision : une commande d'administration qui ne compile pas.
  RETURN format('%s boutique(s) repassée(s) en gratuit. Les retours sont conservés.', v_n::text);
END;
$$;

-- Etat du programme, en une ligne.
CREATE OR REPLACE FUNCTION beta_status()
RETURNS TABLE (
  open        boolean,
  slots_total int,
  slots_used  int,
  remaining   int,
  granted     bigint,
  note        text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT b.open, b.slots_total, b.slots_used,
         GREATEST(b.slots_total - b.slots_used, 0),
         (SELECT count(*) FROM beta_access WHERE plan = 'pro'),
         b.note
    FROM beta_program b
   WHERE b.id = 1;
$$;

REVOKE ALL ON FUNCTION close_beta_program()   FROM PUBLIC;
REVOKE ALL ON FUNCTION set_beta_slots(int)    FROM PUBLIC;
REVOKE ALL ON FUNCTION revoke_all_beta()      FROM PUBLIC;
REVOKE ALL ON FUNCTION beta_status()          FROM PUBLIC;
GRANT EXECUTE ON FUNCTION beta_status() TO service_role;

-- Les trois commandes d'ecriture restent reservees : elles se lancent depuis le
-- SQL Editor, ou le service role. Aucun client ne doit pouvoir fermer le
-- programme, ajouter des places, ni remettre dix boutiques en gratuit.
GRANT EXECUTE ON FUNCTION close_beta_program()   TO service_role;
GRANT EXECUTE ON FUNCTION set_beta_slots(int)    TO service_role;
GRANT EXECUTE ON FUNCTION revoke_all_beta()      TO service_role;


-- ============================================================
-- MIGRATION : Synthèse des ventes
-- A exécuter dans Supabase SQL Editor
-- ============================================================
--
-- Rapports et Historique additionnaient les ventes côté JavaScript : ils
-- téléchargeaient sales + sale_items(*) sur TOUTE la période demandée, puis
-- faisaient les comptes dans le navigateur.
--
-- Le rendu, lui, était déjà borné — 20 lignes par page sur l'historique, lots
-- de 50 sur les charges. Ce qui n'avait aucune borne, c'est le téléchargement.
--
--   free     30 jours
--   starter  365 jours
--   pro      Infinity      <- et le programme bêta donne l'accès complet
--
-- Sur pro, la requête grandit sans limite pendant toute la vie de la boutique,
-- et c'est précisément le cas des boutiques bêta.
--
-- Les agrégats PostgREST sont refusés sur ce projet (PGRST123 « Use of
-- aggregate functions is not allowed ») : aucun contournement possible sans
-- SQL.
--
-- Deux précautions, et aucune n'est cosmétique :
--
--   · Base de calcul. Les rapports additionnent sales.total_amount, le prix
--     de vente. get_cash_flow() additionne amount_received, l'argent
--     réellement entré — les crédits y valent leur acompte. Les deux sont
--     justes : ils ne mesurent pas la même chose. Réutiliser get_cash_flow()
--     aurait changé les chiffres affichés à l'écran.
--
--   · Fuseau. Le client calcule les jours avec new Date().getDate(), donc
--     dans LE FUSEAU DU NAVIGATEUR, alors que SQL calcule dans celui de la
--     session. Décaler d'une case, c'est décaler les barres du graphique.
--     Le fuseau passe donc en paramètre.
-- ============================================================


-- ─── 1. Synthèse journalière ──────────────────────────────
-- Une ligne par jour de vente, et non une seule ligne de période : le client
-- regroupe ensuite en jours/semaines/mois avec la même bucketKey() qu'avant,
-- donc la forme du graphique ne bouge pas.
CREATE OR REPLACE FUNCTION get_sales_summary(
  p_from date,
  p_to   date,
  p_tz   text DEFAULT 'UTC'
)
RETURNS TABLE (
  day     date,
  revenue numeric,
  cash    numeric,
  momo    numeric,
  tx      bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    (s.created_at AT TIME ZONE p_tz)::date                       AS day,
    COALESCE(SUM(s.total_amount), 0)                             AS revenue,
    COALESCE(SUM(CASE WHEN s.payment_method = 'cash'
                      THEN s.total_amount ELSE 0 END), 0)        AS cash,
    COALESCE(SUM(CASE WHEN s.payment_method = 'momo'
                      THEN s.total_amount ELSE 0 END), 0)        AS momo,
    COUNT(*)                                                     AS tx
  FROM sales s
  -- Bornes exprimées en instants, pas en dates : une condition du type
  -- `(created_at AT TIME ZONE p_tz)::date BETWEEN` n'est pas sargable, elle
  -- forcerait Postgres à relire toute la table du client — on aurait déplacé
  -- le coût sans le supprimer. Ces deux bornes décrivent exactement la même
  -- période que le GROUP BY, transition d'heure d'été comprise.
  WHERE s.created_at >= (p_from::timestamp AT TIME ZONE p_tz)
    AND s.created_at <  ((p_to + 1)::timestamp AT TIME ZONE p_tz)
  GROUP BY 1
  ORDER BY 1;
$$;

REVOKE ALL ON FUNCTION get_sales_summary(date, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION get_sales_summary(date, date, text) TO authenticated;
GRANT EXECUTE ON FUNCTION get_sales_summary(date, date, text) TO service_role;


-- ─── 2. Produits les plus vendus ──────────────────────────
-- Le top 6 par quantité, calculé sur sale_items : c'est ce que faisait
-- côte client `sort().slice(0, 6)` en parcourant toutes les lignes de vente.
CREATE OR REPLACE FUNCTION get_top_products(
  p_from  date,
  p_to    date,
  p_tz    text DEFAULT 'UTC',
  p_limit int  DEFAULT 6
)
RETURNS TABLE (
  product_name text,
  qty          numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT si.product_name,
         COALESCE(SUM(si.quantity), 0) AS qty
  FROM sale_items si
  JOIN sales s ON s.id = si.sale_id
  WHERE s.created_at >= (p_from::timestamp AT TIME ZONE p_tz)
    AND s.created_at <  ((p_to + 1)::timestamp AT TIME ZONE p_tz)
  GROUP BY si.product_name
  -- Clé de départage : deux produits ex aequo affichaient un ordre arbitraire
  -- côté client, qui changeait d'un rendu à l'autre.
  ORDER BY COALESCE(SUM(si.quantity), 0) DESC, si.product_name
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 6), 1), 100);
$$;

REVOKE ALL ON FUNCTION get_top_products(date, date, text, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION get_top_products(date, date, text, int) TO authenticated;
GRANT EXECUTE ON FUNCTION get_top_products(date, date, text, int) TO service_role;


-- Pas de garde de plan sur ces deux fonctions, contrairement à
-- get_cash_flow() : elles n'additionnent que des lignes que l'appelant peut
-- déjà SELECTer sous RLS. Le plafond de plan sur les rapports reste appliqué
-- à l'écran, comme il l'était avant — ajouter la garde ici couperait
-- l'historique des ventes aux comptes gratuits, qui n'ont jamais été privés
-- de leur propre total.
--
-- ─── Note sur les REVOKE ───────────────────────────────────
-- Ils ciblent `anon` explicitement, pas seulement PUBLIC, et ce n'est pas de
-- la prudence en l'air. Supabase pose des privilèges par défaut DIRECTS sur
-- anon, authenticated et service_role (ALTER DEFAULT PRIVILEGES) : le grant
-- ne vient pas de PUBLIC. `REVOKE ... FROM PUBLIC` seul y laisse donc la clé
-- anonyme parfaitement capable d'appeler la fonction — ce qui est exactement
-- ce qui est arrivé en production à 33 des 35 fonctions du schéma public,
-- malgré des REVOKE écrits partout dans les migrations. Vérifié en base le
-- 03/10/2026.


-- ============================================================
-- MIGRATION : Durcissement sécurité
-- A exécuter dans Supabase SQL Editor
-- ============================================================
--
-- Six trous, du plus rapide au plus structurant :
--
--   1. rate_limits sans RLS      — le compteur d'inscription est effaçable
--                                   par n'importe quel client, clé anon en
--                                   main : `DELETE /rest/v1/rate_limits` et on
--                                   repasse à l'inscription illimitée.
--   2. organizations.plan libre  — n'importe quel client passe sa boutique en
--                                   Pro sans payer. current_org_plan(),
--                                   require_feature(), check_product_limit()
--                                   et la facturation Pro lisent tous cette
--                                   colonne.
--   3. subscriptions sans UNIQUE(org_id) — l'upsert du webhook échoue en
--                                   silence (supabase-js renvoie {error}, la
--                                   route ne le lit pas), le portail
--                                   abonnement répond 404 et un client Stripe
--                                   est recréé à chaque achat.
--   4. business_members FOR ALL  — un utilisateur peut rattacher un compte
--                                   arbitraire à son équipe : la victime voit
--                                   son tenant basculer chez l'attaquant.
--   5. sales / sale_items / stock_logs FOR ALL — créées sans clause FOR, donc
--                                   pour les quatre commandes. Un employé
--                                   pouvait UPDATE et DELETE les ventes de la
--                                   boutique, et le journal des stocks.
--   6. suppression de compte cassée — deux pannes de bout en bout relevées dans
--                                   les logs Auth : l'API renvoyait 500 sur
--                                   toute lecture d'utilisateur, et la
--                                   suppression d'un compte pourvu de ventes
--                                   échouait sur une FK.
--
-- Le point 4 est refermé ici à deux niveaux (policy + trigger) et un troisième
-- dans l'application : la suppression du compte Auth en cascade n'est plus
-- appelée par /api/employees/[id].
--
-- Rejouable : IF NOT EXISTS / DROP … IF EXISTS / CREATE OR REPLACE partout.
-- Doit rester la DERNIÈRE migration du dossier supabase/ : c'est elle qui
-- ferme les failles ouvertes plus tôt, et les rejouer après l'aurait
-- taries.


-- ─── 1. rate_limits : hors portée du client ────────────────
-- bump_rate_limit() est SECURITY DEFINER et appartient au propriétaire de la
-- table. Sans FORCE, le propriétaire échappe à la RLS et la fonction continue
-- de tourner ; anon et authenticated, eux, se heurtent à l'absence totale de
-- policy — c'est le déni pur, pour SELECT comme pour DELETE.
--
-- FORCE ROW LEVEL SECURITY n'est volontairement PAS posée : elle soumettrait
-- aussi le propriétaire, donc bump_rate_limit() et purge_rate_limits(). Le
-- jour où le propriétaire de la table n'est plus le owner de la fonction, le
-- rate limit casserait — en silence, puisque l'appel est en fail-open.
ALTER TABLE rate_limits ENABLE ROW LEVEL SECURITY;

-- Aucune policy n'est créée : c'est le principe. Le service role, qui a
-- BYPASSRLS, est le seul à y accéder — et il n'y accède que par les deux
-- fonctions ci-dessus.


-- ─── 2. organizations.plan : verrouillé hors Stripe ────────
-- Deux couches, parce qu'une seule peut disparaître :
--   • le trigger refuse toute MODIFICATION de plan venant du navigateur ;
--   • les privilèges interdisent même de NOMMER la colonne plan.
-- Les deux sont indépendants : rejouer une GRANT ALL (ce que fait le harnais
-- de test, et ce que fait Supabase à la création d'une table) ne défait pas le
-- trigger.
CREATE OR REPLACE FUNCTION organizations_reject_plan_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- Plan inchangé : on laisse passer updated_at, onboarding_done, name, etc.
  IF NEW.plan IS NOT DISTINCT FROM OLD.plan THEN
    RETURN NEW;
  END IF;

  -- Deux rôles légitimes modifient le plan :
  --   • service_role — le webhook Stripe, seul détenteur du vrai plan ;
  --   • le rôle de l'éditeur SQL (postgres, supabase_admin) — vous, avec
  --     TEST_ACTIVER_PRO.sql ou close_beta_program().
  -- anon et authenticated sont les deux seuls rôles atteignables depuis le
  -- navigateur : PostgREST n'en autorise pas d'autre avec la clé anon. C'est
  -- donc une liste de négation, et non d'autorisation — le rôle exact de
  -- l'éditeur SQL varie selon les projets Supabase, une liste blanche le
  -- casserait sans prévenir.
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Le plan ne peut être modifié que par le paiement Stripe.'
    USING ERRCODE = '42501',
          HINT = 'Passez par le portail abonnement dans Paramètres, ou par TEST_ACTIVER_PRO.sql côté SQL Editor.';
END;
$$;

DROP TRIGGER IF EXISTS organizations_plan_guard ON organizations;
CREATE TRIGGER organizations_plan_guard
  BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION organizations_reject_plan_change();

-- La colonne par défaut est déjà 'free' : les INSERT du client nommaient
-- plan:'free' inutilement, ce qui les aurait fait échouer ici. Les deux
-- insertions de src/ ont été corrigées en même temps que cette migration.
--
-- Les valeurs écrites par un trigger échappent au contrôle de privilège (il ne
-- porte que sur les colonnes citées dans la requête) : beta_claim_slot()
-- continue donc de passer les dix comptes bêta en Pro.
REVOKE INSERT, UPDATE ON organizations FROM anon, authenticated;
GRANT INSERT  (id, name, slug, logo_url, timezone, currency, onboarding_done, address, ifu)
  ON organizations TO authenticated;
GRANT UPDATE (name, slug, logo_url, timezone, currency, onboarding_done, address, ifu)
  ON organizations TO authenticated;

-- Ni plan, ni invoice_counter, ni created_at : le premier est Stripe, le
-- deuxième est incrémenté par create_sale() en SECURITY DEFINER, les derniers
-- sont à la base.


-- ─── 3. subscriptions : une ligne par organisation ─────────
-- Le webhook fait upsert(..., { onConflict: 'org_id' }) depuis le tout premier
-- jour. PostgreSQL refuse un ON CONFLICT sans contrainte correspondante, et
-- supabase-js renvoie l'erreur dans { error } sans jamais la lever — l'échec
-- était donc totalement invisible.

-- Déduplication préalable : si une base a déjà reçu deux abonnements pour la
-- même org (par un insert direct, puisqu'échouer l'upsert), l'index refuserait
-- d'être créé. On garde la ligne la plus récente.
DELETE FROM subscriptions s
USING subscriptions k
WHERE s.org_id = k.org_id
  AND s.id <> k.id
  AND (COALESCE(k.updated_at, k.created_at, 'epoch'::timestamptz), k.id)
    > (COALESCE(s.updated_at, s.created_at, 'epoch'::timestamptz), s.id);

CREATE UNIQUE INDEX IF NOT EXISTS ux_subscriptions_org
  ON subscriptions (org_id);


-- ─── 4. business_members : lecture seule pour le client ────
-- La policy « owner_manage_members » était FOR ALL : un utilisateur pouvait
-- insérer (owner_id = soi, member_id = <uuid arbitraire>) et rattacher n'importe
-- quel compte à son équipe. Or :
--   • le tenant de la victime bascule chez l'attaquant (get_business_owner_id()
--     privilégie l'appartenance à une équipe) ;
--   • l'attaquant acquiert alors le droit de supprimer ce membre.
-- Aucune écriture client n'existe dans src/ : les insertions passent par
-- redeem_invitation() en SECURITY DEFINER, les suppressions par les routes API
-- en service role. La policy n'avait donc aucune raison d'être en écriture.
DROP POLICY IF EXISTS "owner_manage_members" ON business_members;
DROP POLICY IF EXISTS "owner_manage_members_select" ON business_members;
CREATE POLICY "owner_manage_members_select" ON business_members
  FOR SELECT USING (auth.uid() = owner_id);

-- Seconde couche : un compte qui possède déjà SA boutique ne peut devenir
-- membre d'une autre. Sans cela, inviter un patron détourne son tenant — et
-- supprimer ce lien, puis le compte Auth, détruisait sa boutique entière (tous
-- les ON DELETE CASCADE partent de auth.users).
--
-- SECURITY DEFINER indispensable : en RLS, une interrogation d'organizations
-- filtrée par la policy du candidat ne verrait pas la boutique d'un inconnu, et
-- la garde passerait exactement là où elle doit bloquer.
CREATE OR REPLACE FUNCTION business_members_reject_owner_member()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM organizations o WHERE o.id = NEW.member_id) THEN
    RAISE EXCEPTION 'Ce compte possède déjà sa propre boutique et ne peut pas rejoindre une autre équipe.'
      USING ERRCODE = '23514',
            HINT = 'Invitez un autre compte, ou transférez d''abord la boutique.';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION business_members_reject_owner_member() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION business_members_reject_owner_member() TO authenticated, service_role;

DROP TRIGGER IF EXISTS business_members_guard ON business_members;
CREATE TRIGGER business_members_guard
  BEFORE INSERT OR UPDATE ON business_members
  FOR EACH ROW EXECUTE FUNCTION business_members_reject_owner_member();


-- ─── 5. sales / sale_items / stock_logs : lecture pour le client ──
-- Ces trois policies ont été créées SANS clause FOR, ce qui vaut FOR ALL. Leur
-- prédicat est `user_id = get_business_owner_id()`, qui pour un employé
-- renvoie le PATRON : l'employé passait donc dans le USING comme dans le
-- WITH CHECK, et pouvait faire UPDATE et DELETE sur les ventes de la boutique.
-- Effacer la journée, effacer sa propre trace dans le journal des stocks —
-- depuis le navigateur, avec la seule clé anon.
--
-- Les policies RLS s'additionnent (OR) et ne se remplacent pas : il faut
-- bien DROP l'ancienne, sinon elle reste en place.
--
-- Aucune écriture client n'existe sur sales ni sale_items — tout passe par
-- create_sale(), record_credit_sale() et pay_customer_debt(), toutes en
-- SECURITY DEFINER. Ces fonctions tournent en propriétaire des tables et
-- contourneront donc la RLS ; le client n'a besoin que du SELECT.
--
-- stock_logs, lui, EST écrit par le client (réapprovisionnement,
-- inventaire). L'INSERT reste ouvert, mais sous le même garde-fou que les
-- dépenses et les dettes : can_manage_products(). Il est déjà exigé par
-- products_update, donc rien qui marchait ne cesse de marcher.

DROP POLICY IF EXISTS "user_sales" ON sales;
DROP POLICY IF EXISTS "user_sales_select" ON sales;
CREATE POLICY "user_sales_select" ON sales
  FOR SELECT USING (user_id = get_business_owner_id());

DROP POLICY IF EXISTS "user_sale_items" ON sale_items;
DROP POLICY IF EXISTS "user_sale_items_select" ON sale_items;
CREATE POLICY "user_sale_items_select" ON sale_items
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM sales
      WHERE sales.id = sale_items.sale_id
        AND sales.user_id = get_business_owner_id()
    )
  );

DROP POLICY IF EXISTS "user_stock_logs" ON stock_logs;
DROP POLICY IF EXISTS "user_stock_logs_select" ON stock_logs;
CREATE POLICY "user_stock_logs_select" ON stock_logs
  FOR SELECT USING (user_id = get_business_owner_id());

DROP POLICY IF EXISTS "user_stock_logs_insert" ON stock_logs;
CREATE POLICY "user_stock_logs_insert" ON stock_logs
  FOR INSERT WITH CHECK (
    user_id = get_business_owner_id()
    AND can_manage_products()
  );
-- Ni UPDATE ni DELETE : le journal des stocks est inaltérable. Une correction
-- se fait par un nouveau mouvement, jamais en réécrivant l'ancien.


-- ─── 6. Suppression de compte : deux blocages de bout en bout ──
-- Relevés dans les logs Auth (source `auth_logs`), qui nomment les deux causes
-- au mot près.
--
-- a) `GET /admin/users` → 500 « converting NULL to string is unsupported »
--    GoTrue lit confirmation_token dans un string Go non nullable : NULL lève
--    une erreur, '' passe. Un compte créé par le formulaire d'inscription a
--    '' ; un compte inséré à la main dans auth.users a laissé les colonnes jeton
--    à NULL. Une seule ligne suffisait : la liste des comptes ET la fiche d'un
--    compte devenaient illisibles, donc leur suppression depuis le Dashboard
--    aussi. Le PATCH ne touche que les lignes incomplètes.
--
-- b) `DELETE /admin/users/{id}` → 500 « delete on table "products" violates
--    foreign key constraint "sale_items_product_id_fkey" »
--    La suppression d'un compte remonte en cascade vers products AVANT sales
--    (l'ordre suit celui de création des contraintes, soit products avant sales
--    dans schema.sql). products partait donc quand sale_items le référençait
--    encore, et NO ACTION renvoyait l'erreur.
--    Rien n'est assoupli : la règle de suppression reste NO ACTION. Seule la
--    VÉRIFICATION est différée à la fin de la transaction, où sale_items a
--    disparu via sale_id (déjà en CASCADE). Une suppression isolée d'un produit
--    reste donc refusée, exactement comme avant.
--
-- Rejouable : COALESCE ne réécrit rien quand la valeur est déjà correcte, et
-- ALTER CONSTRAINT réappliqué sur la même valeur ne change rien.

UPDATE auth.users
   SET confirmation_token      = COALESCE(confirmation_token, ''),
       recovery_token          = COALESCE(recovery_token, ''),
       email_change_token_new  = COALESCE(email_change_token_new, ''),
       email_change            = COALESCE(email_change, '')
 WHERE confirmation_token IS NULL
    OR recovery_token IS NULL
    OR email_change_token_new IS NULL
    OR email_change IS NULL;

ALTER TABLE sale_items
  ALTER CONSTRAINT sale_items_product_id_fkey DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE stock_logs
  ALTER CONSTRAINT stock_logs_product_id_fkey DEFERRABLE INITIALLY DEFERRED;
