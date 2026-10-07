-- ============================================================
-- MIGRATION TÉLÉPHONE BÉNIN À 10 CHIFFRES — GestionLocal
-- À exécuter dans Supabase SQL Editor, après migration_onboarding_mode.sql
--
-- LE DÉFAUT
--   Depuis le 30 novembre 2024, les numéros mobiles béninois ont 10 chiffres :
--   « 01 » devant les 8 chiffres d'avant (97 00 00 01 → 01 97 00 00 01).
--   normalize_phone() ne préfixait l'indicatif 229 qu'aux numéros à 8 chiffres :
--   un numéro saisi au format actuel était enregistré « 0197000001 », sans
--   indicatif. Le bouton « Relancer » ouvrait alors wa.me/0197000001, que
--   WhatsApp ne reconnaît pas — la relance d'une dette échouait pour tout
--   client inscrit avec son numéro d'aujourd'hui.
--
-- LA RÈGLE
--   8 chiffres                  → 229 + numéro (ancien format, encore saisi)
--   10 chiffres commençant par 01 → 229 + numéro (format actuel)
--   le reste                    → inchangé (déjà international)
--
-- Le numéro reste la clé du client dans customer_debts (UNIQUE user_id, phone) :
-- la même règle doit s'appliquer à l'écriture ET aux lignes déjà en base, sinon
-- le même client aurait deux fiches selon le jour où il a été saisi.
-- ============================================================

-- Même signature et même type de retour que migration_credit_fns.sql :
-- CREATE OR REPLACE suffit.
CREATE OR REPLACE FUNCTION normalize_phone(p_phone text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_digits text;
BEGIN
  v_digits := regexp_replace(COALESCE(p_phone, ''), '[^0-9]', '', 'g');

  IF v_digits = '' THEN
    RETURN NULL;
  END IF;

  -- 8 chiffres = ancien numéro local béninois.
  IF length(v_digits) = 8 THEN
    v_digits := '229' || v_digits;
  -- 10 chiffres en 01 = numéro béninois actuel, saisi sans indicatif.
  ELSIF length(v_digits) = 10 AND left(v_digits, 2) = '01' THEN
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


-- ─── Les numéros déjà enregistrés ──────────────────────────
--
-- Un client n'est corrigé que si la boutique n'a PAS déjà une fiche au format
-- international pour ce numéro : renommer la seconde violerait l'unicité, et
-- fusionner deux fiches (versements, historique) ne se fait pas en silence.
-- Ces cas restent tels quels ; le lien WhatsApp, lui, ajoute l'indicatif côté
-- application, donc la relance fonctionne quand même.
--
-- Les ventes d'abord, la fiche ensuite : get_customer_debts() rapproche les
-- deux par (user_id, numéro). Dans une même instruction, c'est la condition
-- NOT EXISTS sur la fiche cible qui décide, pour les deux tables.
-- Rejouable : une seconde exécution ne trouve plus rien à corriger.
UPDATE sales s
   SET client_phone = '229' || s.client_phone
 WHERE s.client_phone ~ '^01[0-9]{8}$'
   AND NOT EXISTS (
     SELECT 1 FROM customer_debts d
      WHERE d.user_id = s.user_id AND d.phone = '229' || s.client_phone
   );

UPDATE customer_debts d
   SET phone = '229' || d.phone
 WHERE d.phone ~ '^01[0-9]{8}$'
   AND NOT EXISTS (
     SELECT 1 FROM customer_debts x
      WHERE x.user_id = d.user_id AND x.phone = '229' || d.phone
   );
