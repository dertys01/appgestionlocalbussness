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
