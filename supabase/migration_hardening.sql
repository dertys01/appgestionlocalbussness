-- ============================================================
-- migration_hardening.sql — durcissement du schéma public (S-4)
-- À exécuter APRÈS migration_security.sql
-- ============================================================
--
-- S-4 : `anon` et `authenticated` ne doivent pas pouvoir CRÉER d'objets dans
-- le schéma public. Ce n'est pas exploitable directement aujourd'hui — les
-- fonctions SECURITY DEFINER figent leur `search_path = public` et les tables
-- qu'elles lisent existent déjà, donc rien ne peut être « shadowé ». Mais
-- c'est la deuxième moitié de la règle : un schéma où le client ne peut pas
-- écrire ne peut pas être détourné, même si une future fonction oubliait son
-- `search_path`.
--
-- Le rôle `postgres` (migrations, scripts) garde tous ses droits ; `service_role`
-- conserve les siens (GRANT explicites, non retirés par un REVOKE sur PUBLIC).
--
-- Rejouable : REVOKE est idempotent.
-- ============================================================

REVOKE CREATE ON SCHEMA public FROM anon, authenticated;
