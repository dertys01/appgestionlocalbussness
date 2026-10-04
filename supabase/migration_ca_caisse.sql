-- ═══ Base de caisse : une seule définition du chiffre d'affaires ═══
--
-- Trouvé en recette navigateur le 04/10/2026 : deux écrans de la même
-- application, le même jour, la même boutique, deux chiffres d'affaires
-- différents — 42 300 F sur « Ventes » et « Rapports → Ventes », 34 300 F sur
-- « Rapports → Rentabilité ». L'écart valait exactement la dette non réglée.
--
-- La cause tient en une ligne : get_sales_summary() comptait
-- SUM(total_amount) — ce qui a été FACTURÉ — là où get_cash_flow() et
-- get_product_profitability() comptent SUM(amount_received), ce qui est
-- réellement ENCAISSÉ. Chacune des deux versions était justifiée dans son
-- fichier, et incompatible avec l'autre.
--
-- Ce qui tranche n'est pas une préférence : c'est une phrase que
-- l'application affiche déjà au commerçant, sur l'écran Dettes —
--
--   « Une vente à crédit n'entre pas dans le chiffre d'affaires : elle y
--     entre quand vous encaissez. Le stock, lui, est sorti dès la vente. »
--
-- Deux écrans sur trois contredisaient cette phrase. On aligne le troisième
-- sur elle. La base de caisse est aussi celle que la rentabilité et le
-- résultat net utilisaient déjà, et la seule qui ne bouge pas le jour où un
-- client paye trois semaines plus tard.
--
-- Rappel du choix, identique à celui de migration_expenses.sql : un règlement
-- encaissé aujourd'hui sur une vente d'hier est imputé à la DATE DE LA VENTE.
-- Rattacher au jour du versement donnerait un résultat net qui bouge un jour
-- où aucune vente n'a eu lieu — impossible à lire pour un commerçant, et sans
-- rapport avec ce que sa caisse contient réellement.


-- ─── 1. Les versements doivent dire QUELLE vente ils soldent ──────────────
--
-- Deuxième volet du même défaut, trouvé dans la même recette. Un règlement
-- de dette encaissé en espèces n'apparaissait dans AUCUN total : ni « Espèces »
-- ni « Mobile Money ». Le commerçant qui reçoit 8 000 F en liquide d'un client
-- voyait son chiffre d'affaires diminuer ce jour-là.
--
-- credit_payments ne portait que debt_id : rattacher un règlement à une vente
-- demandait de rejouer ici la répartition FIFO — un second calcul de la même
-- règle, qui divergerait à la première évolution de pay_customer_debt(). La
-- répartition est déjà faite dans cette fonction, vente par vente, à
-- l'instant où elle a lieu. Il suffisait de l'y écrire.
--
-- Une vente peut être soldée par plusieurs versements, et un versement peut
-- solder plusieurs ventes (les plus anciennes d'abord). D'où une ligne par
-- couple : amount est la part du règlement qui couvre CETTE vente, pas le
-- règlement entier.
--
-- gesture_id sert à retrouver le geste derrière ces lignes. L'écran Dettes
-- affiche « 3 ventes, 2 versements » : sans lui, un règlement qui solde trois
-- ventes d'un coup serait compté trois fois, et l'historique annoncerait au
-- client plus de passages en caisse qu'il n'en a fait. Une valeur par défaut
-- aléatoire donne une ligne par geste pour l'historique déjà en base — ce qui
-- est exact, ces gestes n'ayant jamais été ventilés.

ALTER TABLE credit_payments ADD COLUMN IF NOT EXISTS sale_id uuid
  REFERENCES sales(id) ON DELETE CASCADE;

ALTER TABLE credit_payments ADD COLUMN IF NOT EXISTS gesture_id uuid
  NOT NULL DEFAULT gen_random_uuid();

CREATE INDEX IF NOT EXISTS idx_credit_payments_sale ON credit_payments(sale_id)
  WHERE sale_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_credit_payments_gesture ON credit_payments(gesture_id);

COMMENT ON COLUMN credit_payments.sale_id IS
  'Vente que ce règlement solde. NULL = acompte à la vente antérieur à cette '
  'migration, ou versement supérieur à la dette (crédit restant au client). '
  'C''est ce lien qui permet de répartir un règlement en espèces ou en MoMo sur '
  'le jour de la vente — sans lui, l''argent reçu d''un client pour solder sa '
  'dette ne rattachait à aucun total de caisse.';

COMMENT ON COLUMN credit_payments.gesture_id IS
  'Identifiant du geste de caisse. Plusieurs lignes peuvent partager le même '
  'gesture quand un règlement solde plusieurs ventes : c''est un versement, '
  'ventilé. L''écran Dettes compte les DISTINCT gesture_id pour ne pas '
  'annoncer au client plus de versements qu''il n''en a faits.';


-- ─── 2. La synthèse, en base de caisse ────────────────────────────────────
--
-- Le type de retour ne change pas : CREATE OR REPLACE suffit, et les deux
-- appelants (Historique des ventes, Rapports) n'ont rien à modifier.
--
-- Les versements sont agrégés par vente AVANT la jointure, jamais dans une
-- sous-requête corrélée : sales.id n'est ni groupé ni agrégé, et Postgres
-- refuserait la requête. Un LEFT JOIN sur un CTE déjà réduit à une ligne par
-- vente donne le même résultat, sans dépendre du nombre de règlements.

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
  WITH bornes AS (
    SELECT (p_from::timestamp AT TIME ZONE p_tz) AS debut,
           ((p_to + 1)::timestamp AT TIME ZONE p_tz) AS fin
  ),
  ventes AS (
    SELECT s.id,
           (s.created_at AT TIME ZONE p_tz)::date AS jour,
           s.amount_received,
           s.payment_method
      FROM sales s, bornes b
     WHERE s.created_at >= b.debut
       AND s.created_at <  b.fin
  ),
  -- Une ligne par vente, pas par règlement : sans cela un client qui solde
  -- trois dettes en un geste compterait ses versements trois fois dans le
  -- chiffre d'affaires.
  reglements AS (
    SELECT cp.sale_id,
           COALESCE(SUM(cp.amount) FILTER (WHERE cp.method = 'cash'), 0) AS cash,
           COALESCE(SUM(cp.amount) FILTER (WHERE cp.method = 'momo'), 0) AS momo
      FROM credit_payments cp
     WHERE cp.sale_id IS NOT NULL
     GROUP BY 1
  )
  SELECT
    v.jour                                                  AS day,
    -- Ce qui est réellement rentré, pas ce qui a été facturé : amount_received
    -- est la seule colonne qui distingue « j'ai vendu 9 000 » de « j'ai reçu
    -- 1 000 maintenant ».
    COALESCE(SUM(v.amount_received), 0)                     AS revenue,
    -- Les deux parts sortent du même montant que le total, et les règlements de
    -- dettes s'y ajoutent par LEUR moyen : un client qui solde sa dette en
    -- espèces a bien donné des espèces. Avant, ce cash-là n'entrait nulle part,
    -- et les modes de paiement ne correspondaient pas au chiffre d'affaires
    -- affiché juste au-dessus — sur la même carte.
    COALESCE(SUM(v.amount_received) FILTER (WHERE v.payment_method = 'cash'), 0)
      + COALESCE(SUM(r.cash), 0)                           AS cash,
    COALESCE(SUM(v.amount_received) FILTER (WHERE v.payment_method = 'momo'), 0)
      + COALESCE(SUM(r.momo), 0)                           AS momo,
    COUNT(*)                                                AS tx
  FROM ventes v
  LEFT JOIN reglements r ON r.sale_id = v.id
  GROUP BY 1
  ORDER BY 1;
$$;

REVOKE ALL ON FUNCTION get_sales_summary(date, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION get_sales_summary(date, date, text) TO authenticated;
GRANT EXECUTE ON FUNCTION get_sales_summary(date, date, text) TO service_role;

COMMENT ON FUNCTION get_sales_summary(date, date, text) IS
  'Chiffre d''affaires en BASE DE CAISSE : somme de amount_received, pas de '
  'total_amount. Une vente à crédit n''y entre qu''à l''encaissement de ce qui a '
  'été versé, rattaché au jour de la vente. Même base que get_cash_flow() et '
  'get_product_profitability() — trois écrans ne doivent pas afficher trois '
  'chiffres pour la même journée. cash et momo incluent les règlements de '
  'dettes, par leur moyen de paiement.';


-- ─── 3. Les versements qui alimentent cette répartition ───────────────────
--
-- record_credit_sale() : l'acompte est versé À LA VENTE, il connaît donc la
-- vente qu'il couvre. pay_customer_debt() : c'est la boucle de répartition
-- qui sait, pour chaque tour, combien va à quelle vente.

CREATE OR REPLACE FUNCTION record_credit_sale(
  p_items        jsonb,
  p_client_name  text,
  p_client_phone text,
  p_note         text          DEFAULT NULL,
  p_advance      numeric(12,2) DEFAULT 0
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
BEGIN
  v_owner := get_business_owner_id();
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Non authentifié' USING ERRCODE = '28000';
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
  --
  -- sale_id renseigné : l'acompte couvre CETTE vente, et sa part de caisse doit
  -- suivre le moyen choisi au moment du paiement.
  IF v_avance > 0 THEN
    INSERT INTO credit_payments (debt_id, user_id, amount, day, method, note, sale_id)
    VALUES (v_debt_id, v_owner, v_avance, current_date, 'cash',
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

REVOKE ALL ON FUNCTION record_credit_sale(jsonb, text, text, text, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_credit_sale(jsonb, text, text, text, numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION record_credit_sale(jsonb, text, text, text, numeric) TO service_role;


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
  v_part         numeric(12,2);
  v_reglees      int := 0;
  v_sale         record;
  v_note         text;
  v_gesture      uuid := gen_random_uuid();
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
  -- Une simple somme de différences, juste par construction. La version
  -- précédente soustrayait un cumul de versements d'un cumul de prix, et
  -- reconstituait la répartition dans la boucle — deux calculs à tenir d'accord,
  -- donc une occasion de diverger. Ici il n'y a rien à reconstituer.
  SELECT COALESCE(SUM(s.total_amount - s.amount_received), 0) INTO v_avant
    FROM sales s
   WHERE s.user_id = v_owner AND s.client_phone = v_phone AND NOT s.settled;

  IF v_avant <= 0 THEN
    RAISE EXCEPTION 'Ce client n''a pas de dette en cours' USING ERRCODE = '22023';
  END IF;

  v_note := NULLIF(btrim(COALESCE(p_note, '')), '');

  -- Répartit le versement sur les ventes ouvertes, de la plus ancienne à la plus
  -- récente. Chaque vente reçoit ce qui lui manque, pas plus.
  --
  -- On boucle sur un curseur simple, sans FOR UPDATE : le verrou utile est posé
  -- sur la fiche client plus haut, ce qui sérialise deux caisses encaissant pour
  -- le même client. Verrouiller aussi chaque ligne ici n'apporte rien et, dans
  -- un FOR ... LOOP PL/pgSQL, n'itère pas sur la snapshot attendue.
  --
  -- Le reliquat porte aussi les acomptes déjà versés à la vente : c'est
  -- amount_received qui dit ce qui a été couvert, pas le montant de ce versement.
  -- C'est ce qui rend le calcul insensible à l'ordre des appels — deux versements
  -- de 8 000 puis 12 000 soldent une vente de 20 000, comme un seul de 20 000.
  --
  -- UN ENREGISTREMENT DE VERSEMENT PAR VENTE SOLDÉE, amount valant la part qui
  -- la couvre. C'est ce qui rattache l'argent reçu au bon jour et au bon moyen
  -- dans le chiffre d'affaires : avant, un règlement en espèces encaissé sur une
  -- dette n'entrait dans aucun total, et le jour où le client payait, la caisse
  -- du commerçant paraissait diminuer. Un geste peut donc donner plusieurs
  -- lignes — même montant, même note : un règlement, ventilé sur ce qu'il solde.
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
    IF v_du <= 0 THEN
      CONTINUE;
    END IF;

    IF v_restant >= v_du THEN
      v_part := v_du;
      UPDATE sales
         SET amount_received = total_amount,
             settled = true
       WHERE id = v_sale.id;
      v_restant := v_restant - v_du;
      v_reglees := v_reglees + 1;
    ELSE
      -- Paiement partiel : la vente reste ouverte, et ce reliquat devient du
      -- chiffre d'affaires encaissé dès aujourd'hui.
      v_part := v_restant;
      UPDATE sales SET amount_received = amount_received + v_restant WHERE id = v_sale.id;
      v_restant := 0;
    END IF;

    INSERT INTO credit_payments (debt_id, user_id, amount, day, method, note, sale_id, gesture_id)
    VALUES (p_debt_id, v_owner, v_part, current_date, p_method, v_note, v_sale.id, v_gesture);
  END LOOP;

  -- Ce qui dépasse la dette restant due reste au client. Enregistré sans
  -- sale_id : il ne solde aucune vente, et ne doit donc entrer dans aucun total.
  IF v_restant > 0 THEN
    INSERT INTO credit_payments (debt_id, user_id, amount, day, method, note, sale_id, gesture_id)
    VALUES (p_debt_id, v_owner, v_restant, current_date, p_method, v_note, NULL, v_gesture);
  END IF;

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


-- ─── 4. Le nombre de versements reste un nombre de gestes ─────────────────
--
-- La répartition ventile un règlement en une ligne par vente soldée.
-- get_customer_debts() comptait les LIGNES et affichait le résultat sous le
-- mot « versements » : un règlement soldant trois ventes serait annoncé au
-- client comme trois versements. Il compte désormais les gestes.
--
-- Cette fonction était définie par migration_credit_fns.sql, dont on ne
-- rejoue pas l'intégralité : seule la clause payments_count change.

CREATE OR REPLACE FUNCTION get_customer_debts()
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
      -- DISTINCT gesture_id, et non COUNT(*) : un règlement qui solde
      -- plusieurs ventes est ventilé en autant de lignes, et cet écran
      -- annonce « X versements » au client. Compter les lignes lui
      -- annoncerait plus de passages en caisse qu'il n'en a réellement faits.
      (SELECT COUNT(DISTINCT cp2.gesture_id) FROM credit_payments cp2
        WHERE cp2.debt_id = d.id) AS payments_count,
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


-- ─── 5. Les versements antérieurs sont rattachés à la vente qu'ils soldent ─
--
-- Sur une base déjà en service, credit_payments.sale_id est NULL partout. Le
-- chiffre d'affaires reste juste — il compte amount_received, renseigné depuis
-- migration_partial_payment.sql — mais les règlements passés n'entrent dans
-- aucune répartition par moyen de paiement. Ce manque ne se voit que sur
-- l'historique, se corrige à la prochaine saisie, et ne vaut pas un
-- inventaire.
--
-- Seuls les acomptes à la vente sont rattachables, et ils le sont sans
-- ambiguïté : la note le dit mot pour mot, et l'acompte a été versé LE JOUR DE
-- LA VENTE — c'est ce que signifie la note. D'où le rapprochement sur
-- (client, jour calendaire de la vente), en prenant la plus ancienne vente du
-- jour qui pouvait recevoir ce montant : c'est l'ordre FIFO que
-- pay_customer_debt() applique déjà.
--
-- Les règlements ordinaires, eux, ne sont PAS rattachés : sans trace de la
-- répartition à l'époque, il faudrait deviner, et une dette rattachée à la
-- mauvaise vente vaut moins qu'une dette dont la ventilation n'apparaît pas.
UPDATE credit_payments cp
   SET sale_id = (
     SELECT s.id
       FROM sales s
       JOIN customer_debts d ON d.id = cp.debt_id
      WHERE s.user_id = cp.user_id
        AND s.client_phone = d.phone
        AND (s.created_at AT TIME ZONE (
              SELECT o.timezone FROM organizations o WHERE o.id = s.user_id
            ))::date = cp.day
        AND s.amount_received >= cp.amount
      ORDER BY s.created_at ASC
      LIMIT 1
   )
 WHERE cp.sale_id IS NULL
   AND cp.note = 'Acompte versé à la vente';