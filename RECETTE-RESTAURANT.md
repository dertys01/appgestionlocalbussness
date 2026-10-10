# Recette — module restaurant

Ce document est le parcours de recette à faire **dans le navigateur**, sur un
restaurant de test. Les tests automatisés (194) vérifient la logique ; ils ne
disent pas si la salle est tenable sur un téléphone pendant un service.

Recette automatisée déjà faite le 04/10/2026, dans une transaction annulée sur
la base réelle (rien n'a été écrit) :

| Étape | Résultat attendu | Obtenu |
|---|---|---|
| Coût d'une portion (300 g riz + 0,05 L huile) | 165 F | 165 F |
| Ticket de cuisine | plat, quantité, modificateur, note, **aucun prix** | `Poulet braisé x2 (Double portion) « bien cuit »` |
| Carte du jour (dimanche) | riz servi ven/sam absent | `Huile 1L, Poulet braisé` |
| Clôture, 2 × (4 500 + 1 500), partagée en 3 | 12 000 F, part 4 000 F | 12 000 F, part 4 000 F |
| Pourboire 5 000 F | reporté, hors CA | 5 000 F, total avec pourboire 17 000 F |
| Vente écrite en base | 12 000 F | 12 000 F |
| Stock riz après 2 plats | 50 − 0,6 = 49,4 kg | 49,400 kg |
| Coût figé de la ligne | 165 F (la recette, pas 2 000) | 165,00 |
| Marge du plat | 96,3 % | 96,3 % |

---

## Préparation

1. Réglages → Domaine d'activité : **Restaurant / Maquis**.
2. Onglet **Stock** : créer les plats et les ingrédients.
   - Ingrédients : `Riz blanc` (achat 400 F, stock 50 kg), `Huile 1L` (900 F, 20 L).
   - Plat : `Poulet braisé` (vente 4 500 F).
3. Onglet **Recettes** → choisir `Poulet braisé` :
   - ingrédient `Riz blanc`, quantité **0,3** ;
   - ingrédient `Huile 1L`, quantité **0,05**.
   - Vérifier : coût de revient **165 F**, marge **4 335 F**.
   - Options : `Bien cuit` (supplément 0), `Double portion` (supplément 1 500 F).
   - Jours servis : laisser tous les jours, puis ne cocher que Ven + Sam et
     vérifier que le riz disparaît de la carte du jour.
4. Onglet **Salle** → créer `Table 1` (Terrasse, 4 places). Le bouton **Ajouter
   une table** doit rester disponible ensuite, et créer `Table 2` doit refuser un
   nom déjà pris.

## Le service

5. Toucher **Table 1** → la commande s'ouvre. Vérifier qu'aucun stock n'a bougé.
6. Choisir le plat → les **options** s'affichent. Vérifier que le premier clic
   ne valide PAS la ligne : il doit seulement charger les options.
7. Choisir `Double portion`, quantité 2, note « bien cuit » → **Ajouter à la commande**.
   Le total doit afficher **12 000 F** (2 × 6 000), pas 9 000.
   La carte doit montrer **tous** les plats, sans troncature : en créer 15 et
   vérifier que les 15 tuiles sont là.
8. Toucher **Imprimer le ticket cuisine** :
   - le ticket s'ouvre et contient plat, quantité, `Double portion`, `bien cuit` ;
   - **aucun montant n'y figure** ;
   - les lignes passent en « Envoyé » après impression.
9. Taper chaque ligne pour la faire passer « Servi ».
10. Changer la **quantité** d'une ligne déjà ajoutée (champ à droite du montant)
    puis encaisser : le total et la consommation d'ingrédients doivent suivre.
    Une quantité nulle ou négative doit être refusée.
    Le prix, lui, ne se change pas en salle : c'est le prix catalogue, plus le
    supplément du modificateur.

## L'addition

11. **Partager l'addition** → 3 parts. Le total reste 12 000 F, chaque part
    affiche 4 000 F. C'est le piège à vérifier : le partage ne crée pas trois
    ventes.
12. Saisir un **pourboire** de 5 000. Le bouton d'encaissement doit annoncer
    « Encaisser 12 000 F » — le pourboire ne s'y ajoute pas.
13. **Encaisser** en espèces. La confirmation affiche :
    `12 000 F · facture FAC-… · 4 000 F par part · pourboire 5 000 F (hors CA)`.
14. Table 1 doit être **redevenue libre**. Tenter de rouvrir la commande : elle
    doit répondre « déjà soldée ».

## Vérifications comptables (onglet Rapports)

15. **Rentabilité** : `Poulet braisé` doit apparaître avec un coût unitaire de
    **165 F**, pas 2 000 F. Le résultat net du jour doit intégrer 12 000 F.
16. **Ventes** : une seule ligne de 12 000 F pour cette table, avec la facture.
17. **Stock** : riz à 49,4 kg, huile à 19,9 L. Le stock du plat n'a pas bougé.

### Le stock du plat n'est pas une rupture

Un plat n'a pas de stock propre — c'est sa valeur naturelle, et c'est pour ça que
le catalogue d'exemple crée les plats à 0. Vérifier les deux moitiés de la règle :

- en **salle** et au **comptoir**, un plat à 0 s'ajoute normalement au panier et
  s'encaisse. Les ingrédients descendent, le plat reste à 0 ;
- un **ingrédient** manquant, lui, refuse la vente, en nommant l'ingrédient :
  « Stock insuffisant pour l'ingrédient « Riz blanc » (disponible : 0.050,
  nécessaire : 0.120) » — jamais le nom du plat ;
- un **article sans recette** à 0 reste refusé : « Rupture de stock », et la
  caisse ne l'ajoute pas au panier.

## Le patron

18. Vérifier que l'application **refuse** une recette circulaire : ajouter
    `Poulet braisé` comme ingrédient de lui-même, puis indirectement via un
    plat qui le contient. Message attendu : « la recette formerait un cercle ».
19. Vérifier l'alerte « pas assez » dans Recettes quand un ingrédient passe
    sous la quantité d'une portion.

## Le caissier

20. Inviter un employé depuis **Équipe**.
21. Depuis son compte : ouvrir une commande, ajouter des plats, envoyer en
    cuisine → **possible**.
22. Partager l'addition → **possible** (affichage seul).
23. Encaisser → **possible**, comme à la caisse. Vérifier en base que la vente
    est bien inscrite **sur le patron** et pas sur le caissier.
24. Modifier une recette, une option ou les jours servis → **impossible**.
25. Ajouter une table → **impossible**.

## Commandes à emporter

26. Bouton **« + Commande à emporter »** sous le plan : aucune table n'est
    occupée, la commande s'ouvre quand même et se clôture normalement. Après
    encaissement, le plan de salle doit être entièrement libre.
27. Reprendre l'addition de l'étape 6 et tenter de l'encaisser deux fois : le
    second doit échouer (« Cette addition est déjà soldée »), et **une seule
    vente** doit exister en base.

## Le caissier

Créer l'invitation (Équipe → adresse email → lien), l'ouvrir dans un onglet
privé, choisir nom + mot de passe. Il arrive connecté, avec sa propre session.

| Vérification | Attendu | Vérifié le 05/10/2026 |
|---|---|---|
| Ouvrir une commande, ajouter des plats, choisir un modificateur | possible | ✓ |
| Imprimer le ticket cuisine | possible | ✓ |
| Partager l'addition | possible (affichage seul) | ✓ |
| **Encaisser l'addition** | **possible** | ✓ FAC-2026-00010, **vente inscrite sur le patron** |
| Régler la carte du jour (« Servi le… ») | refusé | ✓ absent de l'écran |
| Clôturer la commande à la main (UPDATE) | refusé | ✓ 403 RLS |
| Modifier une recette | refusé | ✓ 403 RLS |
| Ajouter une option | refusé | ✓ 403 RLS |
| Ajouter une table | refusé | ✓ 403 RLS |
| Modifier un prix, changer le domaine | refusé | ✓ 0 ligne écrite |
| Solder l'addition d'un AUTRE restaurant | refusé | ✓ garde `close_table_order` |

Les refus viennent de la **RLS**, pas de l'interface : en console (clé anon +
son jeton), la même écriture renvoie `42501`. C'est le contrôle qui compte.

### Pourquoi le caissier encaisse (décidé le 05/10/2026)

La garde de `close_table_order()` exigeait le rôle `owner` ou `manager`. Mais
`create_sale()` — la caisse — n'examine pas le rôle : un caissier vend au
comptoir tous les jours. Il pouvait donc servir une table, ramasser l'argent, et
ne pas pouvoir l'écrire. Dans un maquis, le personnel est **employé** : le patron
devait solder une addition après l'autre, à chaque service.

La garde porte désormais sur « être membre de l'équipe », comme partout ailleurs.
Ce que le geste **ne déplace pas** :

- la vente est écrite avec `user_id =` le propriétaire, jamais l'identifiant du
  caissier (test 24j3) ;
- le montant facturé est lu dans les **lignes de commande**, jamais reçu du
  client à la clôture : ce qui part en caisse est la somme des lignes, pas un
  chiffre envoyé au moment de solder ;
- une ligne peut porter un prix **inférieur** au catalogue (offrir un plat),
  mais le prix catalogue est **figé dans `list_price`** à l'insertion
  (`migration_restaurant_price_trace.sql`) : la concession reste traçable. La
  protection est la traçabilité, pas un verrou — même choix qu'au comptoir,
  où bloquer la vente à perte empêcherait de solder un stock ;
- l'isolation prime sur le rôle — un patron d'une autre boutique reste dehors
  (tests 24j5-24j6).

Le seul endroit resté fermé au caissier est la **carte du jour** : choisir les
plats servis aujourd'hui est de l'administration, pas de la vente.