-- ============================================================
-- migration_plan_definer.sql — les triggers de quotas lisent en propriétaire
--
-- BUG PROD (Sprint 19) : check_product_limit() et check_employee_limit()
-- lisent plan_config, table RÉVOQUÉE au navigateur. En SECURITY INVOKER
-- (le défaut), chaque création de produit et chaque invitation répondait
-- 403 « permission denied for table plan_config » en production : la
-- boutique ne pouvait plus ajouter d'article. Le harnais ne le voyait pas —
-- il s'exécute en superuser, insensible aux REVOKE (section 39 : les
-- triggers y sont désormais exercés en rôle authenticated).
--
-- SECURITY DEFINER : le trigger lit les quotas en propriétaire, comme
-- within_plan_history() le fait déjà pour la fenêtre d'historique. Le
-- contrôle reste le même (plan effectif, invitations en attente comptées,
-- fail-open sans ligne posée) ; seul le lecteur change. ALTER, pas
-- CREATE OR REPLACE : le corps est intact, seul le régime change.
-- ============================================================

ALTER FUNCTION check_product_limit() SECURITY DEFINER;
ALTER FUNCTION check_employee_limit() SECURITY DEFINER;

COMMENT ON FUNCTION check_product_limit() IS
  'Quota produits à l''INSERT : SECURITY DEFINER car plan_config est '
  'révoquée au navigateur — en INVOKER, chaque création répondait 403.';

COMMENT ON FUNCTION check_employee_limit() IS
  'Quota employés (invitations en attente comprises) : SECURITY DEFINER, '
  'même raison — une invitation répondait 403 au lieu du message de plan.';
