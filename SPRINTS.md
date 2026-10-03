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

`supabase/migration_security.sql` porte les **6 sections** (1 `rate_limits` hors portée client ·
2 `organizations.plan` verrouillé · 3 `subscriptions` une ligne par org · 4 `business_members`
lecture seule · 5 `sales`/`sale_items`/`stock_logs` lecture seule · 6 suppression de compte).

Vérifications de référence, à maintenir à chaque étape :
`npx tsc --noEmit` · `npm run lint` · `npm run build` · `npm test` — tous en **code de sortie 0**.

---

## Sprint 3 — Le poids mort : la performance avant les fonctionnalités

Aucune écriture SQL. **Aucun SQL à coller** pour ce sprint entier.

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

**État :** **845 lignes**, `'use client'` en l.1, **4 composants** déclarés au niveau module :

| Ligne | Composant | Rôle |
|---|---|---|
| 48 | `HomePage` | shell + les **9 onglets** (l.283 → l.472) + modals (l.473 → l.498) |
| 499 | `OrgLoadFailed` | état d'erreur d'organisation |
| 539 | `OrgSetupRequired` | état d'onboarding |
| 600 | `LoginPage` | **246 lignes**, de la l.600 à la l.845 |

**Ordre de découpage proposé** (du plus sûr au plus structurant) :

1. `LoginPage` (l.600-845) → `src/components/auth/LoginPage.tsx` — extrême, aucune dépendance vers les onglets.
2. `OrgLoadFailed` + `OrgSetupRequired` (l.499-599) → `src/components/onboarding/` — deux composants d'état pur.
3. Les **modals** (l.473-498 : `ProductForm`, `RestockModal`, `BarcodeScanner`, `OnboardingWizard`) → déplacement simple, déjà importés en l.35-39.
4. L'onglet **dashboard** (l.283-356, JSX interne : stats Produits / Valeur stock / Stock critique) → `src/components/dashboard/DashboardTab.tsx`.
5. Ne restent dans `page.tsx` que le shell, `NAV_ITEMS` (l.176-184) et le `switch` des onglets.

**Fini quand :** `page.tsx < 300 lignes`, `tsc`/`lint`/`build`/`npm test` à 0, et **aucun
changement de comportement** — le Sprint 4.1 est un déplacement, pas une refonte.

### 4.2 Remettre du server-side là où ça a un sens

**État :** 4 pages, **4 sur 4 en `'use client'`** (`/`, `/reset-password`, `/register`,
`/invitation/[token]`). Seul `src/app/layout.tsx` est un server component (il porte déjà
`metadata`).

Conséquence : un composant client ne peut pas exporter `metadata`, donc **aucune de ces pages
ne peut porter de titre ou de description propres**.

**À faire :** envelopper chaque page d'un layout serveur mince qui porte `metadata`, en
laissant le composant client en enfant. Ne pas chercher à « serverizer » le POS : la caisse,
le scanner code-barres et les listes en temps réel sont légitimement côté client.

**Fini quand :** `/register` et `/reset-password` affichent un titre de onglet propre, sans
toucher au reste.

### 4.3 Dette TypeScript, au fil de l'eau

**État :** 24 `eslint-disable` dans 17 fichiers, répartis ainsi :

- **16** `@typescript-eslint/no-explicit-any` — dont `SupabaseProvider.tsx:50,80,102,118`,
  `BarcodeScanner.tsx:17,37`, `ExpensesModule.tsx:83,160`, `InventoryTable.tsx:115`,
  et 5 dans les routes API (`accept:163`, `portal:38`, `checkout:55`, `webhook:94`).
- **8** `react-hooks/exhaustive-deps` — dont `SupabaseProvider.tsx:203`, `SalesHistory.tsx:72`,
  `TeamModule.tsx:151`.

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
+ recette manuelle des 9 onglets
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
- Toute modification SQL passe par `npm run test:db` **et** `npm run test:db:existing`.
- La recherche `GET /admin/users?email=` de ce GoTrue **ignore** le paramètre : ne pas
  « simplifier » la pagination de `invitations/accept`.
- Aucune suppression de données sans afficher la liste et obtenir le feu vert.

## Journal

| Date | Commit | Objet |
|---|---|---|
| 03/10/2026 | `8013458` | Compteur d'inscription après validation |
| 03/10/2026 | `3a179dc` | Rate limit de `proxy.ts` en production |
| 02/10/2026 | `ab2aef0` | Réparation de l'API Auth et de la suppression de compte |
| — | `324e288` | Sprint 1 + Sprint 2 |
