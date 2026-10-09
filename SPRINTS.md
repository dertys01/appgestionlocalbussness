# Plan de développement — Sprints 1 à 7

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
| — | Recette manuelle des 9 onglets : navigateur, 2 profils (propriétaire + caissier), **0 erreur JS** — **locale ET prod** | `7e7627a` |
| 4.2 | Titres de onglet côté serveur : **3 layouts `metadata`**, `page.tsx` intacts (4/4 toujours client) | `c4ba478` |
| 5 | Accessibilité et contraste : **Lighthouse a11y 0.83/0.95/0.96 → 1.00** sur 5 écrans · **10 premiers tests de composant React** | `6abaa4c` |
| 6 | États vides et premier écran : composant `ui/empty-state` appliqué à **9 écrans**, accueil à zéro produit · **10 champs sans étiquette reliée** corrigés (Lighthouse Paramètres **0.94 → 1.00**) · tests **10 → 19** | `68860f0` `d168d56` |
| 7 | **Résultat net corrigé** : le coût des marchandises vendues est déduit. L'écran affichait **1 161 200 F (86,1 %)** pour un bénéfice réel de **207 444 F (15,4 %)** — **section 8** de `migration_security.sql` · tests **19 → 23** | `693947b` |
| 8 | **Import CSV de produits** : l'application n'avait qu'un export. Analyseur tolérant (`520.000`, `110k`, Excel FR), refus explicite de la vente à perte, produits existants jamais écrasés · **dépôt public protégé** (`import-local/`) · tests **23 → 65** | `40082cb` `e451839` `953c7f9` |
| 9 | **Caisse atteignable au POS** : sur mobile le panier était sous la grille de produits — il fallait défiler tout le catalogue pour encaisser. Barre fixe + panier plein écran, total toujours visible | `811e7eb` |
| 10 | **Rail latéral devenu tiroir sur mobile** : il passait au-dessus de la barre du bas (z-40 contre z-30) et mangeait 64 px de largeur. **64 px rendus au catalogue** · tests **71 → 80** | `0bd81ea` |
| 11 | **Trouver un article sans parcourir le catalogue** : recherche tolérante aux fautes, par variante (« 128/6 ») et par prix · barre de catégories · **+ vendus sur 30 jours** · reprendre la dernière vente · une lettre tape dans la recherche · tests **80 → 122** | `40bcf87` `14df2b3` |

**Reste dans le Sprint 4 :** 4.3 (25 `eslint-disable` dans 17 fichiers, au fil de l'eau).

**Reste dans le Sprint 5 :** validation visuelle mobile à 375 px sur appareil réel
(aucun émulateur de viewport n'est disponible ici — voir 5.4).

**Recette manuelle des 9 onglets : faite** le 03/10/2026, navigateur, deux profils,
**en local puis en prod**, 0 erreur JavaScript — détail en fin de section 4.1.

`supabase/migration_security.sql` porte les **8 sections** (1 `rate_limits` hors portée client ·
2 `organizations.plan` verrouillé · 3 `subscriptions` une ligne par org · 4 `business_members`
lecture seule · 5 `sales`/`sale_items`/`stock_logs` lecture seule · 6 suppression de compte ·
7 clé `anon` révoquée · 8 `get_cash_flow()` déduit le coût des marchandises vendues).

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
> **Rejouée le même jour sur la prod** (`appgestionlocalbussness.vercel.app`, déploiement
> Vercel déclenché par le push) : 9/9 onglets chez le propriétaire, les 4 différences
> caissier conformes, **0 erreur JS** aussi. Titres de onglet servis par les layouts du
> Sprint 4.2, vérifiés dans le HTML brut.
>
> ⚠️ Une **vente réelle de 380 000 F** (hp 15, espèces) est tombée en base à 04:29 UTC,
> c'est-à-dire **entre la lecture de l'onglet Stock et celle de l'onglet Ventes** pendant
> cette recette — saisie par quelqu'un d'autre que l'agent, qui n'a fait que lire. Vérifié
> en SQL : `stock_qty` du `hp` est bien passé **5 → 4**, `valeur stock` 5 131 600 →
> 4 781 600 (relecture du tableau de bord : conforme), CA 993 400 → 1 373 400,
> 20 → 21 transactions. **Aucune incohérence** : les agrégats ont suivi la vente à chaque
> étape.
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

## Sprint 5 — Ce qui se voit : accessibilité, contraste, premiers tests

Les quatre sprints précédents étaient mesurés par ce qui ne se voit pas
(`tsc`, `lint`, `build`, `test`). Celui-ci mesure ce qui se voit : un audit, puis
les défauts qu'il relève, fichier par fichier. Aucune règle de lint n'a été
assouplie — la dette reste à **25 `eslint-disable`**, comme avant.

### 5.1 — L'audit, avant / après

Même outil, mêmes réglages, **cinq écrans** :

| Écran | A11y avant | A11y après | Échecs avant → après |
|---|---|---|---|
| `/` (connexion) | **0.83** | **1.00** | 4 → 0 |
| `/register` | non mesuré | **1.00** | 4 → 0 |
| Tableau de bord | 0.95 | **1.00** | 2 → 0 |
| Point de vente | non mesuré | **1.00** | — → 0 |
| Rapports | 0.96 | **1.00** | 3 → 0 |

`Best Practices` et `SEO` étaient déjà à 1.00 partout et y restent.

Défauts de départ, tous localisés avant correction : `button-name` et
`target-size` (le bouton « œil » du mot de passe, 16 px, sans nom accessible),
`landmark-one-main` (les 4 écrans d'auth sans `<main>`), `color-contrast`
(la sidebar et les onglets inactifs).

### 5.2 — Accessibilité

- **`<main>`** posé sur les 4 écrans d'auth : `LoginPage`, `register`,
  `reset-password`, et les **deux** branches de `invitation/[token]`.
- **Bouton « œil »** : aligné sur le motif que `/invitation` avait déjà —
  `aria-label` binaire (« Afficher/Masquer le mot de passe »), cible tactile
  `inset-y-0 w-11` (44 px) au lieu d'une icône de 16 px à `right-3`, et
  `pr-11` sur l'input pour que le texte ne passe pas dessous.
- **14 boutons à icône seule** reçoivent un `aria-label` : *Actualiser* (×5),
  *Fermer* (×3), *Page précédente* / *Page suivante* (×4), *Retirer du panier*,
  *Scanner un code-barres*. Détectés par balayage du `src/` puis repris un par un
  — les trois faux positifs (puces qui rendent `{category}` / `{unit}` /
  `{label}`) ont été écartés à la main.
- **Sidebar** : `aria-label` sur les 12 entrées de nav et les 4 actions du pied.
  C'est ce que reçoit réellement un utilisateur du rail d'icônes, puisque les
  libellés sont en `hidden lg:`.

### 5.3 — Contraste : trois corrections systémiques

Rien n'a été corrigé au cas par cas là où le problème venait d'une couleur.

1. **La couleur muette.** `text-slate-400` (2,6:1) était le gris « secondaire »
   de toute l'application : **101 occurrences dans 24 fichiers**, toutes passées
   en `text-slate-500` (4,8:1 — la `muted-foreground` standard de shadcn).
2. **Le rouge.** Messages d'erreur `text-red-500` (3,8:1) → `text-red-600`
   (4,8:1). Les icônes restent en `500` : le non-texte n'exige que 3:1.
   « Déconnexion », partait de `text-red-400` (2,6:1) → `text-red-600`.
3. **Les accents.** `emerald-600` (3,65:1) et `amber-600` (3,19:1) → `700`.
   Les fonds portant du blanc (`bg-emerald-600 text-white`) → `700` ; les
   pastilles d'étape `bg-emerald-500 text-white` (2,56:1) → `700`.

Et deux cas qu'aucun outil n'aurait signalés avant affichage : les onglets
inactifs sur `bg-slate-100` étaient à **4,34:1** (seuil : 4,5) → `slate-600`
(6,85) — `LoginPage` et `ReportsTab` —, et les valeurs `text-slate-300`
(« — », pourcentages sans coût) sont de la donnée, pas de la déco → `slate-500`.

### 5.4 — Rail d'icônes et typographie

- **Connecté où ?** Sous `lg`, la sidebar ne montrait ni libellé ni e-mail :
  12 icônes muettes et aucun repère de compte. Ajout d'une pastille
  `role="img" aria-label={email}` sous `lg`, l'e-mail complet restant affiché
  à partir de `lg`. `title` seul ne servait à rien au tactile.
- **Dix pixels.** Les 11 `text-[10px]` (panier, rentabilité, dettes) sont
  passés en `text-[11px]`, l'autre taille déjà utilisée dans le code.

**Limite assumée.** Aucun émulateur de viewport n'est disponible ici : le
mobile est traité **par analyse CSS** — rail de 64 px, tableaux déjà enveloppés
dans `overflow-x-auto`, libellés `hidden lg:` doublés d'un `aria-label`. La
vérification visuelle à 375 px sur appareil réel reste à faire.

### 5.5 — Premiers tests de composant React

- **Vitest 3 + jsdom + Testing Library** : `vitest.config.ts` et `tests/ui/`.
  `include` restreint à `tests/ui` pour ne pas happer les suites
  `node --test` existantes.
- `test:ui` **ajouté à la chaîne `npm test`** — il n'y a donc pas de voie
  contournable pour l'oublier.
- **10 tests / 2 fichiers** : `Sidebar` (nom accessible de chaque entrée,
  cadenas présent seulement sur une entrée verrouillée, redirection du verrou,
  pastille du compte, pied de page) et `PeriodPicker` (raccourci cliqué calé sur
  aujourd'hui, raccourcis filtrés au-delà du plafond du plan, ramenage dans le
  plafond, ouverture du choix libre).
- **1 boîtier cassé en route** : un `aria-label` inséré après une balise qui
  fermait sur la même ligne était tombé en contenu JSX (10 erreurs `lint`) ;
  repéré par la porte `npm run lint`, corrigé, jamais contourné.

### Définition de fini — Sprint 5

```
npx tsc --noEmit  → 0
npm run lint      → 0 problems
npm run build     → 0
npm test          → 0  (+ 10 tests de composant)
+ Lighthouse a11y → 1.00 sur les 5 écrans mesurés
+ dette eslint-disable → 25 (inchangée)
```

---

## Sprint 6 — Ce qui reste à comprendre : premier écran, états vides, étiquettes

Sprint 5 a rendu les écrans existants accessibles. Celui-ci traite ce qui se
passe **quand il n'y a rien à afficher** — le vrai cas du programme bêta : les
dix boutiques ouvrent à zéro produit, et aucun de nos comptes de recette ne peut
montrer cet état (`Test1` porte 9 produits et 21 ventes).

### 6.1 — Le premier écran d'une boutique neuve

**Avant :** trois cartes — `0` produit, `0 F` de valeur stock, `0` stock
critique. Aucune information, aucune indication de par où commencer.

**Après :** les cartes sont remplacées dès le premier écran par les trois pas du
métier, numérotés — ajouter des produits → enregistrer une vente → suivre ce qui
reste dû. Elles réapparaissent dès qu'un produit existe.

Un caissier (`canManageProducts = false`) n'a pas le bouton « Ajouter produit »
dans sa portée : on lui dit d'aller voir le gérant, plutôt que de lui proposer
une action qu'il ne pourra jamais faire.

### 6.2 — États vides homogènes

**Avant :** ~20 états vides réinventés à chaque écran — du `text-slate-500` nu,
parfois une icône, parfois une bouton, jamais la même densité. « Aucun produit »
arrête l'utilisateur sans lui dire quoi faire.

Le composant `src/components/ui/empty-state.tsx` impose la même structure :
pictogramme enterré dans `aria-hidden`, ce qu'on attendait, et surtout **pourquoi
c'est vide et quoi faire ensuite**. Appliqué à 9 écrans : Vente, Historique,
Rapports, Prévisions, Équipe (membres et journal), Rentabilité, Dettes,
Dépenses, Stock.

Deux corrections de couleur dans la foulée :

- l'avertissement « aucune charge » passait de **bleu à ambre** — c'était le seul
  bleu de l'application, portant un message d'alerte dans un système qui réserve
  l'ambre à cela ;
- le badge « Réappro. » du journal passait de **bleu à sarcelle** : `blue-100` et
  `indigo-100` étaient visuellement identiques — deux actions distinctes se
  ressemblaient.

### 6.3 — Étiquettes de champs

Lighthouse tombe à **0.94** sur Paramètres (échec `label`). Le défaut est plus
large que la page auditée : le balayage des 9 onglets trouve **10 contrôles sans
nom accessible**, sur 4 d'entre eux.

| Onglet | Champs | Nature du défaut |
|---|---|---|
| Paramètres | 4 | `<label>` en toutes lettres, mais sans `htmlFor` : l'input est son frère, jamais son enfant. Le 4ᵉ n'avait même pas de placeholder |
| Vente | 4 | aucun libellé ; le dernier portait pourtant un `<label>` visible « Montant donné (FCFA) » |
| Stock | 1 | champ à icône seule |
| Équipe | 1 | adresse email d'invitation |

Deux correctifs, choisis à la lumière de **WCAG 2.5.3** (le nom accessible doit
contenir le libellé visible) :

- **libellé visible** → vrai rattachement `htmlFor` + `id`. Sur mobile, tapoter le
  libellé met le champ au point — ce que ne fait pas un `aria-label` ;
- **aucune ligne de texte** (icône seule, placeholder) → `aria-label`.

L'IFU perd son parenthèse dans le libellé : « IFU » reste le nom accessible,
l'aide devient une description rattachée via `aria-describedby`, plutôt qu'une
étiquette de dix mots.

### 6.4 — Tests

`tests/ui/dashboard.test.tsx` (6) et `tests/ui/empty-state.test.tsx` (3) portent
les états que **nulle recette ne peut montrer** : le premier écran à zéro
produit, et le comportement d'un état vide.

**10 → 19 tests de composant.**

### Définition de fini — Sprint 6

```
npx tsc --noEmit  → 0
npm run lint      → 0 problems
npm run build     → 0
npm test          → 0  (+ 19 tests de composant)
+ balayage des 9 onglets : 0 champ sans nom accessible
+ Lighthouse a11y → 1.00 sur Accueil ET Paramètres (0.94 → 1.00)
+ recette prod : 9/9 onglets, 0 erreur JavaScript
+ dette eslint-disable → 25 (inchangée)
```

---

## Sprint 7 — L'argent affiché : ce que la marchandise a coûté

Ce sprint n'était pas planifié. Il est né d'une question du mainteneur sur l'écran
**Charges** : « chiffre d'affaires moins charge, ce n'est pas égal bénéfice, n'est-ce pas ? »
La réponse était **non**, et l'écran mentait.

### 7.1 — L'audit, avant / après

Le calcul affiché était exact *entre les chiffres montrés* :
`1 349 400 − 188 200 = 1 161 200`, et `1 161 200 / 1 349 400 = 86,1 %`. Il n'était
malheureusement pas faux **par rapport à la réalité** : le coût d'achat des
marchandises vendues n'était déduit nulle part.

`get_cash_flow()` faisait, en toutes lettres, `net = revenue − expenses`, et
`ExpensesModule.tsx` faisait `net = totalRevenue − totalExpenses`. Le CMV n'existait
que dans l'onglet **Rentabilité** (`revenue − cogs`), sans période et sans charges —
donc **aucun écran de l'application n'affichait le vrai résultat**.

Relevé en production, 30 jours, sur les bases de la fonction :

| | Avant (affiché) | Après (calculé) |
|---|---|---|
| Chiffre d'affaires (encaissé) | 1 349 400 F | 1 349 400 F |
| Coût des marchandises vendues | *absent* | 953 756 F |
| Charges de structure | 188 200 F | 188 200 F |
| **Résultat net** | **1 161 200 F** | **207 444 F** |
| **Marge nette** | **86,1 %** | **15,4 %** |

L'écart vaut **exactement** le CMV : le commerçant paraissait **5,6 fois** plus riche
qu'il n'était. Le symptôme le plus parlant était le 86 % — aucun commerce de détail
n'a cette marge ; 15 % est la marque d'une boutique saine.

### 7.2 — La section 8

Colonne `cogs` ajoutée entre `revenue` et `expenses`, `net = revenue − cogs − expenses`.
Rien n'est supprimé : le client lit les champs par leur nom, un champ de plus est sans
effet sur le code antérieur — c'est ce qui rend l'ordre de déploiement indifférent.

Le coût vient de `sale_items.unit_cost`, figé à la vente par `freeze_sale_item_cost()` :
l'historique ne bouge pas quand le prix d'achat est corrigé aujourd'hui. Il est proraté
sur `amount_received / total_amount`, **exactement comme le CA** — une vente à crédit ne
débite que la part encaissée. C'est la condition pour qu'une soustraction ait un sens :
ventes et coûts doivent sortir sur la même base.

Le garde de plan (`require_feature('reports')`) est conservé, et le verrou de la clé
`anon` vérifié après application : `anon_peut_appeler = false`, les deux helpers des
policies RLS restent les seules fonctions ouvertes au public.

### 7.3 — L'écran

Cinquième carte **« Marchandises — ce que vous avez payé »**. Sans elle, la chute du
résultat était inexplicable : 1,16 M disparaisaient sans qu'on dise pourquoi. Les trois
autres cartes sont désormais préfixées du signe moins, pour que la chaîne se lise dans
l'ordre. Deux textes qui promettaient le chiffre d'affaires sans charge — ou qui
n'expliquaient pas le calcul — sont corrigés.

### 7.4 — Tests

- `supabase/tests/migration.test.mjs` **7o / 7p / 7q** — CA, CMV, et l'invariant
  `net = CA − CMV − charges` sur une vente à coût connu. C'est le garde-fou qui empêche
  l'oubli de revenir.
- `tests/ui/expenses.test.tsx` (4) — verrouille le 207 444 F à l'écran et **interdit le
  retour du 1 161 200 F**.

**19 → 23 tests de composant.**

> Piège rencontré en écrivant ce test : Testing Library normalise le texte du DOM
> (`/\s+/g` → espace) mais compare la requête **brute**. `formatCFA` écrit les milliers
> avec une espace fine insécable (U+202F) : `getByText(formatCFA(207444))` ne trouve donc
> **jamais** l'élément, alors qu'il est bien là. Il faut appliquer la même normalisation
> à la requête.

### 7.5 — Observation laissée ouverte

Les onglets **Ventes** et **Charges** n'affichent pas le même « chiffre d'affaires » sur
la même période : **1 373 400 F** contre **1 349 400 F**. Ce n'est pas un bug —
`get_sales_summary()` raisonne en *prix de vente* (`total_amount`), `get_cash_flow()` en
*encaissé* (`amount_received`). L'écart de 24 000 F est exactement 2 ventes à crédit non
soldées. Les deux bases sont justifiées, mais deux chiffres différents pour la même période
sans explication dans l'interface est une source de confusion. **Non traité** : c'est un
choix de présentation, pas une correction.

### Définition de fini — Sprint 7

```
npx tsc --noEmit  → 0
npm run lint      → 0 problems
npm run build     → 0
npm test          → 0  (+ 23 tests de composant, 432 vérifications)
+ section 8 appliquée en prod : signature TABLE(day, revenue, cogs, expenses, net, transactions)
+ SECURITY INVOKER préservé, anon_peut_appeler = false
+ prod vérifiée : 207 444 F / 15,4 % affichés, 0 erreur JavaScript
+ dette eslint-disable → 25 (inchangée)
```

---

## Sprint 8 — Charger un tarif sans saisir 35 fiches

### 8.1 — Le manque

Le projet n'avait qu'un **export** CSV : aucune route d'import parmi les 8
routes API, aucun composant d'import. Le bouton « CSV » de l'Inventaire
appelle `handleExport`. Charger un tarif demandait donc une saisie manuelle
par produit — à chaque trimestre, pour chacune des boutiques du bêta.

### 8.2 — L'analyseur (`src/lib/utils/importProducts.ts`)

Fonction pure : ni réseau, ni base, ni React. Ce qu'elle peut refuser est
donc testable sans lever de serveur.

**Tolérant**, parce que le fichier vient d'Excel et que les prix s'écrivent
comme les gens les écrivent :

| Écriture | Lue comme |
|---|---|
| `520.000` | 520 000 — **et non 520**, c'est le piège du genre de fichier |
| `1.349.400` | 1 349 400 |
| `110k`, `123K` | 110 000, 123 000 |
| `15 000`, `1 200,50` | 15 000, 1 200,50 |
| `1200.5` | 1 200,5 — la décimale n'est pas un milliers |
| `1.200,50` | 1 200,50 |

Plus : point-virgule d'un Excel français, BOM, CRLF, guillemets `""`.
En-têtes acceptées en français (« Prix achat (F) ») comme en noms de
colonnes de la base (`price_buy`) — le fichier peut venir d'ailleurs.

**Refusés**, et c'est une feature, pas une gêne :

- nom manquant, montant illisible, valeur négative ;
- **prix de vente sous le prix d'achat** — une vente à perte ne doit pas
  entrer par la porte de derrière ;
- doublon dans le fichier ;
- **produit déjà en boutique : ses prix ne bougent pas.** Charger un tarif
  ne doit jamais écraser un prix saisi à la main.

### 8.3 — Les bugs que les tests ont attrapés

Les 22 tests de l'analyseur ont échoué **deux fois** pendant leur écriture, et
les deux échecs étaient de vrais bugs :

1. **Les deux branches de `1.200,50` étaient inversées.** Résultat : `1,2005`
   au lieu de `1200,5`. Le séparateur décimal est le plus à droite des deux —
   règle écrite à l'envers.
2. **Un guillemet nu au milieu d'un nom avalait la fin de la ligne.** Le
   `14"` d'un nom de machine ouvrait un champ cité, et toute la ligne était
   avalée. Un guillemet n'ouvre un champ que s'il est son premier caractère.

### 8.4 — La modale

L'aperçu **est** la confirmation : verdict par ligne, détail des lignes
écartées, bouton désactivé s'il n'y a rien d'importable. Pas de dialogue de
confirmation supplémentaire — c'est l'aperçu qui doit être vu pour corriger
son fichier.

La limite de plan est vérifiée **avant** l'envoi. Elle est appliquée en base
produit par produit : un lot coupé en deux laisserait une moitié importée et
l'autre refusée, sans rien dire. Si l'import s'arrête en cours de route, le
nombre déjà importé est **annoncé** — sinon le commerçant recharge son
fichier et tombe sur ce qu'il vient d'importer.

« Télécharger le modèle » : sans lui le format est invisible, et le problème
est circulaire.

### 8.5 — Le dépôt est public

Le dépôt GitHub est en `PUBLIC`. Un CSV de prix d'achat n'y a pas sa place :
`import-local/` est gitignoré (`953c7f9`), et c'est le dossier entier qui est
couvert, pas une extension — un `.csv` écrit à la main ailleurs passerait.

### 8.6 — Le fichier livré est vérifié

`tests/ui/import-livre.test.ts` lit `import-local/produits-import.csv` depuis
le disque. Les autres tests partaient d'un CSV écrit à la main dans le test :
ils prouvent que l'analyseur tolère tel format, **pas** que le fichier livré
passe. Si quelqu'un régénère le CSV avec un séparateur, une colonne renommée
ou une catégorie mal orthographiée, la suite tombe là.

### 8.7 — Un point d'accessibilité réglé au passage

Les trois boutons de la barre de l'Inventaire n'avaient **aucun nom
accessible** sous `sm` : le libellé est masqué (`hidden sm:inline`) et il ne
restait qu'une icône. Étiquetés, en appliquant la règle « au fil de l'eau »
puisque le fichier était touché.

### Définition de fini — Sprint 8

```
npx tsc --noEmit  → 0
npm run lint      → 0 problems
npm run build     → 0
npm test          → 0  (55 vérifications SQL, 65 tests de composant)
+ prod : bouton « Importer » présent et nommé, modale ouverte,
  bouton d'import désactivé tant qu'aucun fichier n'est choisi
+ le fichier livré passe l'analyseur : 35 produits, 0 refus, 0 parasite
```

---

## Sprint 9 — La caisse était hors d'atteinte au point de vente

Signalé par le mainteneur le 03/10/2026, sur la capture d'écran du POS avec
43 références. Ce n'est pas un défaut d'apparence : **c'est l'écran de vente
qui devient inutilisable au moment où il sert.**

### 9.1 — Le défaut

Ligne 416 de `POSModule.tsx` : `flex flex-col lg:flex-row`. Sur mobile, le
panier (`lg:w-80`) passait **après** la grille de produits. Avec 40 références,
le caissier devait faire défiler plusieurs écrans pour atteindre le total et le
bouton « Encaisser » — l'action principale de l'écran, **à chaque vente**.

### 9.2 — La correction

- **Barre fixe en bas** (mobile seulement) : icône, nombre d'articles, **total
  en permanence**, et « Encaisser › » qui ouvre le panier. Une seule cible,
  une seule action.
- **Panier en plein écran.** La zone des articles devient la seule zone
  défilante (`flex-1`), donc total, mode de paiement, montant donné et
  « Encaisser » restent **toujours en bas**, atteignables. La borne
  `max-h-[45vh]` qui était propre au grand écran est passée en
  `lg:` seulement.
- **Le panier se referme avec la vente** : le caissier voit la grille vide
  pour la suivante. Fermer **sans** encaisser conserve les articles — il a
  saisi des quantités, il ne les saisira pas deux fois.
- **`pb-24`** sous la grille : sans cette réserve, la barre fixe passerait sur
  la dernière rangée et la rendrait incliquable.

Sur grand écran : rien ne change, la colonne reste à droite.

### 9.3 — Sémantique de modale

Le panneau ouvert recouvre la grille, qui reste dans le DOM et focusable : la
tabulation et les lecteurs d'écran parcouraient un contenu invisible. La grille
passe **`inert`** (React 19) tant que le panneau est ouvert.

Corollaire non évident : le bouton de fermeture **n'est pas** masqué en
`lg:`. Sur mobile `panierOuvert` ne peut être vrai que depuis la barre, donc
il n'apparaît pas en usage normal — mais après une rotation vers un grand
écran, c'est la seule issue pour lever `inert` sur la grille. Le masquer
aurait piégé le caissier dans un écran figé.

### 9.4 — Tests

6 tests (`tests/ui/pos-cart-access.test.tsx`) : la barre existe, le total se
met à jour à l'ajout, elle ouvre le panier qui contient « Encaisser », fermer
sans encaisser conserve les articles, la grille sort du parcours de
tabulation.

Ils reprennent le piège du Sprint 7 : `formatCFA` écrit l'espace des milliers
en **U+202F**, et une regex contenant une espace ordinaire ne correspond
jamais. Les motifs ne contiennent donc que des intitulés, aucun montant.

### Définition de fini — Sprint 9

```
npx tsc --noEmit  → 0
npm run lint      → 0 problems
npm run build     → 0
npm test          → 0  (55 vérifications SQL, 71 tests de composant)
+ prod vérifiée : barre `fixed bottom-0`, grille `pb-24 lg:pb-0`,
  colonne panier `hidden lg:flex` — le bundle est bien servi
```

---

## Sprint 10 — Le rail latéral, obstacle au POS sur mobile

Signalé par le mainteneur le 03/10/2026, sur une capture de son téléphone :
la barre fixe du Sprint 9 fonctionnait, mais son texte était **tronqué**
(« …rticles · Total », « 03 000 F »).

### 10.1 — Les deux défauts

| | |
|---|---|
| **z-index** | Rail en `z-40`, barre du bas en `z-30` : **le rail passait au-dessus** et recouvrait le total et le bouton « Encaisser » |
| **largeur** | 64 px de rail fixe, soit un quart d'un écran de téléphone, pour une grille déjà réduite à 2 colonnes |

### 10.2 — La correction

Rail d'icônes fixe → **tiroir déployé**, fermé par défaut, ouvert par un
bouton en haut à gauche. Les 64 px reviennent au catalogue : une colonne de
plus sur un téléphone.

Trois sorties, sans lesquelles un tiroir ouvert par erreur n'en ressortait
pas sur un écran qui le remplit à moitié : **navigation**, **voile**,
**Échap**.

### 10.3 — Sémantique, et le défaut que les tests ont attrapé

Le tiroir fermé reste dans le DOM : il est **hors écran, pas absent**. Sans
`inert`, la tabulation et les lecteurs d'écran parcouraient un menu invisible.

Et le bouton « Fermer le menu » **existait tiroir fermé** — masqué par le
décalage, donc encore atteignable au clavier. C'est le premier test écrit qui
l'a trouvé ; le bouton n'est désormais rendu que tiroir ouvert.

La détection du grand écran passe par `matchMedia`, avec un **premier rendu
« grand écran »** pour que le rendu serveur reste correct. À partir de `lg`
le rail est permanent et l'état n'a plus d'effet : c'est ce qui empêche
d'appliquer `inert` au rail par erreur.

### 10.4 — jsdom n'a pas `matchMedia`

Vérifié : `typeof window.matchMedia === 'undefined'`. Le composant ne se
retrouvait donc **jamais** dans sa branche mobile — ses tests ne validaient
rien de ce chemin, et auraient validé le rail de grand écran en croyant
tester le tiroir.

Le stub est ajouté dans `tests/ui/setup.ts` avec une bascule de largeur
explicite. Le test mobile déclare désormais le mobile au lieu de le supposer.

### 10.5 — Propositions non exécutées

Le maintien a validé **uniquement** cette phase. Restent sur la table, non
écrites :

- **Proposition 1** — recherche intelligente : tolérance aux fautes de frappe
  (« samsng » → Samsung), recherche par nombre (« 128/6 ») et par prix,
  raccourci clavier. Aujourd'hui la recherche est un `includes()` exact.
- **Proposition 2** — barre de catégories collante + **les + vendus en tête de
  grille sur 30 jours** (période déjà validée par le mainteneur). La fonction
  `get_units_sold_since()` existe déjà en base.
- **Proposition 3** — reprendre la dernière vente, favoris épinglés, ajout
  par lot.
- **Proposition 4** — recherche en langage naturel : **déconseillée**, le POS
  n'a pas de clé LLM côté client.

### Définition de fini — Sprint 10

```
npx tsc --noEmit  → 0
npm run lint      → 0 problems
npm run build     → 0
npm test          → 0  (55 vérifications SQL, 80 tests de composant)
+ prod : « Ouvrir le menu » présent, tiroir fermé absent de l'arbre
  d'accessibilité (inert), main en `lg:ml-56 pt-14 lg:pt-0`
```

---

## Sprint 11 — Trouver un article sans parcourir le catalogue

Reproche du mainteneur : « si 1000 articles, difficile de les sélectionner un
à un ». La réponse n'est pas de défiler plus vite, c'est de **ne plus avoir à
chercher**.

### 11.1 — La recherche (`productSearch.ts`, fonction pure)

C'était un `includes()`. Une faute de frappe renvoyait « aucun résultat », que le
caissier lit comme une **rupture de stock** — c'est le danger principal.

| Saisie | Effet |
|---|---|
| `samsng` | trouve Samsung — et `samsng a26` aussi |
| `128/6` | trouve la **6 Go**, pas la 4 Go |
| `150000` | trouve le produit acheté 150 000 |
| `HP1311` | trouve par code-barres |
| `laptop` | trouve par catégorie |

Classement : commence par > contient > mot > code > prix > approximation.

**Trois bugs trouvés en écrivant les tests :**

1. **Correspondance intérieure notée au-dessus du préfixe.** Chercher
   « samsung a17 » ramenait « Coque pour Samsung A17 » en premier.
2. **Une saisie composée n'était satisfaite qu'à moitié.** « 128/6 » ramenait
   aussi « A17 128/4 » : un seul des deux mots suffisait. Une correspondance
   partielle est maintenant **éliminatoire** — le caissier encaisse alors la
   mauvaise variante et l'écart de prix part dans la mauvaise caisse.
3. **Le piège le plus discret :** « 4 » et « 6 » sont à une distance d'édition
   de **1**. La tolérance aux fautes rapprochait donc « 128/6 » de « 128/4 ».
   Sous trois caractères, une différence n'est jamais une faute de frappe,
   c'est une autre référence. Tolérance **à zéro**.

### 11.2 — La lecture des montants, factorisée

Extraite dans `nombres.ts`, partagé avec l'import CSV qui faisait la même chose
autrement. Deux copies d'un calcul subtil ont déjà produit deux prix faux
(`520.000` lu 520, `1.200,50` lu 1,2005) ; une seule, testée, reste.

`lireEntier` refuse volontairement `a17` : une lecture trop permissive
comparerait un **numéro de modèle** aux prix de la boutique.

### 11.3 — Catégories, + vendus, reprise de vente

- **Barre de catégories collante** : on choisit un rayon au lieu de parcourir
  1000 cartes.
- **+ vendus sur 30 jours** en tête de grille. C'est la réponse franche à
  « 1000 articles » : le classement rend la longueur du catalogue indifférente.
  `get_units_sold_since()` est verrouillée par plan — sur les autres plans
  l'appel échoue **en silence**. Un classement absent n'est pas une panne, et
  une bannière d'erreur nuirait plus au commerce qu'elle n'informerait.
- **La recherche porte sur tout le catalogue**, jamais sur la seule catégorie
  retenue. Filtrer sur « laptop » puis chercher « a17 » et ne rien trouver est
  une impasse que le caissier ne peut pas expliquer.
- **Reprendre la dernière vente** : standard de tout POS du commerce. Ça
  **ajoute** au panier, ça ne remplace jamais — donc aucune confirmation, et un
  clic ne peut rien détruire. Stock plafonné, lignes disparues comptées à part.
  Le bandeau se rafraîchit **lui-même** à chaque encaissement — il bascule sur
  la vente validée sans attendre le rechargement du catalogue du parent, auquel
  il était accroché par un effet indirect (un échec de ce rechargement le
  laissait bloqué sur l'ancienne vente). Un **bouton X** ferme la proposition :
  elle ne revient pas après la vente suivante, un rechargement la ramène.
- **Une lettre place le curseur dans la recherche** : un geste au lieu de deux.

### 11.4 — Une erreur d'ergonomie trouvée au passage

La barre du bas et la pastille d'un produit comptaient les **lignes** de
panier, pas les unités. Deux GSM identiques s'affichaient « 1 article » — le
caissier y lit une erreur, et la pastille est fausse.

### Définition de fini — Sprint 11

```
npx tsc --noEmit  → 0
npm run lint      → 0 problems
npm run build     → 0
npm test          → 0  (55 vérifications SQL, 122 tests de composant)
```

---

## Hors périmètre (volontairement)

| Sujet | Pourquoi |
|---|---|
| **Mobile Money** | Reporté volontairement par le mainteneur le 03/10/2026 — étape à traiter plus tard |
| **Plan restaurant (3 phases)** | Audit distinct, pas encore planifié dans les sprints |
| **Programme bêta** | `slots_total = 10`, accès ouvert — **ne pas modifier `supabase/migration_beta_program.sql`** |

---

## Sprints 12 à 16 — Un compte, deux domaines : commerce et restauration

Décision du 04/10/2026 : **ni « all-in-one », ni deux applications**. Un seul socle,
un seul dépôt, et le **domaine d'activité choisi à l'inscription** qui décide des
modules affichés. Un restaurant ne doit pas voir l'onglet-season, un commerçant
ne doit pas voir les tables — et le code d'un module ne doit jamais être conditionné
par `if (isRestaurant)` ailleurs.

Règle d'or retenue : un module d'un autre domaine **n'est pas rendu**, pas masqué.

### Sprint 12 — Le domaine d'activité

| | |
|---|---|
| **Objectif** | L'inscription demande l'activité, et l'interface s'y adapte |
| **SQL** | `migration_domain.sql` : `organizations.domain text NOT NULL DEFAULT 'retail' CHECK (domain IN ('retail','restaurant'))` + `ALTER TABLE organizations ADD CONSTRAINT` en `DEFERRABLE` si besoin de backfill. Migration **réjouable** (`IF NOT EXISTS`) |
| **Règle** | Le domaine est un **paramètre d'affichage**, jamais un privilège : les RLS, les plans, le tunnel Stripe et le rate limit ne changent pas. Un restaurateur reste soumis aux mêmes limites de produits |
| **Code** | `src/lib/modules.ts` : `DOMAIN_MODULES: Record<Domain, Module[]>` + `getEnabledModules(domain)`. `OnboardingWizard` pose la question en premier écran (2 cartes : Commerce / Restaurant). `Sidebar` rend la nav **depuis cette liste** |
| **Bascule** | Réglages → « Domaine d'activité », modifiable à tout moment (un maquis qui gère aussi un comptoir). Toute la migration de données passe par les outils d'import existants, pas de script caché |
| **Tests** | `modules.test.ts` (parité modules ↔ onglets), le wizard rend bien la question de domaine, la bascule Persistance, `test:db` étendu à 26 migrations |
| **Fin** | Un compte `retail` ne voit aucun module restaurant et réciproquement, vérifié par test et recette des deux profils |

### Sprint 13 — Restaurant : tables et commande ouverte

| | |
|---|---|
| **Objectif** | Le service du midi : une table, une commande qui n'est pas encore encaissée |
| **SQL** | `migration_restaurant_tables.sql` : `restaurant_tables` (nom, zone, seats, active) · `restaurant_orders` (table_id, statut `open`/`closed`, opened_by, client_name) · `restaurant_order_items` (order_id, product_id, qty, prix convenu, notes cuisine, statut `new`/`sent`/`served`) |
| **UI** | Écran « Salle » : plan des tables, couleur par état (libre / occupée / addition demandée). Ouverture d'une commande = ticket persistant, distincte de `sales` |
| **Réutilisé** | Produits, stock, prix négociés, dettes, rapport de rentabilité — rien de dupliqué. Une table n'est qu'un **conteneur de commande** |
| **Tests** | Ouverture/fermeture, deux commandes simultanées sur deux tables, isolation entre restaurants (RLS), commande vide impossible |
| **Fin** | Un serveur prend une commande sur table 3, la ferme 40 min plus tard, sans passer par la caisse comptoir |

### Sprint 14 — Restaurant : cuisine et encaissement fractionné

| | |
|---|---|
| **Objectif** | Le flux réel : cuisine servie, addition partagée, encaissement partiel |
| **UI** | **KDS** (écran cuisine) : tickets du jour triés par heure, tap pour « servi ». Impressions de ticket en cuisine (format court, sans prix) — la même commande peut être service **et** à emporter |
| **Encaissement** | Clôture d'une table : total, **fractionnement** (par personne, en N parts), acompte déjà versé déduit, espèces/MoMo, facture à la clôture via le `create_sale` existant |
| **SQL** | `restaurant_orders.split_count`, `amount_paid` · réutilisation de `sales` pour l'écriture comptable (une seule source de vérité sur le chiffre d'affaires) |
| **Tests** | Fraction 3 ways, commande à moitié payée puis soldée, ticket cuisine sans prix, vente au poids toujours correcte en restaurant |
| **Fin** | 4 convives, addition partagée en 3, sans ressaisie — et le CA du jour est identique à celui de la caisse comptoir |

### Sprint 15 — Restaurant : coût de matière par plat

| | |
|---|---|
| **Objectif** | La marge réelle d'un plat, pas d'une revente « prix − prix d'achat » |
| **SQL** | `recipe_ingredients` (product_id, ingredient_product_id, qty) + trigger ou RPC `product_cost()` : coût recursively d'une recette (le plat peut contenir un autre plat) |
| **UI** | Onglet Recettes : assembler un plat à partir d'ingrédients existants, coût et marge calculés en direct · l'écran Rentabilité affiche enfin la marge par plat |
| **Règle** | Un ingrédient vendu à l'unité **décrémente** son stock à la vente du plat (trigger sur `restaurant_order_items` ou extension de `create_sale`) |
| **Tests** | Coût d'un plat à deux niveaux, marge correcte en restaurant **et** en commerce, stock d'ingoût décrémenté exactement une fois |
| **Fin** | « Poulet braisé » affiche sa marge vraie, et le patron sait quels plats sont réellement rentables |

### Sprint 16 — Finitions restaurant et bascule finale

| | |
|---|---|
| **Objectif** | Le mode restaurant devient crédible en production |
| **Contenu** | Modificateurs (cuisson, sauce, portion) en options sur la ligne de commande · plats du jour / articles à la carte non disponibles · pourboire au choix à la clôture · reservations simples (nom, heure, personnes) · impression de ticket de table |
| **Transverse** | Recette des deux profils sur les 3 sprints précédents · audit Lighthouse sur les nouveaux écrans · mise à jour README/SPRINTS |
| **Hors périmètre assumé** | Paiement fractionné Stripe, inventaire de salle, formation, impression cuisine en réseau (KDS local) |

**Ordre de livraison** : 12 (aucun risque, tout le reste en dépend) → 13 → 14 → 15 → 16.
Chaque sprint est livrable indépendamment : un restaurant peut s'arrêter après le 14
et encaisser en salle ; le 15 est un gain de pilotage, le 16 du confort.

## Sprints 17 à 21 — Plan de lancement

Référence : `PLAN-TRAVAIL-GESTIONLOCAL.md` (05/10/2026). Ses sprints 12 à 16 sont
**renumérotés 17 à 21** ici, les numéros 12 à 16 étant déjà ceux du parcours
restaurant. Correspondance : 12 → 17, 13 → 18, 14 → 19, 15 → 20, 16 → 21.

Décisions prises à l'audit du 07/10/2026 :

- **Vouvoiement.** Les textes du plan tutoient ; ils sont repris mot pour mot, au
  vouvoiement — la forme de respect attendue d'un fournisseur par un commerçant,
  et celle du reste de l'application.
- **`onboarding_done` est conservée** : la colonne `onboarding_completed` du plan
  ferait double emploi.
- **`business_type` (4 activités) se déduit en `domain` (2 affichages)** :
  épicerie, boutique, autre → `retail` ; restaurant → `restaurant`. Le domaine
  reste le seul à décider des modules.
- **Le carnet de dettes devient gratuit.** Il est l'un des trois piliers du mode
  simple ; les rapports (rentabilité, charges, trésorerie) restent payants.
- **Prix, nombre d'utilisateurs du Starter et prestataire Mobile Money** : à
  décider au Sprint 19, après une évaluation marketing.
  **→ Évaluation rendue le 07/10/2026 ; prix arrêtés, consignés HORS du
  dépôt** (dépôt public). Ne jamais les écrire ici.

### Sprint 17 — Onboarding premier lancement (plan : 12)

| | |
|---|---|
| **Objectif** | Une boutique neuve fait sa première vente en ≤ 4 minutes |
| **Parcours** | Bienvenue → type de commerce (4 cartes) → 3 produits d'exemple (ou « mes propres produits » : nom, prix, stock) → consigne « Faites votre première vente » → **la vraie caisse, sans navigation** → félicitations (dettes / ajouter des produits / tableau de bord) |
| **SQL** | `migration_onboarding_mode.sql` : `onboarding_step` (reprise après rechargement), `business_type` |
| **Règle** | Les exemples ont du **stock** — `create_sale()` refuserait sinon la première vente. SKU `DEMO-xx`, retirables d'un clic depuis le Stock. Écrits une seule fois, même au second passage |
| **Code** | `src/lib/onboarding.ts` (données), `OnboardingWizard.tsx` réécrit, `GuidedCash.tsx`, `POSModule` gagne `onReceiptClosed` (les félicitations attendent la fermeture du reçu) |
| **Tests** | `tests/ui/onboarding.test.tsx` — 10 tests du parcours critique |

### Sprint 18 — Mode simple (plan : 13)

| | |
|---|---|
| **Objectif** | Cacher la complexité par défaut |
| **SQL** | `organizations.ui_mode` : la colonne naît à `'full'` (**les boutiques existantes gardent tout**), puis le défaut passe à `'beginner'` pour les inscriptions à venir. `GRANT INSERT/UPDATE` de colonne, sans lequel l'assistant se bloquait en « permission denied » |
| **Modules** | Mode simple = Accueil, Vente, Stock, Ventes, Dettes, Paramètres (+ Salle en restaurant). Masqués : Rapports (dont Dépenses et Rentabilité), Prévisions, Équipe, Recettes |
| **Bascule** | Paramètres → Affichage → « Passer en mode complet », réversible |
| **Tests** | Section 31 du harnais (13 contrôles : boutiques existantes en complet, inscription neuve en simple, rejeu sans effet, droits, CHECK, dettes en gratuit) · 4 tests `modules.test.ts` |

### Sprint 20 — Tableau de bord du jour et caisse mobile (plan : 15)

Fait **avant le 19** : celui-ci attend l'évaluation marketing des prix.

| | |
|---|---|
| **Objectif** | La journée comprise en 3 secondes, sur téléphone |
| **Accueil** | « Aujourd'hui » : **encaissé** (espèces / Mobile Money), **nombre de ventes**, **à recouvrer** (montant + clients, ouvre les Dettes), stock bas **seulement s'il y en a**. Mêmes sources que le Journal (`get_sales_summary`) et les Dettes (`get_customer_debts`) : un seul chiffre par notion. « … » pendant le chargement, jamais un faux « 0 F ». Nombre de produits et valeur du stock en pied de page |
| **Journal du jour, plan gratuit** | Plus d'appel à `get_cash_flow()` (403) ni de bandeau « nécessite le plan Starter » sur un écran essentiel : encaissé + nombre de ventes, une ligne discrète pour la marge. La carte « Charges du jour », qui renvoyait vers Rapports (masqué et payant), n'apparaît qu'avec le plan |
| **Caisse** | Tri « Les plus vendus » renommé « Ordre du catalogue » sans le classement (plan Pro) ; placeholder de recherche qui tient à 375 px |
| **Code** | `src/lib/hooks/useToday.ts`, `DashboardTab.tsx`, `DailyJournal.tsx`, `POSModule.tsx` |
| **Tests** | `dashboard.test.tsx` réécrit (journée, pas de faux zéro, dettes cliquables, stock bas), `daily-journal.test.tsx` + plan gratuit · `qa/accueil.mjs` |

### Sprint 21 — Rétention : relance WhatsApp et exports (plan : 16)

| | |
|---|---|
| **Relance** | Déjà en 2 gestes (« Relancer » → « Envoyer » dans WhatsApp, message pré-rempli). **Défaut trouvé** : depuis fin 2024 les mobiles béninois ont 10 chiffres (01 + 8), et `normalize_phone()` ne préfixait 229 qu'aux numéros à 8 chiffres — le lien `wa.me/0197…` ne menait nulle part. `migration_telephone_benin.sql` : nouvelle règle + réparation des fiches et ventes existantes (sauf si cela créerait un doublon de client). Côté application, `whatsappNumber()` applique la même règle aux liens de relance et de reçu |
| **Exports** | Dettes et Ventes (historique) : **Excel** (CSV au séparateur `;`, celui d'Excel en français — avec `,` tout tenait dans une colonne) et **PDF** (rapport A4 imprimable, « Enregistrer en PDF » d'Android et des ordinateurs, sans bibliothèque). Liste entière, pas la page affichée. Plan Starter ; en gratuit, une phrase calme à la place des boutons |
| **Code** | `src/lib/utils/phone.ts`, `rapport.ts`, `export.ts` (séparateur), `DebtsModule.tsx`, `SalesHistory.tsx` |
| **Tests** | Section 32 du harnais (6 contrôles), 3 tests de lien WhatsApp, `tests/ui/exports.test.tsx` (7) · `qa/exports.mjs` |
| **Hors périmètre** | Mode hors ligne de la caisse (optionnel au plan) : un chantier à part entière — file d'attente des ventes, conflits de stock au retour du réseau |

### Mesure du parcours (P3 de l'évaluation marketing) — faite le 08/10/2026

| | |
|---|---|
| **Objectif** | Les chiffres du pilote, sans outil externe : inscrits → assistant terminé → première vente → ventes en semaine 2 → ventes en semaine 4 |
| **SQL** | `migration_activation_funnel.sql` : `get_activation_funnel(p_from, p_to, p_now)` — une ligne par boutique inscrite **localement** dans la période : `onboarding_done` / `onboarding_step`, `first_sale_at`, `sales_week2`, `sales_week4` (jours **locaux** de la boutique, fenêtres `[d0+7, d0+14)` et `[d0+21, d0+28)`), `mature_week2` / `mature_week4` |
| **Règle** | Une boutique trop récente n'est **pas inactive : elle est non évaluable.** Les taux de semaine ne divisent que par les boutiques dont la fenêtre est écoulée — sinon le taux chute à chaque inscription, pour la seule raison qu'elle est récente. C'est aussi pour ça que `p_now` est un paramètre : la maturité se teste sans attendre 28 jours |
| **Sécurité** | La fonction lit **toutes** les boutiques : `REVOKE` sur `PUBLIC`, `anon` et `authenticated`, `GRANT` au `service_role` seul. Vérifié sur la base réelle après application : `anon=false, authenticated=false, service_role=true` |
| **Outil** | `npm run stats:activation` (`scripts/funnel.mjs`) : parcours + détail par boutique · `--from` / `--to` · `--exclude 'QA\|Test'` pour masquer les comptes de recette |
| **Mode d'ouverture** | P2 × P3 : `migration_display_mode.sql` (38ᵉ section) — `organizations.display_mode` = `'standalone'` (application installée) ou `'navigateur'`, NULL = **jamais relevé**. Sans défaut (le garde-fou « pas de DEFAULT sur une colonne d'affichage »), CHECK sur les deux valeurs, GRANT colonne par colonne. Le client le relève au login du **patron** seul, et seulement si le mode a changé : une écriture par changement, pas une par visite. `get_activation_funnel()` **ne change pas** (changer son type de retour coûterait un DROP + CREATE en prod pour la même information) : `scripts/funnel.mjs` fait la jointure, affiche le bloc « Ouverture de l'application » et la colonne Mode du détail. C'est l'hypothèse « la rétention vient de l'icône » qui devient mesurable dans le relevé du pilote |
| **Tests** | Section 33 du harnais, **9 contrôles** : cohorte en jour local (23 h 30 UTC est déjà le lendemain à Porto-Novo), frontière de fenêtre exclue à droite, maturité née exactement à `d0 + 14`, ACL vérifiée **à froid** (DROP + rejeu — la section 4 du harnais re-grante toutes les fonctions à `authenticated` pour tester la RLS, ce qui masquerait le `REVOKE`), rejeu sans effet · section 34, **7 contrôles** : colonnes sans défaut, CHECK contre les valeurs inconnues, les deux modes écrits et relus, NULL non inventé, jointure du relevé, **GRANT à froid** (revoke des deux formes puis rejeu — la section 4 a fait GRANT ALL sur les tables), rejeu sans doublon · UI `modeOuverture()` (2) |
| **État** | Appliquée en prod le 08/10/2026 (colonnes, contrainte, privilèges vérifiés sur `lmygvpruffpspixrsixh`). Premier relevé : **8 boutiques, toutes des comptes de recette, aucune encore évaluable** — conformément à l'évaluation (« aucun commerçant extérieur identifié »), et 8/8 « jamais relevée » : la colonne est née aujourd'hui, personne n'a encore rouvert l'app depuis. Le premier relevé utile sera celui du pilote |

### Application installable (P2 de l'évaluation marketing) — faite le 08/10/2026

| | |
|---|---|
| **Objectif** | GestionLocal s'ouvre comme une application : icône propre sur l'écran d'accueil (Android et iOS), plein écran, sans barre d'adresse — la rétention d'un commerçant passe par l'icône qu'il voit chaque jour |
| **Manifeste** | `src/app/manifest.ts` (Next le sert et le lie automatiquement en `<link rel="manifest">`) : nom, `display: standalone`, `id/scope` sur `/`, couleurs de la marque — indigo-600 (thème) et slate-50 (fond de l'application). Les textes du manifeste restent **sans aucun chiffre** : c'est un manifeste d'application, pas un document commercial |
| **Icônes** | `scripts/gen-icons.mjs` (`npm run icons:gen`, sharp déjà présent via Next) : 192, 512, **masquable** (plein cadre, le « G » dans la zone de sécurité centrale — sans quoi Android recoupe l'icône) et `apple-touch-icon` 180 (iOS ignore le manifeste). PNG générés puis commités. `viewport.themeColor` et `icons.apple` posés dans le layout |
| **Service worker** | `public/sw.js`, volontairement minimal : il ne répond que sur `/_next/static/` — fichiers hashés, jamais périmés. **Aucune donnée de commerce** (API, ventes, stock, dettes) n'est mise en cache : c'est un accélérateur de révision, **pas** le mode hors ligne (P7, chantier distinct). `Cache-Control: no-store` sur `/sw.js` (headers dans `next.config.ts`) : une stratégie de cache ne doit jamais retarder son propre déploiement. Enregistré en production seulement (`EnregistreurPWA`, monté dans le layout) |
| **Invitation** | Bannière sur l'accueil : le prompt natif `beforeinstallprompt` est capté **au montage du layout** (Chrome ne l'émet qu'une fois par page — l'écouter depuis le composant le raterait), bouton « Installer » qui consomme l'invitation une seule fois ; sur iOS, la consigne Safari (Partager → Sur l'écran d'accueil) ; refus mémorisé (`src/lib/pwa/refus.ts`, repli mémoire sans `localStorage`). Déjà installé : silencieux total. Décision isolée dans `invitationARecevoir()` (fonction pure) |
| **Tests** | `tests/ui/pwa.test.ts` (12) : champs du manifeste, **manifeste sans chiffre** (garde-fou tarifaire), les 3 icônes + l'icône iOS **vérifiées sur disque** (signature PNG — un manifeste pointant un fichier absent ne se voit qu'au téléphone), portée du service worker (`startsWith` = uniquement `/_next/static/`, jamais `supabase` ni `/api/`), matrice de décision. `tests/ui/install-prompt.test.tsx` (3) : installé → rien, téléphone → bouton puis `prompt()` natif appelé, refus tenu après un nouveau rendu. jsdom n'a pas `localStorage` : le module de refus est simulé en mémoire |
| **Recette** | Build + serveur de production : manifeste JSON servi, `/sw.js` en `no-store`, icône `200 image/png`, head avec `manifest` + `apple-touch-icon` + `theme-color`. Dans Chrome : service worker **actif** sur le scope `/`, **0 erreur console**. Chaîne complète `npm test` au vert, tests UI **233 → 248** |
| **Hors périmètre** | Mode hors ligne (P7, à décider sur la mesure du pilote), notifications push, score Lighthouse |

### Sprint 19 — Freemium (plan : 14)

| | |
|---|---|
| **Objectif** | Des limites que le **serveur** fait respecter, une offre tarifaire qui ne fuit pas du dépôt public, et une voie de paiement là où la cible paie réellement |
| **Limites serveur** | `migration_plan_config.sql` : table `plan_config` (**vide dans le dépôt**, remplie par `npm run sync:plans` — `scripts/sync-plan-config.mjs`, `--dry-run`), quotas produit et employé par triggers (`check_product_limit` / `check_employee_limit`, qui comptent aussi les invitations en attente), fenêtre d'historique posée sur la politique `SELECT` de `sales` via `within_plan_history()` (SECURITY DEFINER pour lire en anon) — **les dettes échappent à la fenêtre** (`OR NOT settled`) : récupérer son argent n'est pas un avantage payant. Fail-open partout : aucune ligne de quota posée = rien ne se bloque, le mécanisme ne devine jamais de valeur |
| **Export** | Constat : il n'existe **aucune route d'export** — les exports sont construits côté client à partir de données déjà fenêtrées par le serveur (historique borné à la fenêtre du plan, rapports verrouillés par `require_feature('reports')`, catalogue borné par le quota). Le sprint pose donc le test du verrou **en base** (`require_feature('exportCsv')` refusé en gratuit, ouvert pendant l'essai, refermé à l'expiration — contrôle 36g) : c'est ce verrou qu'appelleront les routes d'export du Sprint 21, et rien, ici, ne se bloque plus « que par l'écran » |
| **Valeurs hors dépôt** | Prix et quotas ne vivent que dans l'environnement : `NEXT_PUBLIC_PLANS_CONFIG` (`.env.local` gitignoré + variables de déploiement). Le dépôt ne contient que le mécanisme de lecture (`src/lib/utils/plans.ts`) ; les tests tournent sur une fixture fausse par construction |
| **Essai 14 jours** | `migration_trial.sql` : colonnes `trial_*` **sans GRANT d'écriture client**, `start_free_trial()` SECURITY DEFINER (patron, plan gratuit, une fois pour toujours), `current_org_plan()` conscient de l'essai. Bouton « Démarrer l'essai — 14 jours, sans carte » dans Paramètres → Abonnement — **jamais automatique à l'inscription** |
| **Page tarifs** | `/tarifs` publique (composant serveur + metadata), lien depuis la connexion ; tout ce qui y est chiffré vient de la configuration |
| **Mobile Money** | Périodes prépayées (1, 3 ou 12 mois) : `migration_mobilemoney.sql` — `payment_orders` (INSERT/UPDATE/DELETE **révoqués** côté navigateur, SELECT limité à ses propres commandes), `organizations.plan_valid_until` **sans défaut** (une colonne d'organisation avec défaut remplit toutes les lignes), `activate_prepaid_plan()` en service_role : **seule** porte d'activation, idempotente (webhook rejoué ≠ période doublée), prolongation depuis la **fin** de la période en cours. Échéance lue sans cron : `current_org_plan()` côté base, `planEffectif()` côté écran — période finie = retour au gratuit, essai résiduel jamais touché. Prestataires dans `src/lib/payments/` : **bac à sable local complet** (`PAYMENTS_SANDBOX=1`, chemin de redirection relatif), FedaPay et PayDunya en squelette qui **refusent** — aucun appel réseau avant les clés et l'essai de prestataire annoncé. Routes : `POST /api/payments/order` (montant **recalculé en serveur** — un « montant: 1 » reçoit le prix réel ou une 503), `GET /api/payments/order` (état), `POST /api/payments/callback/[provider]` (passerelle de l'URL = passerelle configurée, fail closed, confirmation en session propriétaire) |
| **Code** | `src/lib/utils/plans.ts` (`montantPeriode`, `planEffectif` daté), `src/lib/payments/*`, `src/app/api/payments/*`, `src/app/paiement/sandbox/[ref]`, `src/app/tarifs`, `SettingsModule` (bloc période prépayée), lien `/tarifs` depuis `LoginPage`, `requirePatron` mutualisé dans `user-client.ts` |
| **Tests** | Harnais : section **36** (**15 contrôles** — quotas, fail-open, essai, invitations, fenêtre + dettes, verrou d'export en base, rejeu) et section **37** (**9 contrôles** — activation, idempotence, prolongation, échéance, essai non parasité, privilèges des commandes, activation hors navigateur, employé aveugle, double rejeu). UI : `plans-config` (7), `settings-trial` (5), `tarifs` (4), `payments` (8) — **253 → 277** |
| **Déploiement** | Migrations **38 → 41**, dans l'ORDER : `trial` → `mobilemoney` → `plan_config`. En prod : appliquer les trois **puis** `npm run sync:plans` (sans cette copie, aucun quota n'est posé), le code seulement après les migrations. Variables : `PAYMENTS_PROVIDER` / `PAYMENTS_SANDBOX` — **jamais `1` sur un déploiement réel**, la confirmation locale reste fermée |

## Garde-fous permanents

- `bump_rate_limit()` doit rester en **`SECURITY DEFINER`**.
- `supabase/migration_security.sql` **n'est plus la dernière** migration du
  dépôt : le Sprint 19 a posé `migration_trial.sql`,
  `migration_mobilemoney.sql` puis `migration_plan_config.sql` après elle —
  nouvelles migrations, **toujours ajoutées à la fin de l'ORDER**. Ce qui
  compte n'est pas sa position mais l'ordre des **rejeux** : la section 19
  rejoue security (elle y re-colle ses policies), et la section 36 rejoue
  `migration_plan_config.sql` derrière pour remettre la fenêtre
  d'historique. Un fichier qui redéfinit une policy posée par security doit
  être rejoué encore après elle dans le harnais, sinon la section 19
  mesure une base qu'aucun déploiement ne ressemble à.
- La clé **`anon`** ne doit appeler que `get_business_owner_id()` et
  `can_manage_products()` — les deux helpers des policies RLS. Toute nouvelle fonction
  qui ne doit pas être exposée sans session doit en être consciente dès sa création, et
  l'assertion **22a** du harnais échoue si elle l'est.
- Toute modification SQL passe par `npm run test:db` **et** `npm run test:db:existing`.
- **PostgreSQL refuse de changer le type de retour** d'une fonction existante
  (`cannot change return type of existing function`) : toute evolution de signature passe par
  `DROP FUNCTION IF EXISTS` puis `CREATE`, **jamais** par `CREATE OR REPLACE`. Et toute migration
  qui définit une fonction déjà redéfinie plus loin doit porter ce `DROP` : le harnais rejoue
  chaque fichier sur une base déjà corrigée.
- **Le dépôt GitHub est `PUBLIC`.** Aucun prix d'achat, aucune marge, aucun
  fichier client : `import-local/` est gitignoré. Vérifier `visibility` avant
  d'ajouter un fichier de données.
- **Les valeurs de l'offre (prix, quotas) n'existent dans aucun fichier du
  dépôt** — ni code, ni SPRINTS, ni test (la fixture des tests est fausse
  par construction, et doit l'être visiblement). Elles ne vivent que dans les
  environnements : `NEXT_PUBLIC_PLANS_CONFIG` (`.env.local` gitignoré et
  variables de déploiement), recopiées en base par `npm run sync:plans`.
  Toute addition se vérifie par un grep sur le diff avant le commit — et les
  entrées du journal mentionnent les mécanismes, jamais les chiffres.
- Un **bouton dont le libellé est masqué** (`hidden sm:inline`) doit porter un
  `aria-label` : sous ce seuil il ne reste qu'une icône, qui n'a pas de nom
  accessible.
- La recherche `GET /admin/users?email=` de ce GoTrue **ignore** le paramètre : ne pas
  « simplifier » la pagination de `invitations/accept`.
- Aucune suppression de données sans afficher la liste et obtenir le feu vert.
- **`migration_onboarding_mode.sql` passe en production AVANT le code** qui
  l'utilise : sans les colonnes, l'assistant ne peut pas enregistrer son étape et
  le carnet de dettes d'une boutique gratuite affiche une erreur de plan.
- Une colonne d'affichage ajoutée à `organizations` ne naît **jamais** avec le
  défaut destiné aux nouveaux comptes : `ADD COLUMN ... DEFAULT` remplit toutes
  les lignes existantes.
- **`public/sw.js` ne répond que sur `/_next/static/`** : jamais l'API, jamais
  les données de la boutique. Étendre sa portée serait confier un cache à des
  données vivantes — le mode hors ligne (P7) est un chantier à part, avec ses
  règles de conflit, pas un `startsWith` de plus. Le test de portée dans
  `tests/ui/pwa.test.ts` échoue sur toute autre cible.
- **Le serveur OpenCode de cette machine est exposé sur le réseau local**
  (`hostname 0.0.0.0`, port `49374`, IP `192.168.8.110`) depuis le 03/10/2026, pour
  piloter les tâches depuis l'application Android. Décision du mainteneur, prise en
  connaissance du risque : cet agent peut exécuter des commandes, écrire des fichiers
  et appeler le MCP Supabase en **`service_role`** — donc écrire dans la base de
  production. Ce qui borne l'exposition n'est pas le mot de passe, c'est le pare-feu
  macOS et le fait que le réseau soit celui du Maintainer. **À ne pas exposer hors du
  Wi-Fi du Maintainer.** Pour annuler : `opencode service set hostname 127.0.0.1`
  puis `opencode service start`.

## Journal

| Date | Commit | Objet |
|---|---|---|
| 09/10/2026 | — | **Prévisions : lot honnêteté + gestes (Pro).** Le compteur « Stock suffisant » excluait mal : « tout va bien » et « on ne sait pas » étaient additionnés — les sans-données n'y figurent plus. Archivés exclus des seaux et compteurs (même filtre que le catalogue). Stock à zéro qui se vend : badge « En rupture, à commander », compté en urgent. Gestes B2B finis : lien WhatsApp fournisseur prérempli (produit + quantité, indicatif 229, `whatsappNumber()` au lieu du bricolage local) et quantité suggérée pré-remplie dans le réassort (`initialQty`, bouton étiqueté pour l'accessibilité). Total de remise à niveau en tête (trésorerie). 8 tests · **315 → 323**. Restent : distinguer dormant/nouveau, conso des ingrédients via recettes, « < 7j » qui vaut ≤, arrondi au kilo |
| 09/10/2026 | — | **Flash « boutique neuve » supprimé.** Vu en vidéo : après chaque rechargement, le tableau affichait « Bienvenue : vos trois premiers pas / Rien n'est enregistré » sur une boutique pleine, le temps que le catalogue arrive. Cause : `products` naît à `[]` et l'état vide ne distinguait pas « pas chargé » de « vide ». L'état vide attend `loadingProducts` ; en attendant, un écran neutre (squelette, `aria-label`). Tests **313 → 315** |
| 09/10/2026 | — | **Onglet « Caisse », bandeau de reprise qui tient, bouton retour.** L'onglet Vente s'appelle Caisse. Bug vérifié : la fermeture du bandeau « Reprendre la dernière vente » était un booléen remis à zéro à chaque remontage — la caisse étant démontée hors de son onglet, changer d'onglet puis revenir le faisait revenir ; la fermeture est attachée à la vente (`gl:reprise-fermee`) : cette vente-là ne revient plus, une nouvelle vente réaffiche le bandeau. Retour système : `useHistoriqueOnglets` pose une entrée par onglet (remplacement à l'ouverture) — le retour revient au tableau ou à l'écran précédent au lieu de quitter l'app. Tests **308 → 313** (persistance au remontage, nouvelle vente, pile d'historique, repli tableau de bord) |
| 09/10/2026 | — | **Copie sans « — » ni emojis.** Tous les textes visibles (écrans, titres d'onglets, messages WhatsApp, reçus papier, ticket cuisine) : tirets cadratins remplacés par virgules, deux-points ou parenthèses ; emojis retirés des reçus, relances, prévisions, inventaire, bienvenue, caisse et boutons d'impression (structure *gras* conservée sur WhatsApp). Gardés : coches ✓/✗ du tableau des formules, croix ✕ de fermeture, et le « — » des champs vides (marqueur de donnée, pas de phrase). Commentaires et docs inchangés. Tests ajustés (tarifs, dashboard, recipes, exports) · 308 inchangés |
| 09/10/2026 | — | **Vercel : variable tarifs posée, prix en ligne.** CLI connecté (code d'appareil), projet lié, `NEXT_PUBLIC_PLANS_CONFIG` ajoutée en Production (copie exacte de `.env.local`, jamais affichée), redéploiement `--prod` : `/tarifs` affiche les prix mensuels et annuels, plus aucun « — ». Le CLI a ajouté `VERCEL_OIDC_TOKEN` à `.env.local` (gitignoré, usage CLI seul) |
| 09/10/2026 | — | **P6 — relances automatiques, rappel au commerçant.** `dettes_a_relancer()` (Starter/Pro effectif : essai inclus, échéance exclue) : solde > 0, plus vieille vente ≥ 7 jours, pas de relance notée depuis 7 jours. `relance_suivi` fermée au navigateur (même régime que `payment_orders`), `marquer_relance()` qui ne bloque jamais l'envoi. Écran : section « À relancer » + pastille sur l'onglet Dettes ; le bouton Relancer ouvre WhatsApp **d'abord**, journalise ensuite (chaîne du geste préservée). Gratuit : pas de rappel, manuel inchangé. Calcul en direct choisi contre cron (données fraîches, sans secret ni panne silencieuse). Section **38** du harnais (**8 contrôles**), migration **41 → 42** · tests UI **302 → 308** |
| 09/10/2026 | — | **P8 — page d'accueil publique.** L'adresse du site n'ouvre plus le formulaire de connexion : elle sert une landing (héros, 3 captures de recette renommées dans `public/captures/`, 4 fonctions, rappel final, pied), le formulaire a sa propre adresse `/connexion` (session ouverte → retour à la racine). Bouton WhatsApp vers le numéro du commerce, texte prérempli. Pas de vidéo pour l'instant — l'emplacement viendra avec l'enregistrement. `src/app/page.tsx` devient serveur (metadata + OpenGraph) et `home-client.tsx` garde le client. Liens `/connexion` mis à jour (tarifs, register, invitation). 9 tests · tests UI **293 → 302** (tarifs.test ajusté : `/connexion` rejoint les destinations autorisées) |
| 08/10/2026 | — | **P4 — « Envoyé avec GestionLocal » sur les reçus et relances du gratuit.** Une fonction `piedDiffusion()` unique, branchée sur les trois surfaces qui quittent la boutique : reçu WhatsApp (vente espèces **et** crédit), reçu imprimé, relance de dettes. La règle lit le plan **effectif** : essai en cours = Starter donc pas de mention, période prépayée éteinte = retour au gratuit donc la mention revient ; retirée en Starter et Pro. `reminderLink()` exportée pour le test. 16 tests · tests UI **277 → 293** |
| 08/10/2026 | — | **Sprint 19 en prod.** Trois migrations appliquées dans l'ORDER (`trial` → `mobilemoney` → `plan_config`, **38 → 41**), `npm run sync:plans` (9 lignes dans `plan_config`), code poussé — Vercel a déployé, `/tarifs` en 200, routes paiement en 401 sans session. Reste à poser `NEXT_PUBLIC_PLANS_CONFIG` dans le dashboard Vercel puis à redéployer (les `NEXT_PUBLIC_*` se lisent **au build**) — sans elle, l'écran tarifs affiche « — ». `SECURITY.md` à jour : surface paiement, runbook de déploiement |
| 08/10/2026 | — | **Sprint 19 — freemium : les limites passent côté serveur, et une voie Mobile Money.** `plan_config` (quotas posés par `npm run sync:plans`, fail-open quand aucune ligne n'est posée), triggers produit/employé qui comptent les invitations en attente, fenêtre d'historique sur `sales` **avec exception des dettes** (`OR NOT settled`) ; le verrou d'export est désormais testé **en base** (36g : `require_feature('exportCsv')` refusé en gratuit, ouvert en essai, refermé à l'expiration) — les données d'export étant déjà fenêtrées par la politique, les routes viendront au Sprint 21. Prix et quotas sortis du dépôt : `NEXT_PUBLIC_PLANS_CONFIG` en environnement seul, `.env.local` gitignoré. Essai 14 jours en **bouton explicite** (`start_free_trial` : patron, plan gratuit, une fois — jamais automatique à l'inscription), page publique `/tarifs` liée depuis la connexion. Mobile Money : commandes prépayées 1/3/12 mois avec montant **recalculé côté serveur**, `activate_prepaid_plan()` service_role idempotente (prolongation depuis la fin de période), `plan_valid_until` qui éteint le plan **sans cron** (`current_org_plan()` / `planEffectif()`), prestataires FedaPay et PayDunya en squelette qui **refusent** — aucun appel réseau avant les clés et l'essai de prestataire —, bac à sable local (`PAYMENTS_SANDBOX=1`, fermé par défaut) avec page de confirmation. Sections **36** (15 contrôles) et **37** (9 contrôles) du harnais · migrations **38 → 41** · tests UI **253 → 277** |
| 08/10/2026 | — | **Caisse — « Reprendre la dernière vente » rafraîchi et refermable.** Le bandeau ne bougeait pas après une vente validée et clôturée : il n'était rafraîchi qu'indirectement, par un effet accroché à la référence du tableau `products` que le parent régénère au rechargement du catalogue — un échec ou un retard de ce rechargement, et l'ancienne vente restait affichée. Le POS recharge désormais sa dernière vente **lui-même** à chaque encaissement (`create_sale` a commité avant de renvoyer, la requête voit la vente immédiatement). Bouton **X** ajouté : la fermeture tient jusqu'au rechargement de la caisse, elle ne revient pas après chaque vente · tests UI **251 → 253** |
| 08/10/2026 | — | **Mode d'ouverture dans la mesure (P2 × P3).** `organizations.display_mode` : `'standalone'` (app installée) ou `'navigateur'`, NULL = jamais relevé — sans défaut, CHECK sur les deux valeurs, GRANT colonne par colonne (vérifié en prod : authenticated écrit, anon non). Le client le relève au login du patron, **seulement si le mode a changé** ; `get_activation_funnel()` reste intact, `npm run stats:activation` le jointure et affiche « Ouverture de l'application » + la colonne Mode du détail. Section 34 du harnais, **7 contrôles** dont un GRANT **à froid** (la section 4 re-grante les tables) · migrations **37 → 38** · tests UI **248 → 251** |
| 08/10/2026 | — | **Application installable (P2 — évaluation marketing).** Manifeste (`src/app/manifest.ts`, `display: standalone`, couleurs de la marque), icônes 192/512/masquable + `apple-touch-icon` générées par `npm run icons:gen` (vérifiées sur disque par les tests), service worker **limité à `/_next/static/`** — jamais l'API ni les ventes, le mode hors ligne reste P7 — avec `no-cache` sur `/sw.js`, bannière d'invitation sur l'accueil (prompt natif capté au montage du layout, consigne iOS, refus mémorisé). Recette serveur de prod : manifeste servi, SW **actif dans Chrome**, 0 erreur console · tests UI **233 → 248** |
| 08/10/2026 | — | **Mesure du parcours (P3 — évaluation marketing).** `get_activation_funnel(p_from, p_to, p_now)` : cohorte d'inscrits en jour **local**, assistant terminé, première vente, semaines 2 et 4 en jours locaux de la boutique, maturité explicite — un taux de semaine ne divise que par les boutiques évaluables. Réservée `service_role` (vérifié en prod : anon et authenticated refusés). `npm run stats:activation` : parcours + détail par boutique, `--exclude` pour les comptes de recette. Section 33 du harnais, **9 contrôles** (frontières de fuseau 22 h / 23 h 30, fenêtre exclusive, maturité à `d0+14`, ACL à froid, rejeu) · migrations **36 → 37** · tests UI **233** inchangés |
| 07/10/2026 | — | **Sprint 21 — relance et exports.** Numéros béninois à 10 chiffres : la relance WhatsApp menait à un numéro inexistant pour tout client saisi au format actuel — règle corrigée en base et dans l'application, 4 fiches et 4 ventes réparées en recette. Excel (`;`) et PDF A4 pour les dettes et les ventes. Recette navigateur 375 px sur deux comptes : liens de relance internationaux, Excel en colonnes, PDF lisible et sans débordement, 0 erreur · migrations **35 → 36** · tests UI **226 → 233** |
| 07/10/2026 | — | **Sprint 20 — accueil du jour et caisse mobile.** Encaissé, ventes, à recouvrer, stock bas ; Journal du jour sans refus de plan en gratuit ; tri de caisse honnête. Recette navigateur gratuit 375 px + Pro 375/1280 px : 0 débordement, **0 erreur HTTP** (le 403 de `get_cash_flow` sur chaque ouverture du journal gratuit a disparu). Au passage : un `~/package-lock.json` vide faisait croire à Next.js que le projet commençait au dossier personnel — supprimé · tests UI **223 → 226** |
| 07/10/2026 | — | **Recette navigateur des sprints 17-18**, build de production, téléphone 375 px, base de recette migrée par `scripts/supabase-sql.mjs` : épicerie + exemples, restaurant + exemples, boutique + « mes propres produits » — **21/21 et 22/22 contrôles**, rechargement en cours d'assistant, aucun débordement, aucune erreur HTTP ni JS. Compte existant : menu complet, pas d'assistant. **Défaut trouvé et corrigé** : la caisse appelait `get_units_sold_since()` (« + vendus », plan Pro) sur tous les plans — un 403 à chaque ouverture de caisse en gratuit ; l'appel n'est plus fait sans le plan. Outil : `qa/onboarding.mjs` |
| 07/10/2026 | — | **Sprints 17 et 18 — onboarding guidé et mode simple.** Assistant en 5 écrans (textes du plan au vouvoiement), 3 exemples par activité avec stock, première vente sur la vraie caisse sans navigation, félicitations après fermeture du reçu. `ui_mode` : boutiques existantes en complet, nouvelles en simple, bascule dans Paramètres. Carnet de dettes rendu au plan gratuit (`get_customer_debts()` sans `require_feature`, test 16e inversé). Section 31 du harnais (13 contrôles) · tests UI **209 → 223** · migrations **34 → 35** |
| 04/10/2026 | — | **L'onglet Paramètres n'ouvrait pas, pour tout le monde et dans les deux domaines.** La garde de `page.tsx` — « un onglet hors domaine retombe sur l'accueil » — rejetait `'settings'`, absent de `DOMAIN_MODULES` : le bouton changeait l'onglet et la même passe de rendu le remettait sur Accueil. L'écran était dans le code et inatteignable à la souris — donc **la bascule de domaine, promise comme réversible, ne l'était pas**. `'settings'` rejoint les modules communs, 2 tests. Trouvé en cherchant les exemples par domaine |
| 04/10/2026 | — | **Catalogue d'exemple par domaine** — plus aucune référence téléphonique hors d'un vieux gabarit CSV. 19 articles d'épicerie-quincaillerie (prix d'achat réels, 5 catégories) ou 17 de maquis (9 ingrédients + 4 plats **avec recettes** + 4 boissons), chargé en un clic à l'écran de bienvenue, aperçu des catégories avant de choisir, retrait en un clic depuis le Stock — bannière tant qu'il en reste. Chaque article porte un SKU `DEMO-xx`, seul moyen de les retrouver. Les exemples des champs de saisie (nom, SKU, catégorie, fournisseur) et le gabarit d'import CSV suivent le domaine. 13 tests |
| 04/10/2026 | — | **Base de caisse, les trois défauts de la recette vente corrigés** : (1) `get_sales_summary` comptait `SUM(total_amount)` là où les deux autres écrans comptaient `SUM(amount_received)` — même jour, même boutique, **42 300 F contre 34 300 F**, l'écart valant exactement la dette non réglée, alors que l'écran Dettes promet par écrit la base encaissée. Les trois lisent maintenant la même fonction. Second volet : un règlement de dette en espèces n'entrait dans **aucun** total (le CA baissait le jour où un client payait en liquide) — `credit_payments.sale_id` rattache le règlement à la vente, `gesture_id` garde un geste ventilé en un seul versement annoncé au client. (2) Une vente espèces payée 3 000 sur 5 500 était comptée entièrement encaissée et `amountGiven` n'était pas transmis : l'écran ne propose plus l'impasse, il renvoie vers Crédit, qui exige nom + téléphone. (3) `pay_customer_debt` demande le moyen et le module Dettes envoyait `'cash'` en dur : une boutique Orange Money comptait son MoMo dans « Espèces ». Sélecteur à côté du montant. 20 tests SQL, 18 tests UI |
| 04/10/2026 | — | **Recette navigateur du module vente** : 7 défauts trouvés, 4 corrigés. Champ quantité `type="number"` qui rejetait la virgule — « 2,5 kg », le geste central d'un commerce au poids, vidait la saisie ; `Stock insuffisant` qui restait affiché après correction et expliquait un refus périmé ; `2.5` sur le reçu et la pastille à côté d'un stock écrit `48,4 pce` ; `relance'` pour `relancé`. 7 tests. **Défaut non corrigé, le plus grave de la passe** : `Rapports → Ventes` compte le CA en brut (`SUM(total_amount)`), `Rentabilité` en encaissé (`SUM(amount_received)`) — 34 300 F contre 25 300 F sur la journée de recette, l'écart valant exactement la dette non réglée, alors que l'écran Dettes promet la base encaissée |
| 04/10/2026 | — | **Vérification production** : bascule du domaine `retail ↔ restaurant` OK des deux côtés en ligne (le `GRANT UPDATE(domain)` manquant est bien appliqué), carte du jour OK (`restaurant_menu_today` exclut le riz non servi le dimanche), ticket cuisine OK (plat, quantité, modificateur, note, **aucun prix**). Au passage : les 6 champs du formulaire de connexion n'avaient pas d'étiquette reliée — même défaut que le formulaire produit, corrigé |
| 04/10/2026 | — | **Commandes à emporter** : la policy d'insertion exigeait `table_id NOT NULL` alors que la colonne est nullable — le serveur ne pouvait servir aucun client à emporter, la moitié du chiffre d'affaires d'un maquis. Policy réécrite, bouton dans la Salle · recette navigateur du **profil caissier** : les 8 refus vérifiés |
| 04/10/2026 | — | **Recette navigateur automatisée du module restaurant** — 6 bugs trouvés que 153 tests ne pouvaient pas voir : `domain` sans droit d'écriture (« permission denied » à l'inscription), embed PostgREST ambigu sur `recipe_ingredients` (2 FK vers `products`), `extra_price` absent du SELECT et de `restaurant_floor` (9 000 F affichés pour 12 000 F réels), `stock_qty` absent de `recipe_costs`, étiquette « et bientôt salle » périmée, 12 champs sans étiquette reliée (formulaire produit + inscription) |
| 04/10/2026 | — | **Sprint 16 (suite) — carte de la semaine, impression cuisine, carte d'options** : `products.menu_days` + vue `restaurant_menu_today`, `printKitchenTicket()` (72 mm, jamais de prix, HTML échappé), création des options depuis Recettes · section 27 du harnais, **9 contrôles SQL** · tests **144 → 153** · `RECETTE-RESTAURANT.md` |
| 04/10/2026 | — | **Sprint 16 — restaurant : finitions** : modificateurs (« bien cuit », « double portion ») au prix et au ticket cuisine, plat du jour, **pourboire hors du chiffre d'affaires** (une manne n'est pas une recette), réservations · section 26 du harnais, **18 contrôles SQL** · tests **142 → 144** |
| 04/10/2026 | — | **Sprint 15 — restaurant : coût de matière** : table `recipe_ingredients`, `product_cost()` récursif (un plat peut contenir un plat), deux déclencheurs sur `sale_items` (coût figé = recette, ingrédients décrémentés), `add_recipe_ingredient()` qui refuse les cycles, vue `recipe_costs` · section 25 du harnais, **14 contrôles SQL** · tests **136 → 142** |
| 04/10/2026 | — | **Sprint 14 — restaurant : clôture d'addition** : `close_table_order()` transforme les lignes de commande en vente via `create_sale()`, ticket de cuisine **sans prix**, `send_order_items()`. Le fractionnement n'écrit **qu'une vente** · section 24 du harnais, **21 contrôles SQL** · tests **134 → 136** |
| 04/10/2026 | — | **Sprint 13 — restaurant : salle et commande ouverte** : `restaurant_tables` / `restaurant_orders` / `restaurant_order_items` + vue `restaurant_floor`, onglet Salle, état des plats (à envoyer / envoyé / servi). Une commande **n'encaisse rien** — `sales` reste la source unique du CA, la clôture est au Sprint 14 · section 23 du harnais, **15 contrôles SQL** · tests **128 → 134** |
| 04/10/2026 | — | **Sprint 12 — le domaine d'activité** : `organizations.domain`, question à l'inscription, navigation rendue depuis `src/lib/modules.ts`, bascule dans les réglages · tests **122 → 128** |
| 04/10/2026 | — | Correctifs de sécurité et de robustesse issus de l'audit : webhook Stripe atomique (`claim_webhook_event`), jetons d'invitation hachés (sha256), validation zod des API, verrous de stock, Sentry client, CI GitHub Actions + Gitleaks · migrations **22 → 26** |
| 03/10/2026 | — | Recette **prod** du Sprint 11 — barre de catégories, + vendus, reprise de vente, recherche tolérante |
| 03/10/2026 | `14df2b3` | POS — proposition 3 : reprendre la dernière vente (fusion, jamais écrasement) ; unités et non lignes au compteur |
| 03/10/2026 | `40bcf87` | POS — propositions 1 et 2 : recherche tolérante, catégories, + vendus sur 30 jours |
|---|---|---|
| 03/10/2026 | — | Recette **prod** du Sprint 10 — tiroir absent de l'arbre d'accessibilité quand il est fermé, `ml-16` supprimé, 64 px rendus au catalogue |
| 03/10/2026 | `0bd81ea` | Sprint 10 — le rail latéral passe en tiroir sur mobile (il recouvrait la barre du bas du POS) |
| 03/10/2026 | — | **Décision d'infrastructure** — serveur OpenCode exposé sur le réseau local (`0.0.0.0:49374`) pour piloter depuis l'app Android. Risque tracé dans les garde-fous permanents |
| 03/10/2026 | `811e7eb` | Sprint 9 — **caisse atteignable au POS** : barre fixe et panier plein écran sur mobile, la caisse n'est plus sous 43 produits de catalogue |
| 03/10/2026 | — | Recette **prod** du Sprint 9 — barre fixe servie, `pb-24` sur la grille, aucun changement en grand écran |
| 03/10/2026 | `e451839` | Sprint 8 (suite) — le fichier **livré** est vérifié par la suite de tests, plus seulement un CSV écrit en dur |
| 03/10/2026 | `40082cb` | Sprint 8 — import CSV de produits : analyseur, modale, câblage, tests 23 → 55 |
| 03/10/2026 | `953c7f9` | Dépôt public : `import-local/` gitignoré, les prix d'achat n'y entrent pas |
| 03/10/2026 | — | Recette **prod** du Sprint 8 — bouton présent et nommé, garde-fou « rien n'est écrit sans fichier » vérifié |
| 03/10/2026 | — | Recette **prod** du Sprint 7 — écran Charges : **207 444 F / 15,4 %** (contre 1 161 200 F / 86,1 %), 0 erreur JS, verrou `anon` intact |
| 03/10/2026 | `693947b` | Sprint 7 — **résultat net corrigé** : section 8 de `migration_security.sql`, CMV déduit, 5ᵉ carte, tests 19 → 23 |
| 03/10/2026 | `d168d56` | Accessibilité — **10 champs sans étiquette reliée** sur 4 onglets, balayage des 9 onglets |
| 03/10/2026 | `68860f0` | Sprint 6 — états vides homogènes sur 9 écrans + premier écran d'une boutique neuve, tests 10 → 19 |
| 03/10/2026 | — | Recette **prod** du Sprint 6 — 9/9 onglets, 0 erreur JS, 0 champ sans étiquette, Lighthouse 1.00 sur Accueil et Paramètres |
| 03/10/2026 | `6abaa4c` | Sprint 5 — accessibilité et contraste (Lighthouse a11y → 1.00 sur 5 écrans) + 10 tests de composant |
| 03/10/2026 | `3657542` | Recette des 9 onglets **en prod** — 2 profils, 0 erreur JavaScript |
| 03/10/2026 | `ae012a6` | Recomptage de la dette `eslint-disable` (24 → 25) et origine du 25ᵉ |
| 03/10/2026 | `262e8c9` | Consignation du Sprint 4.2 (titres de onglet servis) |
| 03/10/2026 | `c4ba478` | Sprint 4.2 — 3 layouts serveur portant `metadata` (titres de onglet) |
| 03/10/2026 | `7e7627a` | Recette manuelle des 9 onglets — navigateur, 2 profils, 0 erreur JS (local + prod) |
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
