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

## Garde-fous permanents

- `bump_rate_limit()` doit rester en **`SECURITY DEFINER`**.
- `supabase/migration_security.sql` doit rester la **dernière** migration du dépôt.
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
- Un **bouton dont le libellé est masqué** (`hidden sm:inline`) doit porter un
  `aria-label` : sous ce seuil il ne reste qu'une icône, qui n'a pas de nom
  accessible.
- La recherche `GET /admin/users?email=` de ce GoTrue **ignore** le paramètre : ne pas
  « simplifier » la pagination de `invitations/accept`.
- Aucune suppression de données sans afficher la liste et obtenir le feu vert.
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
