-- ============================================================
-- migration_offline_credit.sql — vente à CRÉDIT hors-ligne idempotente (P7)
-- À exécuter APRÈS migration_offline_sales.sql
-- ============================================================
--
-- POURQUOI : `record_credit_sale()` crée la vente PUIS la dette (customer_debts,
-- credit_payments). Un rejeu hors-ligne dont la réponse s'est perdue doit
-- renvoyer la vente ET la dette existantes, sans en créer de secondes. La
-- référence `client_ref` (migration_offline_sales.sql) est le support de cette
-- idempotence ; ici, elle est vérifiée AVANT toute écriture — dette comprise.
--
-- La signature passe de 6 à 7 arguments : on DROP l'ancienne, sinon les deux
-- coexistent et les appels deviennent ambigus.
--
-- Rejouable : DROP IF EXISTS / CREATE OR REPLACE.
-- ============================================================

DROP FUNCTION IF EXISTS record_credit_sale(jsonb, text, text, text, numeric, text);

CREATE OR REPLACE FUNCTION record_credit_sale(
  p_items          jsonb,
  p_client_name    text,
  p_client_phone   text,
  p_note           text          DEFAULT NULL,
  p_advance        numeric(12,2) DEFAULT 0,
  p_advance_method text          DEFAULT 'cash',
  p_client_ref     text          DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner    uuid;
  v_name     text;
  v_phone    text;
  v_avance   numeric(12,2);
  v_total    numeric(12,2);
  v_du       numeric(12,2);
  v_sale     jsonb;
  v_sale_id  uuid;
  v_debt_id  uuid;
  v_invoice  text;
BEGIN
  v_owner := get_business_owner_id();
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Non authentifié' USING ERRCODE = '28000';
  END IF;

  -- ── Idempotence : rejeu d'une vente à crédit hors-ligne ─────
  -- La vente ET la dette ont pu être créées lors d'une tentative précédente
  -- dont la réponse s'est perdue. On renvoie l'existant plutôt que d'ajouter
  -- une seconde dette au carnet du client.
  IF p_client_ref IS NOT NULL THEN
    SELECT s.id, s.total_amount, s.amount_received, s.invoice_number, s.client_phone
      INTO v_sale_id, v_total, v_avance, v_invoice, v_phone
      FROM sales s
     WHERE s.user_id = v_owner
       AND s.client_ref = p_client_ref
     LIMIT 1;
    IF v_sale_id IS NOT NULL THEN
      SELECT id INTO v_debt_id
        FROM customer_debts
       WHERE user_id = v_owner AND phone = v_phone;
      RETURN jsonb_build_object(
        'id',             v_sale_id,
        'total_amount',   v_total,
        'amount_advance', v_avance,
        'amount_due',     v_total - v_avance,
        'invoice_number', v_invoice,
        'debt_id',        v_debt_id,
        'client_phone',   v_phone
      );
    END IF;
  END IF;

  IF p_client_name IS NULL OR btrim(p_client_name) = '' THEN
    RAISE EXCEPTION 'Indiquez le nom du client' USING ERRCODE = '22023';
  END IF;
  v_name := btrim(p_client_name);

  v_phone := normalize_phone(p_client_phone);
  IF v_phone IS NULL THEN
    RAISE EXCEPTION 'Le numéro de téléphone est obligatoire pour une vente à crédit'
      USING ERRCODE = '22023';
  END IF;

  IF p_advance IS NULL OR p_advance < 0 THEN
    RAISE EXCEPTION 'L''avance versée ne peut pas être négative' USING ERRCODE = '22023';
  END IF;
  v_avance := p_advance;

  -- Le moyen n'est lu que s'il y a acompte : sans argent reçu, la ligne de
  -- versement n'existe pas. Même garde-fou que credit_payments_method_valid,
  -- mais levé AVANT create_sale() — le stock n'est pas encore sorti et la
  -- vente n'existe pas, donc rien à annuler.
  IF v_avance > 0
     AND (p_advance_method IS NULL OR p_advance_method NOT IN ('cash', 'momo')) THEN
    RAISE EXCEPTION 'Moyen de paiement de l''acompte invalide : %', p_advance_method
      USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('credit.internal', '1', true);
  v_sale := create_sale(p_items, 'credit', v_name, p_note, p_client_ref);
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
  --
  -- sale_id renseigné : l'acompte couvre CETTE vente, et sa part de caisse
  -- suit le moyen choisi à la vente — p_advance_method, plus « cash » déduit.
  IF v_avance > 0 THEN
    INSERT INTO credit_payments (debt_id, user_id, amount, day, method, note, sale_id)
    VALUES (v_debt_id, v_owner, v_avance, current_date, p_advance_method,
            'Acompte versé à la vente', v_sale_id);
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

REVOKE ALL ON FUNCTION record_credit_sale(jsonb, text, text, text, numeric, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_credit_sale(jsonb, text, text, text, numeric, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION record_credit_sale(jsonb, text, text, text, numeric, text, text) TO service_role;

COMMENT ON FUNCTION record_credit_sale(jsonb, text, text, text, numeric, text, text) IS
  'Vente à crédit. p_advance est l''acompte versé sur-le-champ (0 = crédit '
  'total), p_advance_method son moyen — cash ou momo, choisi à la vente. '
  'L''acompte compte au chiffre d''affaires le jour même, réduit la dette et '
  'ventile sa part de caisse selon ce moyen. Le stock part dans tous les cas. '
  'p_client_ref rend le rejeu hors-ligne idempotent : une référence déjà '
  'utilisée renvoie la vente et la dette existantes.';
