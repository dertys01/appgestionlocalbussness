# Plan de développement — Sprints 1 à 4

## Provenance de ce document

Les Sprints 1 et 2 ont été exécutés et livrés. **Leur détail, lui, n'a jamais été écrit
nulle part** : vérifié le 03/10/2026, le mot « Sprint » n'apparaît dans aucun fichier de
toute l'historique git (`git log --all -S "Sprint"` → aucun commit). Il n'existait que dans
la conversation.

Les Sprints 3 et 4 ci-dessous sont donc une **reconstruction**, établie le 03/10/2026 à
partir de l'état réel du code et non d'un plan antérieur. Chaque chiffre est mesurable ;
chaque item a un critère de fin vérifiable.

---

## Où en est-on

### Terminé

| Sprint | Contenu | Commits |
|---|---|---|
| 1 + 2 | `SEC-1` → `SEC-8` (durcissement RLS, verrou de plan, suppression de compte) et `BUG-1` → `BUG-13` | `324e288` |
| — | Réparation de l'API Auth (jetons `auth.users` à `''`, FK `DEFERRABLE INITIALLY DEFERRED`) | `ab2aef0` |
| — | Rate limit de `src/proxy.ts` basculé sur `rate_limits` + `bump_rate_limit()` | `3a179dc` |
| — | Compteur d'inscription déplacé **après** la validation du corps | `8013458` |
| — | Faille `anon` close : **33 → 2** fonctions appelables par la clé publique | `3e8dbba` |
| 3 | 3.1 recharts chargé à la demande · 3.2 totaux de période en base + pagination · 3.3 contexte Supabase mémorisé · 3.4 code mort, lint à 0 warning | `9532ba8` `6cc277e` `980c6c9` `6efd2d3` |
| 4.1 | `page.tsx` découpé : **861 → 261 lignes**, 8 fichiers, aucun changement de comportement | `8a125ee` |
| — | Recette manuelle des 9 onglets : navigateur, 2 profils (propriétaire + caissier), **0 erreur JS** | `7e7627a` |
| 4.2 | Titres de onglet côté serveur : **3 layouts `metadata`**, `page.tsx` intacts (4/4 toujours client) | `c4ba478` |

**Reste dans le Sprint 4 :** 4.3 (24 `eslint-disable` dans 17 fichiers, au fil de l'eau).

**Recette manuelle des 9 onglets : faite** le 03/10/2026, navigateur, deux profils,
0 erreur JavaScript — détail en fin de section 4.1.

`supabase/migration_security.sql` porte les **7 sections** (1 `rate_limits` hors portée client ·
2 `organizations.plan` verrouillé · 3 `subscriptions` une ligne par org · 4 `business_members`
lecture seule · 5 `sales`/`sale_items`/`stock_logs` lecture seule · 6 suppression de compte ·
7 clé `anon` révoquée).

Vérifications de référence, à maintenir à chaque étape :
`npx tsc --noEmit` · `npm run lint` · `npm run build` · `npm test` — tous en **code de sortie 0**.

---

## Sprint 3 — Le poids mort : la performance avant les fonctionnalités

**Aucun SQL à coller** pour ce sprint entier. Une seule écriture SQL, en 3.2
(`migration_sales_summary.sql`) : les agrégats PostgREST sont désactivés sur ce projet
(`PGRST123` — `sum()` → `PGRST200`, `count()` → `PGRST123`), donc aucun total O(1) n'est
atteignable sans fonction. Appliquée par MCP, comme depuis `ab2aef0`. Tout le reste est du code.

### 3.1 Sortir recharts du bundle initial

**État :** `recharts` est importé **en ESM direct** dans `src/components/reports/ReportsModule.tsx:4-7`.
Un seul fichier de `src/` l'importe, mais `ReportsModule` est importé statiquement par
`src/app/page.tsx:442`, donc **la librairie de graphiques est téléchargée par chaque visiteur,
y compris ceux qui n'ouvrent jamais l'onglet Rapports**. `grep -rn "next/dynamic" src` → **0** :
aucun découpage dynamique n'existe nulle part dans le projet.

**À faire :** `next/dynamic` sur `ReportsModule` (aucun props au l.442, import simple).

**Fini quand :** `recharts` n'apparaît plus dans le chunk chargé au premier rendu, et
`npm run build` reste en 0.

### 3.2 Borner ce qui grandit sans limite

**État :** 30 appels `.select(` réels dans `src/`, **1 seul** `.limit(` (`ExpensesModule.tsx:152`)
et **1** `.range(` (`TeamModule.tsx:120`). 13 autres sont bornés par `.single()`/`.maybeSingle()`
et 3 par `head:true` — ce qui reste **12 téléchargements sans borne**.

Distinction à faire, sous peine de casser l'application :

| Nature | Exemples | Verdict |
|---|---|---|
| **Grandit à chaque vente, sans fin** | `SalesHistory.tsx:51` (`sales.select('*, sale_items(*)')`), `ReportsModule.tsx:49` (idem), `ExpensesModule.tsx:87` | **À borner** — le nested `sale_items(*)` multiplie encore les lignes |
| **Catalogue, naturellement borné** | `page.tsx:90` et `:107` (produits), `ForecastModule.tsx:61`, `SupplierSelect.tsx:37`, `expense_categories` | **À laisser** — le POS doit afficher tout le catalogue ; un `LIMIT` cassera la recherche |

**À faire :** pagination côté serveur (`.range()`) sur les trois requêtes de la première ligne,
ou agrégation en SQL pour `ReportsModule` plutôt que des `useMemo` sur l'intégralité des ventes
(`ReportsModule.tsx:75, 87, 100, 121`). La pagination de `SalesHistory` est aujourd'hui
**client-side** (`PAGE_SIZE = 20`, l.20) : elle n'affiche que 20 lignes, mais elle en **charge**
toutes.

**Fini quand :** sur une boutique de test avec 10 000 ventes, ouvrir l'historique et les rapports
ne télécharge plus que la période demandée, page par page.

**Fait le 03/10/2026 — `6cc277e`.**

- `migration_sales_summary.sql` : `get_sales_summary(p_from, p_to, p_tz)` renvoie **une ligne
  par jour de vente** (CA, part espèces, part Mobile Money, transactions) ; `get_top_products
  (p_from, p_to, p_tz, p_limit)` le top produits, plafonné à 100 lignes. Les deux en
  `SECURITY INVOKER` — la RLS isole les tenants toute seule.
- **Le fuseau du navigateur part en paramètre.** Le client découpe les journées avec
  `new Date().getDate()`, donc dans *son* fuseau, alors que SQL calcule dans celui de la
  session. Sans ce paramètre, chaque barre du graphique se serait décalée d'une case.
  Bornage exprimé en **instants** et non en dates, sinon `(created_at AT TIME ZONE ...)` ne
  serait pas sargable et Postgres relirait toute la table — on aurait déplacé le coût.
- `get_cash_flow()` **non réutilisée** : elle additionne `amount_received` (l'argent entré),
  les rapports additionnent `total_amount` (le prix de vente). Deux mesures justes,
  différentes ; les réutiliser l'une pour l'autre aurait fait bouger les chiffres affichés.
- `SalesHistory` : pagination serveur (`.range()` + `count: 'exact'`) et total de période
  agrégé en base. L'export CSV recupère de son côté **toutes** les lignes de la période —
  exporter la seule page visible au nom de la période entière serait un export tronqué en
  silence.
- `ReportsModule` : **zéro ligne de vente téléchargée**. Les quatre agrégats lisent la
  synthèse ; `salesByDay` ne fait plus que replacer les jours dans les seaux `bucketKey()`.
- Harnais : section 21, **8 assertions** d'équivalence stricte avec l'ancien calcul client
  (total, espèces, Mobile Money, transactions, découpage par jour, top produits, plafond,
  privilèges). `ALTER DEFAULT PRIVILEGES` ajouté au harnais pour reproduire ceux de
  Supabase — sans cela, l'assertion 21h passait en local **pour ne rien prouver**.
- Vérifié en production : `886 800 F` de CA, `744 800 F` d'espèces, 16 transactions,
  3 jours — identique au calcul SQL de référence.

**Faille `anon` relevée pendant la 3.2, corrigée dans la foulée.** **33 des 35** fonctions du
schéma public répondaient à la seule clé publique du navigateur — dont **20 en
`SECURITY DEFINER`**, qui traversent la RLS. Vérifié par appel réel et sans jeu de mots :
`beta_status()` répondait à la clé anonyme alors que la migration la réserve au
`service_role`, et `close_beta_program()` — `SECURITY DEFINER` **sans aucune garde** —
aurait permis de fermer le programme bêta pour toutes les boutiques, `set_beta_slots()`
de le rouvrir.

**Corrigée** — section 7 de `migration_security.sql`, appliquée en production le 03/10/2026.
Deux mécanismes, et il a fallu traiter les deux :

- Supabase accorde `EXECUTE` à `anon` **au moment de la création** de chaque fonction
  (`ALTER DEFAULT PRIVILEGES`) : le grant vient du rôle, donc un `REVOKE ... FROM
  PUBLIC`, écrit partout dans les migrations, ne lui retire rien.
- PostgreSQL accorde par ailleurs `EXECUTE` à `PUBLIC` sur toute fonction dont l'ACL n'a
  pas été touchée, et `anon` en hérite. C'était le cas de **12 fonctions**
  (`update_updated_at`, `check_product_limit`, `purge_rate_limits`…), sans aucun
  `REVOKE` dans leur migration. Le harnais l'a révélé : le premier verrou n'en avait
  fermé que 23.

**Deux exceptions, et elles ne sont pas des indulgences :** `get_business_owner_id()` et
`can_manage_products()` sont appelées par les policies RLS, qui s'évaluent sous le rôle de
l'appelant — les retirer ferait renvoyer « permission denied » au lieu de zéro ligne. Pour
`anon`, les deux répondent NULL, donc faux : aucun accès concédé. Elles sont aussi
appelées par des fonctions `SECURITY INVOKER` (crédit, dépenses, plan gate, marge,
fournisseurs), donc sous le rôle `authenticated`.

`authenticated` n'a **pas** été re-granté en bloc : ce serait rouvrir
`close_beta_program()`, `set_beta_slots()` et `revoke_all_beta()` à tout client connecté.

Vérifié en production : **33 → 2** fonctions appelables par `anon` ; refus réel en 401 sur
`beta_status`, `close_beta_program`, `get_sales_summary` et `bump_rate_limit` ;
`GET /rest/v1/products` répond toujours `200 []` ; exécution réelle en rôle
`authenticated` sur les 14 fonctions de l'application, dont `get_sales_summary`
(`993 400 F`, 20 transactions, 3 jours, `RIZ / Nokia 105 Duos / Tete chargeur Iphone 25w`).
Harnais : **section 22, 7 assertions**.

**Résiduel connu :** `postgres` n'a pas le droit de modifier les privilèges par défaut de
`supabase_admin`, dont la ligne contient encore `anon`. Toutes les migrations du dépôt
tournent en `postgres`, dont la ligne a été nettoyée — c'est celle qui sert à la création.

### 3.3 Mémoriser le contexte Supabase

**État :** un seul `createContext` (`SupabaseProvider.tsx:31`). La valeur du Provider est un
**objet littéral inline**, recréé à chaque render :

```tsx
// src/components/providers/SupabaseProvider.tsx:206
<SupabaseContext.Provider value={{ supabase, user, loading, ownerId, isEmployee,
  canManageProducts, actorName, org, plan, orgError, refreshOrg }}>
```

`useMemo` n'est **même pas importé** (l.3 : `createContext, useContext, useEffect, useState`).
Deux closures non mémoïsées aggravent l'effet : `loadOrg` (l.48) et `refreshOrg` (l.74),
qui capturent `ownerId` et changent donc de référence à chaque render.

Conséquence : **tous les consommateurs du contexte re-rendrent à chaque render du Provider**,
y compris le POS.

**À faire :** `useMemo` sur la valeur, `useCallback` sur `loadOrg` et `refreshOrg`.

**Fini quand :** la référence de la valeur du contexte ne change que lorsque ses dépendances
changent (vérifiable en comptant les renders d'un consommateur).

### 3.4 Supprimer le code mort et repasser à 0 warning

| Cible | Fait vérifié |
|---|---|
| `src/lib/supabase/server.ts` | **27 lignes, 1 export, 0 importateur** — `grep -rn "lib/supabase/server" src` → 0. Attention : `@/lib/utils/server` est un **autre** fichier, lui importé par 8 routes — ne pas le confondre |
| `probe6.tmp.mjs` (racine) | Fichier bâillon, 9 lignes, aucune référence ailleurs |
| 4 warnings ESLint | Tous dans `supabase/tests/migration.test.mjs` : `asUser` l.122, `ex` l.447, `err` l.755, `vendreC` l.1479 |

**Fini quand :** `npm run lint` → `0 problems`. Aujourd'hui : `0 errors, 4 warnings`.

### Définition de fini — Sprint 3

```
npx tsc --noEmit   → 0
npm run lint       → 0 problems (aujourd'hui 4 warnings)
npm run build      → 0
npm test           → 0   (3 harnais SQL + 25 assertions Node)
```

---

## Sprint 4 — Structure : découper `page.tsx`

Le Sprint 3 est délibérément mécanique et sans risque. Celui-ci déplace du code : **il se fait
par petites étapes, chaque étape étant compilée et testée avant la suivante.**

### 4.1 Découpage de `src/app/page.tsx`

**État au départ :** **861 lignes**, `'use client'` en l.1, **4 composants** déclarés au
niveau module (`HomePage`, `OrgLoadFailed`, `OrgSetupRequired`, `LoginPage`).
**État à l'arrivée :** **261 lignes.**

| Extrait vers | Ce que ça contenait |
|---|---|
| `src/components/auth/LoginPage.tsx` (255 l.) | connexion / inscription / mot de passe oublié — aucune dépendance vers les onglets |
| `src/components/onboarding/OrgLoadFailed.tsx` (49 l.) | état « lecture de la boutique impossible » |
| `src/components/onboarding/OrgSetupRequired.tsx` (66 l.) | état « configuration requise » |
| `src/components/layout/Sidebar.tsx` (97 l.) | navigation, logo, scanner, actualiser, e-mail, déconnexion |
| `src/components/dashboard/DashboardTab.tsx` (102 l.) | stats Produits / Valeur stock / Stock critique + actions |
| `src/components/inventory/InventoryTab.tsx` (51 l.) | catalogue ou fiche d'inventaire + bouton d'inventaire |
| `src/components/reports/ReportsTab.tsx` (66 l.) | sélecteur Ventes / Rentabilité / Charges + le `dynamic` de recharts |
| `src/lib/hooks/useProducts.ts` (54 l.) | état + premier chargement + rechargement du catalogue |
| `src/types/index.ts` | `Tab`, `ReportView`, `NavItem` — types partagés, sinon la sidebar importerait la page qui l'importe |

**Ce qui est resté dans `page.tsx`, volontairement :** les gardes d'authentification, l'état
d'interface (onglet, sous-vue des rapports, scanner, modals produits), `NAV_ITEMS`, le shell,
les 6 onglets triviaux et les 3 modals.

**Écarts au plan initial — et pourquoi :**

- Étape 3 (**extraire les modals**) : **non faite**. 19 lignes de JSX pour **12 props** à
  redescendre serait un échange négatif. Les modals restent à côté de l'état qui les pilote.
- Étape 5 (ne laisser que shell + `NAV_ITEMS` + switch) : atteinte, mais **pas par cette
  voie**. Shell + switch + état pèsent ~410 lignes : le plan initial sous-estimait son propre
  résultat. Ce sont `Sidebar`, `InventoryTab`, `ReportsTab` et le hook `useProducts` qui
  ont fait la différence.
- Un helper `TabPanel` (la coquille `<div className="space-y-4"><h2>` copiée 7 fois) a été
  écrit puis **supprimé** : la coquille faisait déjà une ligne par élément, le gain réel était
  de 10 lignes pour une abstraction de plus. Code mort, pas gardé.

**Fini quand :** `page.tsx < 300 lignes`, `tsc`/`lint`/`build`/`npm test` à 0, et **aucun
changement de comportement** — le Sprint 4.1 est un déplacement, pas une refonte. ✔ fait.

**Preuve du « aucun changement de comportement » :** les **644 lignes** retirées de
`page.tsx` ont été re-coupées ligne à ligne contre les 8 fichiers créés, après neutralisation
de l'indentation et des renommages de props. **17 lignes** ne matchent pas, toutes
explicables : 9 imports d'icônes devenues inutiles, `useEffect`/`useMemo` partis avec leur
code, les déclarations `Tab`/`ReportView` migrées vers `@/types`, la signature `NAV_ITEMS`
passée de `as {...}[]` à `: NavItem[]`, et 3 `function X()` devenues `export function X()`.

> **Recette manuelle des 9 onglets : FAITE le 03/10/2026**, dans le navigateur, en local sur
> `localhost:3001`, sur les **deux profils** (propriétaire `dertys01`, caissier `dermarc8`).
> **0 erreur JavaScript** en console sur toute la session.
>
> Chiffres conformes à la base : 8 produits · valeur stock 5 131 600 F · stock critique 0 ·
> Ventes 993 400 F / 20 transactions · Rapports 993 400 F / espèces 789 800 / MoMo 61 600 ·
> top RIZ 19,5 / Nokia 105 Duos 8 / Tete chargeur 8 · Rentabilité 32,6 % · Charges 188 200 F.
> Profil caissier : 1 produit / 2 000 000 F, **aucun** bouton Ajouter ni d'inventaire,
> titre « Journal d'activité », Rapports à 0.
>
> Deux points relevés au passage, **préexistants** et non liés au découpage : l'état de
> l'onglet et de la sous-vue des rapports survit à la déconnexion (le composant reste monté),
> et le verrou de la sidebar dépend du **plan** et non du rôle — deux organisations en `pro`
> donnent les mêmes 9 entrées déverrouillées.
>
> **Reste dans le Sprint 4 :** 4.3 (dette TypeScript, au fil de l'eau).

### 4.2 Remettre du server-side là où ça a un sens

**État (avant) :** 4 pages, **4 sur 4 en `'use client'`** (`/`, `/reset-password`, `/register`,
`/invitation/[token]`). Seul `src/app/layout.tsx` est un server component (il porte déjà
`metadata`).

Conséquence : un composant client ne peut pas exporter `metadata`, donc **aucune de ces pages
ne peut porter de titre ou de description propres**.

**Livré le 03/10/2026 :** trois layouts serveur minces (une file `children`, rien d'autre),
chaun portant son `metadata`. Les `page.tsx` **n'ont pas été touchés** — la caisse, le scanner
et les listes en temps réel restent légitimement côté client.

| Route | Fichier ajouté | Titre rendu |
|---|---|---|
| `/register` | `src/app/register/layout.tsx` | `Créer un compte — GestionLocal` |
| `/reset-password` | `src/app/reset-password/layout.tsx` | `Choisir un nouveau mot de passe — GestionLocal` |
| `/invitation/[token]` | `src/app/invitation/[token]/layout.tsx` | `Accepter l'invitation — GestionLocal` |
| `/` | *aucun* | `GestionLocal — ERP/POS` — déjà porté par le layout racine, et une route racine ne peut pas recevoir de second layout |

**Preuve que le titre vient bien du serveur** (HTML brut, sans JavaScript) :

```
/                   <title>GestionLocal — ERP/POS</title>
/register           <title>Créer un compte — GestionLocal</title>
/reset-password     <title>Choisir un nouveau mot de passe — GestionLocal</title>
/invitation/abc     <title>Accepter l&#x27;invitation — GestionLocal</title>
```

**Fini quand :** `/register` et `/reset-password` affichent un titre de onglet propre, sans
toucher au reste. → **✓ fait le 03/10/2026**

### 4.3 Dette TypeScript, au fil de l'eau

**État :** **25** `eslint-disable` dans 17 fichiers (recompté le 03/10/2026 ; le chiffre de 24
étaient celui d'avant le Sprint 3.2, qui a fait passer `SalesHistory.tsx` d'un effet à deux) :

- **16** `@typescript-eslint/no-explicit-any` — dont `SupabaseProvider.tsx:53,83,105,121`,
  `BarcodeScanner.tsx:17,37`, `ExpensesModule.tsx:83,160`, `InventoryTable.tsx:115`,
  et 5 dans les routes API (`accept:163`, `portal:38`, `checkout:55`, `webhook:94`).
- **9** `react-hooks/exhaustive-deps` — dont `SupabaseProvider.tsx:206`,
  `SalesHistory.tsx:108,113`, `TeamModule.tsx:151`.

Le Sprint 4.1, lui, **n'en a ajouté aucune** : vérifié commit par commit entre `980c6c9`
et `8a125ee`.

**Règle :** retirer ces directives **fichier par fichier, quand on touche au fichier** —
jamais en une passe globale. Supprimer un `exhaustive-deps` d'un coup modifie le moment où un
`useEffect` se relance ; c'est exactement le genre de changement qui passe les tests et casse
l'écran.

`grep -rn "TODO\|FIXME\|HACK" src` → **0** : le code ne signale aucune dette lui-même.

### Définition de fini — Sprint 4

```
page.tsx          → < 300 lignes
npx tsc --noEmit  → 0
npm run lint      → 0 problems
npm run build     → 0
npm test          → 0
+ recette manuelle des 9 onglets  → ✓ faite le 03/10/2026
+ titres de onglet (4 routes)     → ✓ servis, vérifiés dans le HTML brut
```

---

## Hors périmètre (volontairement)

| Sujet | Pourquoi |
|---|---|
| **Mobile Money** | Reporté volontairement par le mainteneur le 03/10/2026 — étape à traiter plus tard |
| **Plan restaurant (3 phases)** | Audit distinct, pas encore planifié dans les sprints |
| **Programme bêta** | `slots_total = 10`, accès ouvert — **ne pas modifier `supabase/migration_beta_program.sql`** |

## Garde-fous permanents

- `bump_rate_limit()` doit rester en **`SECURITY DEFINER`**.
- `supabase/migration_security.sql` doit rester la **dernière** migration du dépôt.
- La clé **`anon`** ne doit appeler que `get_business_owner_id()` et
  `can_manage_products()` — les deux helpers des policies RLS. Toute nouvelle fonction
  qui ne doit pas être exposée sans session doit en être consciente dès sa création, et
  l'assertion **22a** du harnais échoue si elle l'est.
- Toute modification SQL passe par `npm run test:db` **et** `npm run test:db:existing`.
- La recherche `GET /admin/users?email=` de ce GoTrue **ignore** le paramètre : ne pas
  « simplifier » la pagination de `invitations/accept`.
- Aucune suppression de données sans afficher la liste et obtenir le feu vert.

## Journal

| Date | Commit | Objet |
|---|---|---|
| 03/10/2026 | `c4ba478` | Sprint 4.2 — 3 layouts serveur portant `metadata` (titres de onglet) |
| 03/10/2026 | `7e7627a` | Recette manuelle des 9 onglets — navigateur, 2 profils, 0 erreur JS |
| 03/10/2026 | `8a125ee` | Sprint 4.1 — `page.tsx` découpé : 861 → 261 lignes, 8 fichiers créés |
| 03/10/2026 | `3e8dbba` | Faille `anon` close — section 7 de `migration_security.sql`, section 22 du harnais |
| 03/10/2026 | `6cc277e` | Sprint 3.2 — totaux de période en base, liste paginée |
| 03/10/2026 | `980c6c9` | Sprint 3.3 — valeur du contexte Supabase mémorisée |
| 03/10/2026 | `9532ba8` | Sprint 3.1 — recharts chargé à la demande |
| 03/10/2026 | `6efd2d3` | Sprint 3.4 — code mort supprimé, lint à 0 warning |
| 03/10/2026 | `8013458` | Compteur d'inscription après validation |
| 03/10/2026 | `3a179dc` | Rate limit de `proxy.ts` en production |
| 02/10/2026 | `ab2aef0` | Réparation de l'API Auth et de la suppression de compte |
| — | `324e288` | Sprint 1 + Sprint 2 |
