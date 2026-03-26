-- ============================================================
-- MIGRATION WEBHOOK LOGS — GestionLocal
-- A exécuter dans Supabase SQL Editor
-- Table pour tracer les événements Stripe reçus en prod
-- ============================================================

CREATE TABLE IF NOT EXISTS webhook_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id     text UNIQUE NOT NULL,
  event_type   text NOT NULL,
  org_id       text,
  status       text NOT NULL DEFAULT 'received',  -- received | processed | error
  error        text,
  received_at  timestamptz DEFAULT now()
);

ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;
-- Pas de lecture publique : accessible uniquement via service role key
