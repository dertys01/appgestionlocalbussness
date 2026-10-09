# Exploitation — supervision, sauvegardes, incidents

Ce document ne remplace pas `SECURITY.md` (qui porte la sécurité et le runbook
de déploiement). Il décrit comment savoir que la production va bien, et quoi
faire quand elle ne va pas.

## Sonde de disponibilité

`GET /api/health` répond :

| Réponse | Sens |
|---|---|
| `200 { "ok": true, "db": true }` | l'application ET la base répondent — le commerce peut vendre |
| `503 { "ok": false, "db": false }` | la base (ou la config) est injoignable |

Aucune donnée métier, aucun secret : uniquement des booléens et un horodatage.
À brancher sur un superviseur (UptimeRobot, Better Stack, Vercel Checks…), avec
une alerte sur `503`.

## Sauvegardes

La base vit chez Supabase (`lmygvpruffpspixrsixh`). Ce qu'il faut retenir :

- **Plan payant** : sauvegardes automatiques quotidiennes + *Point-in-Time
  Recovery* (PITR) sur les plans supérieurs. C'est la seule restauration
  granulaire ; à vérifier dans *Database → Backups*.
- **Plan gratuit** : pas de PITR. La seule protection est un **export manuel
  régulier** (Dashboard → Database → Backups, ou `pg_dump` via la chaîne de
  connexion). À faire au minimum une fois par semaine si le plan est gratuit.
- **Ce qui n'est PAS sauvegardé** : rien côté application. Les clés Vercel,
  `NEXT_PUBLIC_PLANS_CONFIG` et les secrets vivent dans Vercel — ils doivent
  être notés ailleurs (gestionnaire de mots de passe), pas seulement là.

> Un export non testé n'est pas une sauvegarde. Une fois par trimestre,
> restaurez un export sur un projet Supabase de test et vérifiez qu'une vente,
> une dette et un produit sont bien là.

## Supervision

| Source | Ce qu'elle voit |
|---|---|
| **Sentry** (`sentry.*.config.ts`) | erreurs client et serveur, traces (10 %) |
| **Vercel** | builds, fonctions serverless, logs d'exécution |
| **Supabase** | logs PostgREST/Auth, activité base, *Database → Query Performance* |
| **`/api/health`** | disponibilité synthétique (à brancher sur un uptime) |

Sentry est activé uniquement en production (`enabled: NODE_ENV === 'production'`).
Le rejeu de session masque tout le texte (`maskAllText`) : aucune donnée
commerçant ne part dans un replay.

## Temps réel (Supabase Realtime)

Le temps réel (`NEXT_PUBLIC_REALTIME=1`) ouvre **une connexion WebSocket par
onglet ouvert**. À surveiller :

- **Connexions simultanées** : Dashboard → Realtime → *Connections*. Un pic
  anormal (beaucoup d'onglets, ou des reconnexions en boucle) se voit ici.
- **Facturation** : Realtime est facturé au message et à la connexion. Si le
  coût grimpe, réduire le périmètre (ne diffuser que `products` et `sales`).
- **Si les écrans ne se rafraîchissent plus** : vérifier que la publication
  `supabase_realtime` contient toujours `products` et `sales` (voir
  `migration_realtime.sql`) — `SELECT tablename FROM pg_publication_tables
  WHERE pubname = 'supabase_realtime'`.

## File hors-ligne

Les ventes encaissées sans réseau vivent dans **IndexedDB**, sur l'appareil du
commerçant — donc **par navigateur, par appareil**. Si un appareil est effacé
avant la synchronisation, ces ventes sont perdues (elles n'ont jamais atteint
le serveur). Le bandeau « N ventes en attente » est le seul signal : il ne doit
jamais rester affiché durablement. Si un rejeu échoue (stock insuffisant), la
vente **reste** dans la file — elle n'est jamais avalée en silence.

## Incidents — réflexes

1. **La caisse ne répond plus** : `/api/health` (503 = base/config), puis logs
   Vercel, puis Dashboard Supabase (projet en pause ?).
2. **Une clé privileged fuite** : voir `SECURITY.md`, section « Si une clé
   privileged fuite un jour » (révoquer d'abord, le reste est de la propreté).
3. **Déployer une mise à jour** : suivre l'ordre non négociable de `SECURITY.md`
   (migrations → `sync:plans` → variables Vercel → push). Les migrations sont
   appliquées par `node scripts/supabase-sql.mjs supabase/<fichier>.sql`.
