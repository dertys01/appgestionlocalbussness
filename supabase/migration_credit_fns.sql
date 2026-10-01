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
