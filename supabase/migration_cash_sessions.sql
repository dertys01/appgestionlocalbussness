-- ============================================================
-- migration_cash_sessions.sql — sessions de caisse (fond, clôture, écart)
-- À exécuter APRÈS migration_ca_caisse.sql
-- ============================================================
--
-- POURQUOI : une caisse doit s'OUVRIR (avec un fond de caisse) et se CLÔTURER
-- (avec un comptage). Sans cela, un commerçant ne peut pas répondre à la seule
-- question qui compte en fin de journée : « j'ai compté tant, j'aurais dû avoir
-- combien ? ». La « base de caisse » (amount_received) existe déjà dans les
-- calculs de CA ; il manquait l'ouverture et la clôture explicites.
--
-- DEUX RPC, SECURITY DEFINER :
--   • open_cash_session(fond)     — refuse une seconde caisse ouverte ;
--   • close_cash_session(compte)  — calcule l'attendu, l'écart, et ferme.
--
-- L'ATTENDU est calculé EN BASE, jamais reçu du navigateur :
--   fond + encaissements ESPÈCES depuis l'ouverture.
-- Les encaissements espèces = ventes `payment_method='cash'` (amount_received)
-- + règlements `credit_payments.method='cash'` (acomptes et dettes). Une vente
-- à crédit n'est PAS en 'cash', et son acompte est déjà dans credit_payments :
-- aucun double compte.
--
-- LES CHARGES NE SONT PAS DÉDUITES : la table `expenses` n'a pas de moyen de
-- paiement — impossible de savoir si une charge a été payée en espèces depuis
-- le tiroir. On ne devine pas : l'écart reste « attendu vs compté », et le
-- commerçant l'explique par une note.
--
-- Rejouable : IF NOT EXISTS / DROP POLICY IF EXISTS / CREATE OR REPLACE.
-- ============================================================

CREATE TABLE IF NOT EXISTS cash_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  opened_at     timestamptz NOT NULL DEFAULT now(),
  opened_by     uuid NOT NULL,
  opening_float numeric(12,2) NOT NULL DEFAULT 0,
  closed_at     timestamptz,
  closed_by     uuid,
  counted_cash  numeric(12,2),
  expected_cash numeric(12,2),
  difference    numeric(12,2),
  note          text,
  CONSTRAINT cash_sessions_float_non_negative   CHECK (opening_float >= 0),
  CONSTRAINT cash_sessions_counted_non_negative CHECK (counted_cash IS NULL OR counted_cash >= 0)
);

-- Une seule caisse OUVERTE par boutique : deux caissiers ne doivent pas tenir
-- deux tiroirs « ouverts » en parallèle dans la même boutique.
CREATE UNIQUE INDEX IF NOT EXISTS ux_cash_sessions_ouverte
  ON cash_sessions(user_id) WHERE closed_at IS NULL;

ALTER TABLE cash_sessions ENABLE ROW LEVEL SECURITY;

-- Lecture : le patron ET ses employés (un caissier doit voir la caisse ouverte).
DROP POLICY IF EXISTS "cash_sessions_read" ON cash_sessions;
CREATE POLICY "cash_sessions_read" ON cash_sessions
  FOR SELECT USING (user_id = get_business_owner_id());

-- Aucune écriture client : les deux RPC SECURITY DEFINER s'en chargent, et
-- l'attendu/écart ne peut donc pas être forgé par le navigateur.
REVOKE INSERT, UPDATE, DELETE ON cash_sessions FROM anon, authenticated;


-- ─── Ouvrir la caisse ───────────────────────────────────────
CREATE OR REPLACE FUNCTION open_cash_session(p_opening_float numeric DEFAULT 0)
RETURNS cash_sessions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := get_business_owner_id();
  v_row   cash_sessions;
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Non authentifié' USING ERRCODE = '28000';
  END IF;
  IF p_opening_float IS NULL OR p_opening_float < 0 THEN
    RAISE EXCEPTION 'Le fond de caisse ne peut pas être négatif' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM cash_sessions WHERE user_id = v_owner AND closed_at IS NULL) THEN
    RAISE EXCEPTION 'Une caisse est déjà ouverte pour cette boutique' USING ERRCODE = '23514';
  END IF;

  INSERT INTO cash_sessions (user_id, opened_by, opening_float)
  VALUES (v_owner, auth.uid(), p_opening_float)
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION open_cash_session(numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION open_cash_session(numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION open_cash_session(numeric) TO service_role;

COMMENT ON FUNCTION open_cash_session(numeric) IS
  'Ouvre la caisse de la boutique avec un fond. Refuse une seconde caisse '
  'ouverte. SECURITY DEFINER : l''écriture n''est pas ouverte au navigateur.';


-- ─── Clôturer la caisse ─────────────────────────────────────
CREATE OR REPLACE FUNCTION close_cash_session(p_counted_cash numeric, p_note text DEFAULT NULL)
RETURNS cash_sessions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner   uuid := get_business_owner_id();
  v_row     cash_sessions;
  v_entrees numeric(12,2);
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Non authentifié' USING ERRCODE = '28000';
  END IF;
  IF p_counted_cash IS NULL OR p_counted_cash < 0 THEN
    RAISE EXCEPTION 'Le montant compté ne peut pas être négatif' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_row
    FROM cash_sessions
   WHERE user_id = v_owner AND closed_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Aucune caisse ouverte' USING ERRCODE = 'P0002';
  END IF;

  -- Encaissements ESPÈCES depuis l'ouverture. Ventes espèces + règlements
  -- espèces (acomptes de vente à crédit et dettes). Pas de double compte :
  -- une vente à crédit n'est pas en 'cash', son acompte est dans cp.
  SELECT COALESCE((
           SELECT SUM(s.amount_received) FROM sales s
            WHERE s.user_id = v_owner
              AND s.payment_method = 'cash'
              AND s.created_at >= v_row.opened_at
         ), 0)
       + COALESCE((
           SELECT SUM(cp.amount) FROM credit_payments cp
            WHERE cp.user_id = v_owner
              AND cp.method = 'cash'
              AND cp.created_at >= v_row.opened_at
         ), 0)
    INTO v_entrees;

  UPDATE cash_sessions
     SET closed_at     = now(),
         closed_by     = auth.uid(),
         counted_cash  = p_counted_cash,
         expected_cash = v_row.opening_float + v_entrees,
         difference    = p_counted_cash - (v_row.opening_float + v_entrees),
         note          = NULLIF(btrim(COALESCE(p_note, '')), '')
   WHERE id = v_row.id
   RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION close_cash_session(numeric, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION close_cash_session(numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION close_cash_session(numeric, text) TO service_role;

COMMENT ON FUNCTION close_cash_session(numeric, text) IS
  'Clôture la caisse ouverte : calcule l''attendu (fond + espèces encaissées '
  'depuis l''ouverture), l''écart avec le compté, et ferme. Les charges ne sont '
  'pas déduites (pas de moyen de paiement connu). SECURITY DEFINER.';
