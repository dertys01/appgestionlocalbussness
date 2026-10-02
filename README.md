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
| 10 | `migration_price_override.sql` | Prix négocié par ligne, `sale_items.list_price` |
| 11 | `migration_weighted_sales.sql` | Quantités décimales, `products.unit` |
| 12 | `migration_credit.sql` | `sales.settled`, `customer_debts`, `credit_payments` |
| 12b | `migration_plan_gate.sql` | `current_org_plan()`, `require_feature()`, `get_units_sold_since()` |
| 12c | `migration_partial_payment.sql` | `sales.amount_received`, trigger de remplissage |
| 12d | `migration_beta_program.sql` | dix places bêta, triggers d'attribution |
| 13 | `migration_profitability.sql` | Coût figé à la vente, `get_product_profitability()`, archivage |
| 14 | `migration_expenses.sql` | Tables `expenses` / `expense_categories`, `get_cash_flow()` |
| 15 | `migration_invitations.sql` | `employee_invitations`, `redeem_invitation()` |
| 16 | `migration_profitability_fix.sql` | Remplit les `unit_cost` manquants, recrée le trigger |
| 17 | `migration_suppliers.sql` | `suppliers`, `products.supplier_id`, `products_with_supplier` |
| 18 | `migration_credit_fns.sql` | `record_credit_sale()`, `pay_customer_debt()`, `get_customer_debts()` |
| 19 | `migration_security.sql` | RLS sur `rate_limits`, verrou de `organizations.plan`, index unique de `subscriptions`, policies de `business_members` |

`migration_security.sql` **doit fermer la série** : elle réécrit ce que les
migrations précédentes ont posé (policies de `business_members`, garde de
`redeem_invitation` par déclencheur). La placer avant laisserait les failles
revenir à la migration suivante.

`APPLY_MIGRATIONS.sql` concatène les 22 migrations pour partir d'une base
vide. Sur une base existante, appliquer la seule migration concernée.

`migration_partial_payment.sql` crée `sales.amount_received`, donc elle doit
précéder `migration_profitability.sql` et `migration_expenses.sql`, qui lisent
cette colonne. Son remplissage teste l'existence de `credit_payments` : sur une
base neuve il n'a rien à faire, sur une base réelle il reconstitue la répartition
des versements en FIFO.

**L'ordre des migrations qui redéfinissent `create_sale()` est significatif.**
Trois fichiers le font, en versions successives :

| Fichier | Apporte |
|---|---|
| `migration_sales_rpc.sql` | version initiale, quantités entières |
| `migration_price_override.sql` | prix négocié par ligne |
| `migration_weighted_sales.sql` | **quantités décimales — doit rester en tête** |

Un `CREATE OR REPLACE` réécrit la fonction **en entier**. Rejouer
`migration_sales_rpc.sql` après `migration_weighted_sales.sql` réinstalle donc
silencieusement la version à quantités entières : la colonne reste numérique
mais 1,5 kg est refusé avec « Ligne de panier invalide ». C'est ce que le test
de rejouabilité a révélé ; il remet maintenant la dernière version de chaque
fonction après avoir tout rejoué, et vérifie que `create_sale()` est bien revenue
à la forme décimale.

`migration_weighted_sales.sql` doit aussi précéder
`migration_profitability.sql` (colonne `list_price`) et suivre
`migration_price_override.sql` (dont elle reprend le prix négocié).

**Les 22 migrations sont rejouables** : `IF NOT EXISTS` sur les tables et les
index, `DROP … IF EXISTS` avant chaque policy, chaque trigger et chaque fonction
dont la signature a changé.

Deux tests distincts, parce qu'ils ne vérifient pas la même chose :

- `test:db` part d'une base **neuve** et vérifie le comportement ;
- `test:db:existing` rejoue toute la série **sur une base déjà peuplée**, puis
  **sur une base ramenée à la version précédente** — le cas réel d'un
  `APPLY_MIGRATIONS.sql` collé sur un projet existant.

### Le test de rejouabilité a une limite qu'il ne peut pas franchir

Rejouer le **même** fichier ne prouve qu'une chose : que le fichier est
idempotent. La signature de `get_customer_debts()` y est identique à chaque
passage, donc rien ne peut mal tourner.

Le risque réel est ailleurs : une fonction dont le `RETURNS TABLE` a changé
**entre deux versions**. Le premier passage crée la forme nouvelle, le second la
retrouve — jamais l'ancienne. Et la base de l'utilisateur, elle, a bien
l'ancienne. C'est arrivé sur l'acompte : `get_customer_debts()` a gagné une
colonne `total_paid`, 42P13 a interrompu le script au milieu, et **le test était
vert**.

`test:db:existing` simule donc le déploiement réel : il remet les fonctions dans
leur forme d'avant, rejoue la série complète, et vérifie que la forme nouvelle a
bien pris et que l'ancienne a disparu. Vérifié par `git stash` : sans le
`DROP FUNCTION`, ce test reproduit exactement l'erreur de production.

### Ce qu'un test de migration ne peut pas voir

Une base neuve et une base rejouée partagent la même propriété : **elles sont
produites par le fichier**. Le cas réel est une base produite par le fichier
**précédent**. Toute divergence entre les deux versions échappe donc aux deux
premiers tests.

C'est le trou le plus structurel de cette chaîne, et il n'est pas fermé
complètement : le test simule les changements connus, pas ceux qu'on n'a pas
encore écrits.

Quatre refus de PostgreSQL à connaître, tous rencontrés par l'expérience :

| Code | Cause | Correctif |
|---|---|---|
| 42P07 | `CREATE TABLE` sur une table existante | `IF NOT EXISTS` |
| 42710 | `CREATE POLICY` / `CREATE TRIGGER` déjà présents | `DROP … IF EXISTS` avant |
| **42P13** | **`CREATE OR REPLACE FUNCTION` dont le `RETURNS TABLE` a changé** | **`DROP FUNCTION` avant** |
| **0A000** | **`ALTER COLUMN TYPE` sur une colonne utilisée par une vue** | **`DROP VIEW` avant** |

Les deux derniers sont les plus piégeux. Pour 42P13, les paramètres `OUT` font
partie de la signature : **ajouter une colonne à un `RETURNS TABLE` exige de
supprimer la fonction**. Et l'erreur interrompt le script au milieu — les
`GRANT` et les `COMMENT` qui suivent ne sont jamais appliqués, et la fonction
reste celle d'avant. Pour 0A000, PostgreSQL refuse de changer le type d'une
colonne dont dépend une vue — et l'ordre des fichiers masque le problème, puisque
la vue est créée par une migration *suivante*.

La même règle vaut pour un **paramètre ajouté** : `record_credit_sale()` a reçu
`p_advance`. `CREATE OR REPLACE` crée alors une *surcharge*, et l'ancienne
version à quatre arguments reste. PostgREST sert alors l'ancienne, et le client
ne voit jamais son champ. Le `DROP FUNCTION` de l'ancienne arité est
indispensable — `test:db:existing` le vérifie.

Un script qui analyse toutes les fonctions à `RETURNS TABLE` permet de détecter
le premier cas avant de le subir.

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

## Périodes et affichage

Les écrans Ventes, Rapports et Charges partagent un sélecteur unique
(`src/components/ui/PeriodPicker.tsx`, logique dans `src/lib/utils/period.ts`) :
7 jours, 30 jours, 90 jours, 6 mois, 1 an, plus un choix libre de dates. Toute
période est ramenée à un an au maximum, et au plafond du plan
(`salesHistoryDays`) s'il est plus bas — un compte Free ne voit proposer que
7 et 30 jours.

Les bornes sont incluses des deux côtés. Une période est calculée en heure
locale puis rendue en `YYYY-MM-DD` : un `toISOString()` direct décale la
journée autour de minuit, ce qui, sur un an, fausse le rapport.

L'histogramme des Rapports se regroupe selon l'amplitude — par jour jusqu'à un
mois, par semaine jusqu'à quatre mois, par mois au-delà. 365 barres
journalières sont illisibles sur un téléphone, et un mois sans vente laisserait
un trou dans le graphique.

Deux listes sont rendues par tranches plutôt qu'en entier : les produits de la
caisse (60 par tranche, `PRODUCT_PAGE_SIZE`) et les charges (50 par tranche,
« Afficher plus »). La recherche porte toujours sur la liste entière, pas sur la
tranche affichée ; le scanner cherche dans `products` complet et ajoute donc
correctement un produit hors écran.

## Programme bêta : dix comptes en accès complet

Pour tester en conditions réelles, avec des gens qui ne sont pas le
développeur. Un prix qui ne s'affiche pas sur un petit écran, un libellé que
personne ne comprend, un geste que la caissière ne fait pas parce qu'il n'y est
pas : aucun test automatique ne voit cela.

### Un budget de places, pas un code

Le mécanisme est un compteur, pas un code d'accès à distribuer. Il n'y a donc
rien à trouver, et le onzième compte s'inscrit normalement, en gratuit. Une fois
les dix places prises, le programme est fermé et le comportement redevient
exactement celui d'une inscription ordinaire.

C'est aussi pour ça qu'aucune date d'expiration n'a été mise : une date non
appliquée par un trigger planifié est pire qu'aucune date, parce qu'on croit que
l'accès s'arrêtera tout seul. Le budget se ferme par une commande explicite, donc
ce qui est promis est ce qui se produit.

### Un trigger, parce qu'il y a trois chemins d'inscription

`/api/register`, la page `/register` en deux étapes, et l'onboarding de la page
d'accueil créent chacun une organisation. Les modifier tous serait trois endroits
à tenir d'accord — et le quatrième chemin, oublié, donnerait un compte gratuit
sans qu'on le voie. Le trigger `trg_beta_claim_slot` est le seul point par où
passe toute création de boutique, donc il s'applique partout, y compris aux
chemins qu'on n'a pas prévus. **Aucune modification de l'application n'a été
nécessaire.**

Le travail est partagé par deux triggers, et ce n'est pas un détail de style :
`beta_access` référence `organizations`, donc la ligne doit exister avant d'y
écrire. Un seul trigger `BEFORE` — le plus naturel, puisque c'est lui qui modifie
`NEW.plan` — violerait la clé étrangère à chaque inscription.

L'attribution est atomique : un seul `UPDATE … WHERE slots_used < slots_total`,
et non un `SELECT` suivi d'un `UPDATE`. Deux inscriptions simultanées lisent
toutes deux `slots_used = 9` ; PostgreSQL reverifie la condition après avoir pris
le verrou de ligne, donc la seconde ne consomme rien. Le plafond reste exact sous
concurrence, sans `SERIALIZABLE` ni réessai.

### Le testeur ne peut pas élargir son propre accès

`beta_program` et `beta_access` sont en RLS forcée, sans aucune policy : seul le
trigger, en `SECURITY DEFINER`, écrit dedans. À noter pour qui écrit des tests
ici — un `UPDATE` refusé par la RLS **ne lève pas d'erreur**, la ligne est
simplement filtrée et le compte de lignes modifiées vaut 0. C'est ce compte qui
prouve le blocage, pas l'absence d'erreur.

`supabase/BETA_SUIVI.sql` est la boîte à outils : état du programme, liste des
testeurs et de leurs retours, qui n'a pas encore testé, et les boutiques les
plus utilisées. Les colonnes `avis` / `bugs` / `manques` de `beta_access`
existent pour accumuler les retours au fil de l'eau — sans elles, l'information
se perd dans des messages privés et ne sert à rien.

Commandes : `close_beta_program()`, `set_beta_slots(n)`, `revoke_all_beta()`,
`beta_status()`.

## Numéro de facture : unique par boutique

Le compteur (`organizations.invoice_counter`) appartient à une boutique, mais
l'index d'unicité portait sur la seule colonne `invoice_number`. Les deux
premières boutiques Pro de la plateforme produisaient donc toutes deux
« FAC-2026-00001 », et la seconde se faisait **refuser sa vente** : sa caisse
était morte. Un client payant incapable d'encaisser.

L'unicité est désormais `(user_id, invoice_number)`. Ce n'est pas seulement un
choix technique : la numérotation des factures est une séquence par
contribuable, pas par pays. Deux commerces différents ont chacun leur première
facture au numéro 1, et c'est légal.

Le `DROP INDEX` qui précède est nécessaire — `CREATE UNIQUE INDEX IF NOT EXISTS`
ne remplace pas un index déjà présent, il en laisse un second, et la correction
ne s'appliquerait jamais sur une base existante.

## Verrou de plan

Le menu affiche un cadenas sur Rapports, Prévisions et Dettes. Ce cadenas ne
protègeait **rien** : c'est un test dans le navigateur, contournable en appelant
la fonction en RPC depuis la console. La clé anon est publique — elle est dans
le bundle JS. Un client en plan gratuit obtenait sa rentabilité, son résultat net
et son carnet de dette sans payer. Un concurrent, ou un client qui garde un onglet
ouvert depuis un essai terminé, avait le même chemin.

`migration_plan_gate.sql` déplace la décision dans la base : `current_org_plan()`
lit `organizations.plan`, `require_feature()` refuse l'appel si le plan ne suit
pas. Les mêmes quotas sont donc appliqués en deux endroits — le client pour
afficher des cadenas, la base pour décider. C'est la base qui tranche.

Ce qui est verrouillé :

| Fonctionnalité | Plan requis |
|---|---|
| `get_product_profitability()` | Starter |
| `get_cash_flow()` | Starter |
| `get_customer_debts()` | Starter |
| `get_units_sold_since()` | Pro |

Ce qui ne l'est **pas**, volontairement : la caisse, le stock, les ventes,
l'équipe, les invitations. Un client gratuit doit pouvoir vendre — c'est
l'application. Verrouiller la caisse décourage, et un commerce arrêté ne demande
jamais d'upgrade. Les charges restent saisissables pour la même raison : seul le
résultat net est masqué, pas la liste des dépenses.

Un appel sans utilisateur résolu (clé `service_role`, script d'administration,
migration) n'est pas un client gratuit : c'est un contexte de confiance, et il
passe. Le rôle `anon` n'a aucun droit d'exécution sur ces fonctions.

### Prévisions : autant de performance que de sécurité

Le module Prévisions lisait `sale_items` ligne à ligne et additionnait les
quantités en JavaScript. Il ramenait donc **toutes les lignes de vente des 90
derniers jours** dans le navigateur d'un client en plan gratuit — le chiffre
d'affaires, jour par jour, produit par produit. `get_units_sold_since()` déplace
l'agrégat en base : le client reçoit une ligne par produit, et le refus de plan
protège les données, pas seulement l'affichage.

## Acompte : payer une part, devoir le reste

« Laisse-moi 50 000 sur 130 000 » est le geste le plus courant d'une boutique de
quartier — plus courant que le crédit total. Le choix « Crédit » signifiait
100 % à découvert : le commerçant devait soit encaisser tout et inventer un
montant, soit laisser une dette plus grosse que la réalité. Aucune des deux
n'était exploitable.

### Une seule colonne décide de tout

`sales.amount_received` porte ce qui est **réellement rentré**. Le chiffre
d'affaires vaut `SUM(amount_received)`, sans exception. Il n'existe plus aucun
filtre « vente encaissée ou non » dans les rapports : un rapport en base de
caisse n'a pas besoin de savoir si une vente est soldée, seulement ce qu'elle a
rapporté.

| Vente | `amount_received` | Au chiffre d'affaires |
|---|---|---|
| Espèces, 130 000 | 130 000 | 130 000 |
| Crédit sans acompte, 130 000 | 0 | 0 |
| Crédit avec acompte de 50 000 | 50 000 | 50 000 |
| Règlement de 80 000 plus tard | 130 000 | 130 000 |

La caisse et le chiffre d'affaires ne peuvent donc pas diverger. C'est la
propriété qui compte, et elle est vérifiée par test.

La marge est reconnue au prorata — le ratio `amount_received / total_amount`
s'applique au chiffre d'affaires comme au coût. Reconnaître la recette sans son
coût ferait monter la marge à chaque vente à crédit, ce qui est l'inverse de la
réalité. Le **taux** de marge, lui, est insensible au prorata : le ratio
s'annule, donc une vente à moitié payée affiche le vrai taux du produit.

### Le solde est vrai par construction

`reste dû = SUM(total_amount - amount_received)` sur les ventes ouvertes. Plus
aucune répartition de versements à reconstituer, donc plus rien qui puisse
diverger entre ce que la fonction calcule et ce que la fonction affiche.
`credit_payments` reste l'historique — date, moyen de paiement, acompte — mais
plus l'état de la dette.

Le FIFO distribue chaque versement sur la vente la plus ancienne, en prenant
`total_amount - amount_received` : un acompte déjà versé est donc déduit, et
deux versements de 8 000 puis 12 000 soldent une vente de 20 000 comme un seul
de 20 000.

### Un trou que seule la base pouvait fermer

`amount_received` vaut 0 par défaut — c'est la seule valeur correcte pour un
crédit. Mais une insertion directe en SQL (import, script de reprise, migration
future) ne passe pas par `create_sale()`, et laissait donc une vente espèces
payée à 0 : **elle disparaissait du chiffre d'affaires sans lever la moindre
erreur**. Le trigger `fill_amount_received()` rattrape l'oubli, sans changer le
défaut et sans toucher au crédit, dont le montant dépend de l'acompte — seul
`record_credit_sale()` sait de combien il est.

`VERIFIER.sql` surveille ce trigger : c'est le point le plus silencieux de la
migration, donc celui qu'il faut regarder.

## Crédit client

« Je te dois 5 000, tu me paieras au prochain marché » représente une part
considérable du chiffre d'affaires d'une boutique de quartier. L'écran
**Dettes** suit ce carnet, que le papier ne permettait pas de contrôler.

### Recette à l'encaissement

Une vente à crédit **n'entre pas** dans le chiffre d'affaires tant qu'elle n'est
pas réglée. C'est le choix prudent : un CA gonflé par des dettes qu'on ne
recouvrera pas donne une fausse lecture de la santé du commerce, et l'écran
« Charges » calcule un résultat net à partir de ce chiffre. Un commerçant qui
accorde 200 000 F de crédit se verrait ruiner sur le papier.

Le **stock, lui, part immédiatement** : la marchandise quitte la boutique, et
Prévisions doit savoir qu'elle n'est plus là. `sales.settled` sépare les deux —
`FALSE` = les unités sont parties, l'argent n'est pas rentré.

Conséquence assumée : les dettes n'apparaissent dans aucun rapport financier.
Elles ont leur écran, et `get_product_profitability()` expose
`unsettled_credit` comme chiffre purement informatif.

`DEFAULT TRUE` sur la colonne est volontaire : toutes les ventes existantes sont
cash ou MoMo, donc encaissées. Sans ce défaut, le changement ferait disparaître
tout l'historique du chiffre d'affaires.

### Le client est son numéro

Le téléphone est la clé d'identité, pas le nom — « Maman Koffi » se mariera.
`normalize_phone()` réduit à l'indicatif pays : `+229 97 00 00 01`,
`22997000001` et `97000001` désignent la même fiche. Sans cela, un client
saisi de deux façons aurait deux dettes, et le commerçant croirait avoir deux
débiteurs.

Une vente à crédit **exige** un nom et un téléphone : sans numéro la dette est
orpheline et la relance WhatsApp impossible.

### Encaissement FIFO

`pay_customer_debt()` solde les ventes les plus anciennes d'abord, et accepte
le règlement partiel — la norme. La trésorerie disponible est le **cumul** des
versements, pas le montant du dernier appel : deux versements de 8 000 et
12 000 doivent solder une vente de 20 000, que le commerçant encaisse en une
fois ou en trois.

Le verrou est posé sur la fiche client, pas sur chaque ligne de vente. Un
`FOR UPDATE` dans un `FOR … LOOP` PL/pgSQL n'itère pas sur la snapshot
attendue — vérifié, l'`UPDATE` ne se fait pas.

`create_sale()` **refuse** `payment_method = 'credit'` : un appel direct créerait
une vente comptée comme encaissée, sans dette derrière. Seul `record_credit_sale()`
passe, via un GUC `credit.internal` qu'un client SQL ordinaire ne peut pas
poser.

Les versements ne sont jamais supprimables : effacer un encaissement ferait
réapparaître une dette que le commerçant croyait perdue.

## Vente au poids

`quantity`, `stock_qty`, `min_stock_level` et les trois colonnes de `stock_logs`
passent en `NUMERIC(12,3)`. Au Bénin tout se vend au poids — le riz, l'huile, le
sucre, le lait en poudre. Un commerçant qui ne peut pas enregistrer 1,2 kg sort
son téléphone pour rien, et la vente part en espèces hors de l'application.

`products.unit` accompagne la quantité pour que l'écran affiche « 1,2 kg » et
non « 1,2 ». L'unité n'affecte aucun calcul : la quantité reste un nombre dans
l'unité du produit, et les prix restent unitaires dans cette unité.

**La virgule décimale est acceptée.** Un clavier de téléphone au Bénin saisit
« 1,2 » autant que « 1.2 » ; sans conversion préalable, `::numeric` échoue et la
vente est refusée pour une raison invisible.

**Un produit vendu en sachet et au kilo doit être deux produits.** C'est le
choix classique des petites caisses. L'alternative — deux unités et un facteur
de conversion — double la surface d'erreur pour un besoin rare.

Le `ALTER COLUMN TYPE` est gardé par un test sur le type courant : le refaire
échoue en « cannot alter type of a column used by a view or rule », puisque
`get_product_profitability()` référence déjà la colonne.

## Prix négocié

Une ligne de panier porte un prix unitaire **convenu**. Le prix catalogue n'est
plus imposé — c'était un blocage, pas une protection : dans un marché de rue,
« c'est le dernier prix » est la règle, et un commerçant qui ne peut pas
modifier un prix vend en espèces, hors de l'application.

Le prix catalogue est conservé dans `sale_items.list_price`, ce qui rend chaque
remise traçable. C'est la traçabilité qui remplace le verrou, pas l'inverse : le
risque réel d'un prix transmis par le client n'est pas un client malveillant,
c'est une caisse qui cache du chiffre.

**La vente à perte est autorisée.** Bloquer un prix inférieur au prix d'achat
empêcherait d'écouler un stock aging, qui est précisément le moment où le
commerçant en a besoin. Elle est signalée : avertissement en caisse,
`units_sold_at_loss` en rentabilité, `at_loss_count` dans la réponse de
`create_sale()`.

Refusés : prix nul, négatif ou non numérique (une vente gratuite n'a pas de
sens marchand), et deux prix différents pour le même article dans le même panier
— ambigu, et prendre le minimum ou le maximum permettrait de fabriquer un panier
truqué.

`get_product_profitability()` expose `avg_sold_price` (prix moyen réellement
encaissé), `discount_given` (total concédé) et `units_sold_at_loss`.

## Fournisseurs

D'où vient la marchandise. Trois usages, par ordre d'importance : retrouver le
prix d'achat du mois dernier, savoir qui appeler quand un stock baisse, repérer
une dépendance excessive à un seul grossiste.

**Un fournisseur par produit**, et non une table de liaison : `products.price_buy`
est unique, donc un article a un fournisseur principal. Si un jour un même article
arrive à deux prix selon le fournisseur, ce sont deux articles.

`products.supplier_id` est en `ON DELETE SET NULL` — supprimer un grossiste ne
doit jamais supprimer les articles qui en dépendent, seulement les orphelins de
fournisseur. Même arbitrage que l'archivage produit.

**Un fournisseur ne peut pas être rattaché d'une autre boutique.** La RLS de
`products` protège le produit, pas le fournisseur qu'il référence : sans
contrôle, un patron écrivait l'UUID d'un fournisseur d'autrui et la vue
`products_with_supplier` le lui affichait. Le trigger
`check_product_supplier_tenant()` compare les deux `user_id` — un `CHECK` ne
peut pas consulter une autre table.

La vue est en `security_invoker` : l'isolation vient de la RLS de `products` et
`suppliers`, et non d'une vue qui la contournerait.

**Ce que ce n'est pas** : ni registre de conformité MECeF/DGI, ni comptabilité
fournisseurs. Aucun montant d'achat, aucune échéance, aucun règlement n'est
enregistré. Pour l'informel, le relevé de prix et le carnet suffisent ; la
facture normalisée reste le chantier à part, non traité.

## Inviter un employé

Le patron saisit une adresse email et reçoit un lien à transmettre ; l'employé
ouvre ce lien et **choisit son propre mot de passe**. Le patron ne connaît donc
jamais ce mot de passe : il ne peut ni le transmettre sur un canal non chiffré,
ni l'oublier.

Le lien est `/invitation/<token>`, avec un jeton de 32 octets aléatoires
expirant après 7 jours. Le partage WhatsApp est proposé depuis l'écran
d'invitation : c'est le canal que la cible utilise déjà.

`redeem_invitation()` fait foi. Elle est `SECURITY DEFINER` parce que l'appelant
n'est pas encore membre de l'équipe, et elle :

- refuse un jeton inconnu, révoqué, expiré ou déjà consommé (`FOR UPDATE` sérialise
  deux usages simultanés du même lien) ;
- **vérifie que le compte correspond à l'email invité** — sans cela, un lien
  intercepté suffirait à s'attribuer la boutique ;
- refuse un rôle ou un nom vide.

`purge_accepted_invitations()` nettoie les invitations consommées ; elle n'est
pas branchée, il faut l'appeler périodiquement (pg_cron ou à la main).

L'ancien `POST /api/employees` a été supprimé : il demandait au patron de fixer
le mot de passe de son employé. `GET /api/employees` et
`DELETE /api/employees/[id]` sont inchangés.

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

**L'ordre des migrations est une dépendance de code, pas seulement de tables.**
`migration_profitability.sql` ajoute `sale_items.unit_cost` et pose un trigger
qui interdit de le modifier ensuite, mais elle **ne redéfinit pas
`create_sale()`**, qui vit dans `migration_sales_rpc.sql`. Si la version
déployée de la fonction précède l'ajout de la colonne, chaque vente insère une
ligne sans coût — et le trigger interdit ensuite toute correction.

Le symptôme est discret : Rentabilité affiche « coût 0 F », marge brute égale au
CA, taux 100 %, un tiret dans la colonne %. Un produit sans prix d'achat
donnerait 0, **jamais NULL** : le NULL prouve que la colonne n'était pas
fournie.

Après toute modification de `create_sale()`, réappliquez
`migration_sales_rpc.sql`. Détection :

```sql
SELECT count(*) FILTER (WHERE unit_cost IS NULL) AS sans_cout, count(*) AS total
FROM sale_items;
```

`migration_profitability_fix.sql` remplit l'existant avec le prix d'achat
**actuel** — exact pour des ventes de test, approximatif sur une boutique avec
de l'antériorité.

**Le rate limiting de `src/proxy.ts` ne fonctionne pas en serverless.** Le
compteur vit en mémoire ; sur Vercel chaque instance est isolée et repart vide.
Il protège `next dev` et les déploiements Node à instance unique. `/api/register`
utilise `bump_rate_limit()` (table Postgres) et est réellement limité. Pour un
vrai rempart sur les routes proxy : `@upstash/ratelimit` + Redis.

**`salesHistoryDays` est appliqué côté client.** Le filtre borne la requête, mais
un appel direct à l'API Supabase avec la clé anon peut contourner la limite. Un
déploiement strict demanderait la même contrainte en RLS ou via une vue.

**Les features `reports` et `forecast` sont verrouillées en base, pas
seulement par l'interface.** `require_feature()` est appelée par
`get_product_profitability()`, `get_cash_flow()`, `get_customer_debts()` et
`get_units_sold_since()` — voir « Verrou de plan » plus haut. En revanche
`salesHistoryDays` n'existe que dans le client : borne la requête, mais un appel
direct à l'API avec la clé anon passe outre.

**`organizations.plan` n'est écrit que par Stripe.** `migration_security.sql`
pose un déclencheur qui refuse toute modification de la colonne venant des rôles
`anon` et `authenticated`, et retire au client le privilège de la *citer* dans un
`INSERT` ou un `UPDATE`. C'est ce qui empêchait de passer en Pro depuis la
console : `current_org_plan()`, `require_feature()`,
`check_product_limit()` et la facturation Pro lisent tous cette colonne.

Ne réintroduisez donc **jamais** `plan:` dans un `insert()` ou un `update()`
client : l'écriture part de `src/app/api/stripe/webhook/route.ts`, en service
role. `TEST_ACTIVER_PRO.sql`, lui, se lance depuis le SQL Editor (rôle
`postgres`), que le déclencheur laisse passer.

Deux conséquences pratiques à connaître :

- **`bump_rate_limit()` doit rester en SECURITY DEFINER.** La table
  `rate_limits` n'a plus aucune policy — c'est voulu, sans elle n'importe quel
  client pouvait la vider et repasser à l'inscription illimitée. Seules les
  fonctions y accèdent.
- **Un compte qui possède déjà sa boutique ne peut pas rejoindre une autre
  équipe.** Le déclencheur `business_members_guard` le refuse, et
  `/api/employees/[id]` ne supprime **plus** le compte Auth du membre — tous les
  ON DELETE CASCADE partent de `auth.users`, la suppression détruisait la
  boutique entière du membre.

## Scripts

```bash
npm run dev          # serveur de développement
npm run build        # build de production
npm run start        # démarre le build
npm run lint         # ESLint
npm run test:db      # tests des migrations (Postgres embarqué)
npm run test:period  # tests de l'arithmétique des périodes
npm test             # les deux suites
```
