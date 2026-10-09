-- ============================================================
-- migration_realtime.sql — temps réel multi-caisses (Supabase Realtime)
-- À exécuter dans Supabase SQL Editor, APRÈS migration_ca_caisse.sql
-- ============================================================
--
-- POURQUOI : deux caisses du même commerce (patron + employé, ou deux
-- téléphones) partagent le stock et les ventes. Sans temps réel, chaque
-- appareil ne voit les ventes de l'autre qu'après un rechargement manuel. Le
-- client s'abonne à `products` et `sales` via src/lib/hooks/useRealtimeRefresh.ts
-- et relit la base à chaque changement — la base reste la seule source de
-- vérité.
--
-- CE QUE FAIT CETTE MIGRATION : ajouter `products` et `sales` à la publication
-- `supabase_realtime`, sans quoi le serveur Realtime n'émet aucun événement
-- pour ces tables. Rien d'autre : ni policy, ni privilège, ni données.
--
-- LA RLS EST RESPECTÉE : Supabase Realtime évalue les policies avec l'identité
-- de l'abonné (son JWT). Un abonné ne reçoit donc que les lignes qu'il peut
-- déjà lire — le filtre `user_id` côté client n'est qu'une optimisation.
--
-- INERTE PAR DÉFAUT : la partie client n'ouvre aucun canal tant que
-- NEXT_PUBLIC_REALTIME ne vaut pas « 1 ». Cette migration peut donc être
-- appliquée sans rien activer.
--
-- Rejouable : le bloc ne fait rien si la publication n'existe pas (harnais
-- PGlite) ou si la table y est déjà.
-- ============================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime'
         AND schemaname = 'public'
         AND tablename = 'products'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.products;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime'
         AND schemaname = 'public'
         AND tablename = 'sales'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.sales;
    END IF;
  END IF;
END $$;
