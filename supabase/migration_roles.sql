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
