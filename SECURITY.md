# Sécurité — à faire après incident

## Moment de la rotation

**Fin de projet** : ces opérations sont à faire après la stabilisation des
fonctionnalités — la purge force-pousse et invaliderait le rythme de commits
en cours. Dès que la prod devient réellement utilisée, la clé doit être tournée
avant tout le reste.

Les clés Supabase (anon **et service role**) ont été commitées en clair dans
l'historique git (commits antérieurs à `591c2e7` : « hardcode supabase
credentials as fallback », « hardcode service role key »). L'état courant du
code est propre, mais l'historique les contient toujours.

Actions requises, dans l'ordre :

1. **Révoquer et régénérer** la clé service role dans le dashboard Supabase
   (Settings → API). La clé anon peut rester si le projet est privé, mais la
   rotation reste conseillée.
2. Mettre à jour `.env.local` et les variables Vercel (`NEXT_PUBLIC_SUPABASE_URL`,
   `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
   `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `SENTRY_AUTH_TOKEN`).
3. Redéployer, puis purger l'historique (`git filter-repo`) ou reconsidérer
   le dépôt comme définitivement compromis. Ne JAMAIS force-pusher sans avoir
   d'abord tourné les clés.
4. La CI (`.github/workflows/ci.yml`, job `secrets`) exécute Gitleaks pour
   empêcher toute nouvelle fuite.

## Durcissements en place

- Rate limiting persistant (`bump_rate_limit`, table `rate_limits`) sur toutes
  les écritures des routes sensibles (`src/proxy.ts`).
- Webhook Stripe : signature vérifiée, idempotence atomique via
  `claim_webhook_event()` (`supabase/migration_webhook_claim.sql`).
- Les erreurs Supabase sont assainies avant journalisation
  (`sanitizeError`, `src/lib/utils/server.ts`) pour ne pas consigner les
  en-têtes `Authorization` (clé service role) dans les logs.
- RLS deny-by-default sur `rate_limits`, `webhook_events`, `beta_*` ;
  `organizations.plan` verrouillé par trigger + révocation de colonne.
