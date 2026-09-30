# GestionLocal — ERP/POS multi-tenant

Application de gestion commerciale (caisse, stock, équipe, rapports) pour petites
boutiques, avec abonnements Stripe. Supabase (Postgres + Auth + RLS) comme
socle de données, Next.js 16 en App Router.

## Démarrage

```bash
npm install
cp .env.local.example .env.local   # puis renseigner les clés
npm run dev
```

## Variables d'environnement

| Variable | Rôle |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | URL du projet Supabase |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Clé anon (côté navigateur) |
| `SUPABASE_SERVICE_ROLE_KEY` | Clé service role — **serveur uniquement**, contourne la RLS |
| `NEXT_PUBLIC_APP_URL` | Origine publique, utilisée par Stripe pour les redirections |
| `STRIPE_SECRET_KEY` | Clé Stripe serveur |
| `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_PRO` | Identifiants de prix pour le checkout |
| `STRIPE_WEBHOOK_SECRET` | Signature du webhook Stripe |
| `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_ORG`, `SENTRY_PROJECT`, `SENTRY_AUTH_TOKEN` | Sentry |

> `src/lib/supabase/client.ts` lit l'URL et la clé anon depuis des constantes
> en dur plutôt que `process.env`. C'est une clé publique par nature, mais la
> remplacer suppose une modification de code : à basculer sur `NEXT_PUBLIC_*`
> pour pouvoir faire tourner le projet sur un autre Supabase.

## Base de données

Les migrations sont des fichiers SQL appliqués dans l'éditeur Supabase, dans
cet ordre. Elles ne sont pas versionnées automatiquement : c'est le premier
point à vérifier après un `git pull`.

| Ordre | Fichier | Rôle |
|---|---|---|
| 1 | `schema.sql` | Tables `products`, `sales`, `sale_items`, `stock_logs` + RLS initiale |
| 2 | `migration_team.sql` | `business_members`, `activity_logs`, `get_business_owner_id()` |
| 3 | `migration_saas.sql` | `organizations`, `subscriptions` |
| 4 | `migration_plan_limits.sql` | Trigger de limite de produits |
| 5 | `migration_invoices.sql` | Champs de facturation |
| 6 | `migration_webhook_logs.sql` | `webhook_events` |
| 7 | `migration_indexes.sql` | Index |
| 8 | `migration_sales_rpc.sql` | `create_sale()`, `bump_rate_limit()`, CHECK stock |
| 9 | `migration_roles.sql` | Séparation des droits employé / patron |
| 10 | `migration_profitability.sql` | Coût figé à la vente, `get_product_profitability()`, archivage |
| 11 | `migration_expenses.sql` | Tables `expenses` / `expense_categories`, `get_cash_flow()` |

> `migration_team.sql` doit précéder `migration_saas.sql` : la policy
> « Employé lit l'org de son patron » référence `business_members`.
> `migration_profitability.sql` doit suivre `migration_sales_rpc.sql` :
> `create_sale()` écrit `sale_items.unit_cost`.

### Tests

```bash
npm run test:db
```

Le harnais applique les 9 migrations sur un Postgres réel (PGlite, WASM) puis
vérifie le comportement : atomicité de `create_sale`, cas de stock insuffisant,
isolation entre organisations, droits employé/patron, rate limiting. C'est le
seul moyen fiable de valider du SQL avant de le pousser en production — un
parser ne valide ni les policies RLS ni les corps PL/pgSQL.

## Modèle de données

`organizations.id` est l'`auth.users.id` du patron : il sert d'identifiant de
tenant. Les employés sont liés via `business_members` (owner_id → member_id), et
`get_business_owner_id()` fait le pont côté RLS.

```
organizations ──┬── products.user_id
                ├── sales.user_id
                ├── stock_logs.user_id
                └── business_members.owner_id ──→ member_id (auth.users)
```

Un membre appartient à un seul business (index unique sur `member_id`).

## Rôles

| Capacité | Employé | Manager | Patron |
|---|---|---|---|
| Encaisser une vente | ✓ | ✓ | ✓ |
| Lire le catalogue, l'inventaire | ✓ | ✓ | ✓ |
| Créer / modifier / archiver un produit | ✗ | ✓ | ✓ |
| Réapprovisionner, ajuster un inventaire | ✗ | ✓ | ✓ |
| Inviter des employés | ✗ | ✗ | ✓ |
| Facture normalisée, rapports, prévisions | selon le plan | selon le plan | selon le plan |

## Rentabilité

`Rapports → Rentabilité` affiche CA, coût des marchandises, marge brute et taux
de marge par produit, via la fonction `get_product_profitability()`.

C'est une fonction `SECURITY INVOKER` et non une vue, volontairement : une vue
PostgREST s'exécute avec les droits de son propriétaire et contourne la RLS, ce
qui obligerait à dupliquer la règle de tenancy dans la requête. Ici l'isolation
est celle de `products`, donc une seule source de vérité.

Deux règles à connaître :

- **`sale_items.unit_cost` est figé à la vente.** Un trigger refuse sa
  modification. Sans ce snapshot, la marge d'hier se recalculait avec le prix
  d'achat d'aujourd'hui — silencieusement fausse.
- **Un produit vendu ne peut pas être archivé.** `archive_product()` le refuse
  et propose de le mettre en stock 0 puis de le renommer « … (épuisé) ». La
  suppression définitive échouerait de toute façon (FK `sale_items` /
  `stock_logs` sans `ON DELETE CASCADE`).

Un produit sans prix d'achat apparaît avec une marge de 100 % et un avertissement :
renseignez `price_buy` avant de conclure.

## Charges et résultat net

`Rapports → Charges` enregistre les dépenses (loyer, salaires, électricité…) et
croise le chiffre d'affaires avec elles via `get_cash_flow(from, to)`.

- Le plan de comptes est **par organisation** et seedé à la première visite
  (11 catégories par défaut). `seed_expense_categories()` est idempotent.
- Un employé **lit** les charges mais ne les saisit pas (même règle que le
  catalogue). Le journal d'activité enregistre chaque saisie.
- Un montant négatif ou un libellé vide sont refusés en base (`CHECK`).
- `get_cash_flow()` ramène les ventes au jour **dans le fuseau de l'organisation**
  (`organizations.timezone`, repli `Africa/Porto-Novo`) : une vente de 23 h 30
  n'est pas datée au lendemain par erreur.

Le résultat net affiché ne comprend ni les salaires implicites (bénévole) ni
l'amortissement du stock. Tant qu'aucune charge n'est saisie, un bandeau le
rappelle : le résultat net vaut alors le CA, ce qui ne prouve rien.

La séparation est appliquée en base (`can_manage_products()`) et reflétée dans
l'interface via `canManageProducts`. Le rôle se règle dans `business_members.role`
(`'employee'`, `'manager'`).

## Email (réinitialisation de mot de passe)

Le reset de mot de passe ne fonctionne qu'avec un fournisseur SMTP configuré.
Sans lui, aucun email ne part et un client qui perd son accès est perdu.

**Supabase** → Authentication → **Emails** → *Configure email provider*

| Champ | Valeur |
|---|---|
| SMTP Host | `smtp.resend.com` |
| SMTP Port | `465` |
| SMTP Username | `resend` |
| SMTP Password | clé API Resend (permission *Sending access*) |
| From address | `onboarding@resend.dev` |

Aucune de ces valeurs ne transite par le code : la clé reste entre Resend et
Supabase, il n'y a donc rien à ajouter dans `.env.local` ni dans Vercel.

**Authentication** → **URL Configuration** — indispensable, sinon le lien de
récupération renvoie vers la page d'accueil au lieu de l'écran de nouveau mot
de passe :

| Champ | Valeur |
|---|---|
| Site URL | `https://appgestionlocalbussness.vercel.app` |
| Redirect URLs | `https://appgestionlocalbussness.vercel.app/reset-password` |

Puis *Emails* → *Templates* → activer **Reset password**.

Deux points à connaître :

- Activer un SMTP custom bride Supabase à **30 emails/heure**
  (Authentication → Rate Limits → *Email sent*). C'est une protection, pas un bug.
- `onboarding@resend.dev` ne livre qu'à l'adresse du compte Resend. Tester avec
  une adresse tierce exige un domaine vérifié dans Resend (SPF + DKIM + DMARC),
  seul moyen de débloquer des utilisateurs externes.

## Points d'attention

**Les ventes passent par `create_sale()`.** Ne réintroduisez pas d'insertion
directe dans `sales` / `sale_items` / `products` depuis le client : c'est ce qui
permaitait auparavant de décrémenter le stock de façon non atomique et de
présenter une vente partielle comme réussie. Le prix et le total sont recalculés
côté serveur ; le client n'envoie que `product_id` et `quantity`.

**Le rate limiting de `src/proxy.ts` ne fonctionne pas en serverless.** Le
compteur vit en mémoire ; sur Vercel chaque instance est isolée et repart vide.
Il protège `next dev` et les déploiements Node à instance unique. `/api/register`
utilise `bump_rate_limit()` (table Postgres) et est réellement limité. Pour un
vrai rempart sur les routes proxy : `@upstash/ratelimit` + Redis.

**`salesHistoryDays` est appliqué côté client.** Le filtre borne la requête, mais
un appel direct à l'API Supabase avec la clé anon peut contourner la limite. Un
déploiement strict demanderait la même contrainte en RLS ou via une vue.

**Les features `reports` et `forecast` sont verrouillées par l'interface
seule.** Ce sont des composants client qui interrogent Supabase directement :
un utilisateur hors plan peut les rendre par d'autres moyens.

## Scripts

```bash
npm run dev      # serveur de développement
npm run build    # build de production
npm run start    # démarre le build
npm run lint     # ESLint
npm run test:db  # tests des migrations (Postgres embarqué)
```
