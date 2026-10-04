# Recette — module restaurant

Ce document est le parcours de recette à faire **dans le navigateur**, sur un
restaurant de test. Les tests automatisés (153) vérifient la logique ; ils ne
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
4. Onglet **Salle** → créer `Table 1` (Terrasse, 4 places).

## Le service

5. Toucher **Table 1** → la commande s'ouvre. Vérifier qu'aucun stock n'a bougé.
6. Choisir le plat → les **options** s'affichent. Vérifier que le premier clic
   ne valide PAS la ligne : il doit seulement charger les options.
7. Choisir `Double portion`, quantité 2, note « bien cuit » → **Ajouter à la commande**.
   Le total doit afficher **12 000 F** (2 × 6 000), pas 9 000.
8. Toucher **Imprimer le ticket cuisine** :
   - le ticket s'ouvre et contient plat, quantité, `Double portion`, `bien cuit` ;
   - **aucun montant n'y figure** ;
   - les lignes passent en « Envoyé » après impression.
9. Taper chaque ligne pour la faire passer « Servi ».
10. Changer une quantité ou le prix d'une ligne, puis encaisser : vérifier que le
    total suit.

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
23. Encaisser → **impossible**, le bouton replaced par « Demandez l'addition ».
24. Modifier une recette, une option ou les jours servis → **impossible**.
25. Ajouter une table → **impossible**.

## Le piège final

26. Reprendre la commande de l'étape 6 et tenter de l'encaisser deux fois : le
    second doit échouer, et **une seule vente** doit exister en base.