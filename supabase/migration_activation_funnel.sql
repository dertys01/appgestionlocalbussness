-- ============================================================
-- MIGRATION — Mesure du parcours d'activation — GestionLocal
-- À exécuter dans Supabase SQL Editor, après migration_telephone_benin.sql
--
-- POURQUOI
--   Le pilote se pilote avec des chiffres : inscrits → assistant terminé →
--   première vente → ventes en semaine 2 → ventes en semaine 4. C'est la
--   mesure P3 de l'évaluation marketing : sans elle, on décide du plafond
--   gratuit, du prix et du mode hors ligne à l'aveugle, et le bilan du
--   vendredi du pilote devient une impression.
--
-- CE QU'ELLE FAIT
--   get_activation_funnel(p_from, p_to, p_now) renvoie UNE LIGNE par
--   boutique dont la date d'inscription LOCALE tombe dans [p_from, p_to] :
--
--     onboarding_done / onboarding_step   où s'est arrêté l'assistant
--     first_sale_at                       la première vente, quel que soit le jour
--     sales_week2 / sales_week4           ventes de la 2ᵉ / 4ᵉ semaine de vie,
--                                         en jours LOCAUX de la boutique :
--                                         [d0+7, d0+14) et [d0+21, d0+28)
--     mature_week2 / mature_week4         la fenêtre est-elle entièrement
--                                         écoulée depuis p_now ?
--
--   Le marqueur de maturité n'est pas un détail : une boutique inscrite
--   hier n'a pas de semaine 2, et sans ce marqueur elle compterait comme
--   « pas active » — le taux descendrait tout seul à mesure qu'on
--   enregistre des inscriptions, pour la seule raison qu'elles sont
--   récentes. Le script scripts/funnel.mjs divise donc par le nombre de
--   boutiques ÉVALUABLES, pas par le total.
--
--   Le jour se compte dans le fuseau de la boutique (Africa/Porto-Novo par
--   défaut), pas en UTC : une vente passée à 23 h 30 UTC sur un comptoir
--   béninois est déjà le lendemain pour celui qui tient le cahier.
--
-- SÉCURITÉ
--   La mesure lit TOUTES les boutiques — c'est son but. Ni la clé anon ni
--   un commerçant connecté ne doivent pouvoir l'appeler : elle est
--   réservée au service_role et à postgres (SQL Editor, scripts/), qui
--   travaillent hors RLS. SECURITY INVOKER par défaut : aucune porte
--   supplémentaire n'est ouverte, l'appelant reste soumis aux droits qu'il
--   a sur les tables.
--
-- Rejouable : CREATE OR REPLACE, REVOKE et GRANT sont idempotents.
-- ============================================================

CREATE OR REPLACE FUNCTION get_activation_funnel(
  p_from date,
  p_to date,
  p_now timestamptz DEFAULT now()
)
RETURNS TABLE (
  org_id          uuid,
  org_name        text,
  org_created_at  timestamptz,
  org_timezone    text,
  plan            text,
  onboarding_done boolean,
  onboarding_step text,
  first_sale_at   timestamptz,
  sales_week2     integer,
  sales_week4     integer,
  mature_week2    boolean,
  mature_week4    boolean
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH cohort AS (
    SELECT o.id,
           o.name,
           o.created_at,
           o.timezone,
           o.plan,
           o.onboarding_done,
           o.onboarding_step,
           (o.created_at AT TIME ZONE o.timezone)::date AS d0
      FROM organizations o
     WHERE (o.created_at AT TIME ZONE o.timezone)::date BETWEEN p_from AND p_to
  )
  SELECT c.id,
         c.name,
         c.created_at,
         c.timezone,
         c.plan,
         c.onboarding_done,
         c.onboarding_step,
         -- La première vente sert à l'étape « première vente » du parcours :
         -- elle n'appartient à aucune fenêtre, on la cherche telle quelle.
         (SELECT MIN(s.created_at)
            FROM sales s WHERE s.user_id = c.id),
         -- 2ᵉ semaine de vie : jours locaux [d0+7, d0+14).
         (SELECT COUNT(*)::integer
            FROM sales s
           WHERE s.user_id = c.id
             AND (s.created_at AT TIME ZONE c.timezone)::date >= c.d0 + 7
             AND (s.created_at AT TIME ZONE c.timezone)::date <  c.d0 + 14),
         -- 4ᵉ semaine de vie : jours locaux [d0+21, d0+28).
         (SELECT COUNT(*)::integer
            FROM sales s
           WHERE s.user_id = c.id
             AND (s.created_at AT TIME ZONE c.timezone)::date >= c.d0 + 21
             AND (s.created_at AT TIME ZONE c.timezone)::date <  c.d0 + 28),
         (c.d0 + 14 <= (p_now AT TIME ZONE c.timezone)::date),
         (c.d0 + 28 <= (p_now AT TIME ZONE c.timezone)::date)
    FROM cohort c
   ORDER BY c.created_at;
$$;

-- Lecture transverse : réservée à ceux qui travaillent hors RLS.
-- Le REVOKE sur authenticated n'est pas un excès de prudence — sans lui,
-- la fonction naît Granted à authenticated (ALTER DEFAULT PRIVILEGES de
-- Supabase, maintenu par migration_security.sql section 7), et un
-- commerçant pourrait appeler la mesure des autres.
REVOKE ALL ON FUNCTION get_activation_funnel(date, date, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_activation_funnel(date, date, timestamptz)
  TO service_role;
