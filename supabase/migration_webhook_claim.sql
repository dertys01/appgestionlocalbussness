-- ============================================================
-- MIGRATION WEBHOOK CLAIM — GestionLocal
-- A exécuter dans Supabase SQL Editor, après migration_webhook_logs.sql
--
-- Idempotence du webhook Stripe : la lecture puis l'upsert de webhook_events
-- n'étaient pas atomiques. Deux livraisons concurrentes du même event_id
-- pouvaient toutes deux lire status <> 'processed' et retraiter l'événement
-- (double upsert d'abonnement, double changement de plan). claim_webhook_event
-- sérialise la prise en charge : un seul appelant gagne le droit de traiter.
-- ============================================================

CREATE OR REPLACE FUNCTION claim_webhook_event(
  p_event_id text,
  p_event_type text,
  p_org_id text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  claimed boolean;
BEGIN
  WITH upserted AS (
    INSERT INTO webhook_events (event_id, event_type, org_id, status)
    VALUES (p_event_id, p_event_type, p_org_id, 'processing')
    ON CONFLICT (event_id) DO UPDATE
      SET status = 'processing', error = NULL
      -- 'received' : tentative précédente interrompue avant le traitement.
      -- 'error'    : Stripe rejoue justement celui-là.
      -- 'processing' et 'processed' ne se reclaiment jamais : un appelant
      -- concurrent ou un événement déjà traité est court-circuité.
      WHERE webhook_events.status IN ('received', 'error')
    RETURNING 1
  )
  SELECT EXISTS(SELECT 1 FROM upserted) INTO claimed;
  RETURN claimed;
END;
$$;

REVOKE ALL ON FUNCTION claim_webhook_event(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_webhook_event(text, text, text) TO service_role;
