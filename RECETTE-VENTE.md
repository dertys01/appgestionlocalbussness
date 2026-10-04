# Recette — le module vente (caisse)

Recette faite dans le navigateur, sur le vrai serveur, avec un vrai compte
patron (`recette.maquis@test.local`). Chaque ligne est un geste que fait un
caissier, pas une fonction testée à vide.

Dernière passe : **04/10/2026**. 7 ventes en(base), dont 3 à crédit.

---

## Préparer

1. Se connecter en patron sur un compte `domain = restaurant` (le POS est
   commun aux deux domaines — il doit marcher dans une maquis comme dans une
   épicerie).
2. Trois produits suffisent : `Riz blanc` (poids, `unit = kg`), `Huile 1L`
   (`unit = L`), `Poulet braisé` (pièce).
3. Noter le stock avant, dans l'onglet **Stock** : il doit baisser exactement
   du vendu après chaque vente.

---

## La vente d'espèces

| # | Geste | Attendu |
|---|---|---|
| 1 | Cliquer deux produits pour les mettre au panier | le total suit, les pastilles de quantité apparaissent |
| 2 | Changer une quantité au clavier | le total se recalcule ; le champ accepte `2,5` **et** `1.5` |
| 3 | Saisir un prix unitaire négocié | `−200 F` sur la ligne, `Prix catalogue` barré, `Remise accordée` en bas |
| 4 | `Montant donné` = 10 000 sur 5 500 | `Monnaie à rendre 4 500 F` |
| 5 | `Encaisser` | `✅ Vente enregistrée !`, le panier se vide, le stock baisse |

Le reçu imprimé contient : numéro de facture (plan Pro), vendeur, date, chaque
ligne avec prix unitaire **et** la remise, le total, le moyen de paiement,
`Reçu` + `Monnaie` en espèces. Aucun stock, aucun coût d'achat.

---

## Le refus de stock

| # | Geste | Attendu |
|---|---|---|
| 6 | Demander 500 d'un produit dont il reste 98 | `Stock insuffisant pour « … » (disponible : 98, demandé : 500)` |
| 7 | **Rien ne doit être écrit** | toujours 1 vente de moins qu'avant : vérifier dans **Ventes** |
| 8 | Corriger la quantité | le message rouge disparaît, on peut encaisser |

L'étape 8 est celle qui a été corrigée : l'erreur restait affichée après
correction, et expliquait un refus qui n'avait plus lieu d'être.

---

## La vente à crédit

| # | Geste | Attendu |
|---|---|---|
| 9 | Cliquer `Crédit` | `Encaisser` devient `Céder à crédit` ; l'acompte et le reste à recouvrer apparaissent |
| 10 | Bouton laissé vide ou sans téléphone | **désactivé** — le serveur exigerait le téléphone |
| 11 | Nom + téléphone + acompte 2 000 sur 5 600 | bouton `Encaisser 2 000 F — dû 3 600 F` |
| 12 | Valider | `🤝 Vente cédée à crédit`, `Encaissé 2 000 F`, `Reste dû 3 600 F` |
| 13 | Le reçu | `Crédit — à recouvrer`, `Déjà versé`, `Reste à régler` |
| 14 | Onglet **Dettes** | le client apparaît, `Déjà versé 2 000 F sur 5 600 F` |

Le téléphone est normalisé en base (`22901234567` pour `01234567`) : c'est ce
numéro qui sert à la relance WhatsApp.

---

## Le règlement d'une dette

| # | Geste | Attendu |
|---|---|---|
| 15 | `Encaisser` sur la fiche du client, saisir 1 600 | `Total à recouvrer` baisse de 3 600 à 2 000 |
| 16 | Encaisser le reste | `Aucune dette en cours` |
| 17 | La vente est `settled` | **Rapports** la compte enfin dans le chiffre d'affaires |

Solder une vente à crédit **modifie le chiffre d'affaires du jour où la vente a
eu lieu**, pas celui du règlement (choix documenté dans
`supabase/migration_expenses.sql`).

---

## Le paiement MoMo et la reprise

| # | Geste | Attendu |
|---|---|---|
| 18 | `MoMo` puis encaisser | le reçu dit `Mobile Money`, sans `Reçu` ni `Monnaie` |
| 19 | `Reprendre la dernière vente` | la même panier revient, quantités comprises |

---

## Ce que la recette a trouvé

Sept défauts, tous invisibles aux 153 tests de l'époque parce qu'ils ne
passaient pas par le navigateur.

| Gravité | Défaut | Corrigé |
|---|---|---|
| **ÉLEVÉ** | Champ quantité `type="number"` : la virgule est rejetée. « 2,5 kg » — le geste central d'un commerce au poids — vidait la saisie | `type="text"` + `inputMode="decimal"`, filtrage inchangé |
| **ÉLEVÉ** | `Stock insuffisant` reste affiché après correction du panier : il expliquait un refus périmé et la vente suivante restait entachée d'un avertissement caduc | l'erreur suit tout ce qui décrit la vente |
| **ÉLEVÉ** | Le reçu imprimait `2.5` et le badge `2.5`, à côté d'un stock écrit `48,4 pce` | `formatQty` partout |
| **MOYEN** | `relance'` — apostrophe parasite à la place de l'accent | `relancé` |
| **MOYEN** | Vente espèces : `amountGiven` n'est pas envoyé, une vente « payée 3 000 sur 5 500 » est comptée entièrement encaissée | documenté, non corrigé — le serveur ne peut pas savoir l'intention |
| **FAIBLE** | Rentabilité : `Vendus 6,5` arrondi à 7 dans le tableau, alors que le graphe dit 6,5 | non corrigé |

### Ce qui reste ouvert

- **Le CA n'a qu'une seule base, mais deux écrans la nomment différemment.**
  `Rapports → Ventes` compte `SUM(total_amount)` (brut), `Rapports →
  Rentabilité` compte `SUM(amount_received)` (encaissé). Sur la journée de la
  recette : **34 300 F** d'un côté, **25 300 F** de l'autre — l'écart est
  exactement la dette non réglée. L'écran Dettes promet pourtant « une vente à
  crédit n'entre pas dans le chiffre d'affaires : elle y entre quand vous
  encaissez ». **Deux des trois écrans contredisent la phrase du troisième.**
  C'est le défaut le plus grave de cette recette et il n'est pas corrigé : le
  choix (brut ou encaissé) est une décision de gestion, pas un bug.