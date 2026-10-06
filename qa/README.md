# QA navigateur

Deux outils qui pilotent l'application dans un vrai navigateur, sur des
comptes réels et une vraie base. Ils ont été écrits parce que les tests
existants (`npm test`) ne voient que la logique : **aucun d'eux n'a de
navigateur**, et les défauts les plus graves de ce projet sont visuels — un
panier qui déborde hors de l'écran, un tiroir qui recouvre toute
l'application, un montant de dette écrasé à 2 px.

Ils ne font pas partie de `npm test` : ils demandent un navigateur, un serveur
de développement qui tourne, et une base peuplée. Ils se lancent à la main.

## Prérequis

```bash
npm install                      # installe playwright
npx playwright install chromium  # ~100 Mo, une fois, puis mis en cache
```

Si vous préférez ne pas télécharger Chromium, posez
`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` avant `npm install` : le reste du projet
fonctionne, seuls ces deux scripts seront indisponibles.

## Utilisation

Le serveur doit tourner sur le port attendu (3001 par défaut, ou
`QA_BASE=http://localhost:3000`) :

```bash
npm run dev
```

Puis, dans un autre terminal, pour un compte **commerce** et un compte
**restaurant** :

```bash
npm run qa:audit    -- <email> <motdepasse> [retail|restaurant]
npm run qa:parcours -- <email> <motdepasse> [retail|restaurant]
```

Les identifiants ne sont jamais écrits dans un fichier versionné : ce sont des
arguments de ligne de commande, pour qu'ils ne se retrouvent ni dans l'historique
de git ni dans un `.env` partagé.

## `audit.mjs` — le balayage visuel

Ouvre une session, puis passe onglet par onglet à cinq largeurs (390, 320,
768, 1280 et 1920 px). Pour chaque écran il signale :

- débordement horizontal de la page ;
- texte tronqué alors qu'il devrait tenir ;
- élément visible mais hors de son cadre ;
- cible tactile trop petite pour le doigt ;
- bouton ou icône sans nom accessible ;
- `NaN`, `undefined`, `null` affichés tels quels ;
- capture d'écran dans `qa/shots/` (jamais versionnée).

C'est cet outil qui a trouvé les deux défauts qui **empêchaient de travailler** :
le panier hors écran à 1280 px (le total et le bouton « Encaisser » étaient
hors d'atteinte), et le tiroir panier qui, à cette même largeur, passait en
couche fixe `inset-0` et recouvrait la navigation entière.

### Les deux seuils de cible tactile

L'audit applique deux règles distinctes, et ne les confond pas :

| Seuil | Norme | Effet |
|---|---|---|
| **24 px** | WCAG 2.2 AA (2.5.8) | **fait échouer** l'écran |
| **44 px** | WCAG 2.5.5 AAA, confort du doigt | **avertissement** seulement |

Cette distinction est délibérée. En faisant échouer l'audit dès 44 px, une
trentaine d'écrans échouaient en permanence — et un rapport qui crie en
permanence ne signale plus ce qui est réellement nouveau.

Ce qui reste en dessous de 44 px sur les formats tactiles, et qui est donc
signalé sans être bloquant :

- les entrées du tiroir de navigation (47 × 40) ;
- les boutons icônes (32 × 32) ;
- les filtres de période des rapports (24 px de haut) ;
- les puces de catégorie du point de vente (30 px de haut).

Les porter à 44 px est une amélioration de confort réelle, mais elle touche
beaucoup d'écrans à la fois : elle mérite son propre passage, avec un test de
non-régression par écran, plutôt qu'être faite au fil de l'eau.

## `parcours.mjs` — le parcours métier

Agit comme un commerçant — encaisser, crediter, ouvrir une table, encaisser une
addition, servir, solder une dette — et vérifie **l'écran et la base** après
chaque geste. La double vérification est délibérée : la majorité des bugs de
cette application sont « l'écran dit que c'est bon, la base dit le
contraire ».

Un échec est daté et nommé (`28n2. le crédit restant de 1 500 est enregistré
sans vente rattachée`), pas seulement compté.

## Après une modification

Relancer les deux sur les deux profils. Les chiffres attendus au moment de la
rédaction : 63 écrans en commerce et 68 en restaurant, 0 problème ; 30 et 34
vérifications de parcours, 0 échec.

Un `npm test` vert ne dit pas que l'application est utilisable : il dit que la
logique est cohérente. Ces deux scripts disent la seconde chose.