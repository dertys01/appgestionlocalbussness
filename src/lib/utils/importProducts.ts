/**
 * Analyse d'un CSV de produits.
 *
 * Fonction pure : ni réseau, ni base, ni React. Tout ce qu'elle peut refuser
 * est donc testable sans lever un serveur, et l'écran d'import n'a plus qu'à
 * afficher le verdict.
 *
 * Elle est volontairement tolérante parce que le fichier vient d'Excel, en
 * français ou en anglais, et que les prix y sont écrits comme les gens les
 * écrivent : « 520.000 », « 110k », « 15 000 ». Un import qui refuse ces trois
 * écritures est un import que personne n'utilisera deux fois.
 */

/** Ligne lue, avec son diagnostic. `status` décide si elle sera insérée. */
export interface ImportRow {
  /** Numéro de ligne dans le fichier, pour que l'utilisateur sache où regarder. */
  ligne: number;
  name: string;
  sku: string | null;
  category: string | null;
  price_buy: number;
  price_sell: number;
  stock_qty: number;
  min_stock_level: number;
  status: 'ok' | 'doublon_fichier' | 'deja_present' | 'erreur';
  problem: string | null;
}

export interface ImportResult {
  rows: ImportRow[];
  /** Erreur bloquante : sans en-tête lisible, il n'y a rien à montrer. */
  erreur: string | null;
  /** En-têtes du fichier, pour l'affichage de l'aperçu. */
  colonnes: string[];
}

const CLE = (name: string) =>
  name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');

/**
 * Les deux écritures acceptées : les libellés français de l'export du projet
 * (« Prix achat (F) ») et les noms de colonnes de la base (« price_buy »).
 * Un fichier qui vient d'un autre outil tombe sur le second jeu.
 */
const COLONNES: Record<string, keyof Omit<ImportRow, 'ligne' | 'status' | 'problem'>> = {
  produit: 'name', nom: 'name', name: 'name', designation: 'name', libelle: 'name',
  sku: 'sku', reference: 'sku', ref: 'sku',
  categorie: 'category', category: 'category',
  prixachat: 'price_buy', prixachatf: 'price_buy', pricebuy: 'price_buy',
  prixvente: 'price_sell', prixventef: 'price_sell', pricesell: 'price_sell',
  stock: 'stock_qty', stockqty: 'stock_qty', quantite: 'stock_qty', qte: 'stock_qty',
  stockmin: 'min_stock_level', minstocklevel: 'min_stock_level',
};

/**
 * Un montant lu comme un humain l'écrit.
 *
 * `520.000` est cinq cent vingt mille, pas cinq cent vingt : c'est le piège de
 * ce genre de fichier, et l'inverser revient à diviser un prix par mille.
 * On tranche sur la longueur du groupe après le séparateur — trois chiffres
 * et moins de quatre avant, c'est un milliers ; sinon c'est une décimale.
 * `1200.5` reste donc 1200,5.
 */
export function parseMontant(brut: string): number | null {
  let s = brut.trim().toLowerCase().replace(/[\s\u00a0\u202f]/g, '');
  if (!s) return 0;

  let multiplicateur = 1;
  if (s.endsWith('k')) { multiplicateur = 1e3; s = s.slice(0, -1); }
  else if (s.endsWith('m')) { multiplicateur = 1e6; s = s.slice(0, -1); }

  s = s.replace(/[^\d.,-]/g, '');
  if (!s || s === '-') return null;

  const point = s.lastIndexOf('.');
  const virgule = s.lastIndexOf(',');
  let normalise: string;

  if (point >= 0 && virgule >= 0) {
    // Les deux présents : le plus à droite des deux est le séparateur décimal,
    // l'autre est un milliers. « 1.200,50 » et « 1,200.50 » doivent donner
    // 1200,5 — inverser les deux branches donnait 1,2005.
    normalise = point > virgule
      ? s.replace(/,/g, '')
      : s.replace(/\./g, '').replace(',', '.');
  } else if (virgule >= 0) {
    normalise = s.replace(',', '.');
  } else if (point >= 0) {
    // « 520.000 » et « 1.349.400 » sont des milliers ; « 1200.5 » ne l'est pas.
    // On tranche sur la longueur de chaque groupe : trois chiffres partout
    // après le premier, c'est un séparateur de milliers.
    const parts = s.split('.');
    const groupes = parts.slice(1);
    const tousMilliers =
      groupes.length > 0 &&
      groupes.every((g) => g.length === 3) &&
      parts[0].length <= 3;
    normalise = tousMilliers ? parts.join('') : s;
  } else {
    normalise = s;
  }

  const n = Number(normalise);
  if (!Number.isFinite(n)) return null;
  // Deux décimales, comme le NUMERIC(12,2) de la colonne — et pas plus, pour
  // ne pas laisser de bruit de virgule flottante derrière une soustraction.
  return Math.round(n * multiplicateur * 100) / 100;
}

/** `Oui,Non,` ou `Oui;Non;` : le séparateur se devine sur la seule en-tête. */
function detecterSeparateur(entete: string): string {
  let dansGuillemets = false;
  let points = 0;
  let virgules = 0;
  for (const c of entete) {
    if (c === '"') dansGuillemets = !dansGuillemets;
    else if (!dansGuillemets) {
      if (c === ';') points++;
      else if (c === ',') virgules++;
    }
  }
  return points > virgules ? ';' : ',';
}

/** Découpe CSV complet : guillemets, `""` échappé, CRLF ou LF. */
function splitCsv(texte: string, separateur: string): string[][] {
  const lignes: string[][] = [];
  let ligne: string[] = [];
  let champ = '';
  let dansGuillemets = false;

  for (let i = 0; i < texte.length; i++) {
    const c = texte[i];
    if (dansGuillemets) {
      if (c === '"') {
        if (texte[i + 1] === '"') { champ += '"'; i++; }
        else dansGuillemets = false;
      } else champ += c;
      continue;
    }
    // Un guillemet n'ouvre un champ que s'il est le premier caractère de ce
    // champ. Sinon c'est un caractère ordinaire : sans cette condition, le « 14" »
    // d'un nom de machine à écrire avalait la suite de la ligne et le fichier
    // entier partait en erreur sur une ligne parfaitement valide.
    if (c === '"' && champ === '') { dansGuillemets = true; continue; }
    if (c === separateur) { ligne.push(champ); champ = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') {
      ligne.push(champ);
      lignes.push(ligne);
      ligne = [];
      champ = '';
      continue;
    }
    champ += c;
  }
  if (champ !== '' || ligne.length > 0) { ligne.push(champ); lignes.push(ligne); }
  return lignes;
}

/** La clé de comparaison d'un nom : casse et espaces ne font pas le produit. */
export function cleNom(nom: string): string {
  return nom.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

export function parseProductsCsv(texte: string, nomsExistants: string[] = []): ImportResult {
  const vide: ImportResult = { rows: [], erreur: null, colonnes: [] };
  // Le BOM d'Excel se colle au premier nom de colonne et le rendrait
  // illisible : il faut le retirer avant tout le reste.
  const propre = texte.replace(/^\uFEFF/, '');
  if (!propre.trim()) return { ...vide, erreur: 'Le fichier est vide.' };

  const brut = splitCsv(propre, detecterSeparateur(propre.split(/\r?\n/, 1)[0] ?? ''));
  if (brut.length < 2) return { ...vide, erreur: 'Le fichier doit avoir une en-tête et au moins une ligne.' };

  const entete = brut[0];
  const colonnes = entete.map((c) => c.trim());

  const index: Record<string, number> = {};
  entete.forEach((col, i) => {
    const cible = COLONNES[CLE(col)];
    // La première colonne lue gagne : deux en-têtes équivalentes ne doivent
    // pas se disputer la même valeur.
    if (cible && !(cible in index)) index[cible] = i;
  });

  if (!('name' in index) || !('price_sell' in index)) {
    return {
      ...vide,
      colonnes,
      erreur:
        'Colonnes obligatoires introuvables : « Produit » et « Prix vente (F) » ' +
        `(ou « name » et « price_sell »). Trouvé : ${colonnes.join(', ')}.`,
    };
  }

  const existants = new Set(nomsExistants.map(cleNom));
  const vusDansLeFichier = new Set<string>();
  const rows: ImportRow[] = [];

  for (let n = 1; n < brut.length; n++) {
    const cellules = brut[n];
    if (cellules.every((c) => !c.trim())) continue;

    const lire = (cle: string): string => {
      const i = index[cle];
      return i === undefined ? '' : (cellules[i] ?? '').trim();
    };

    const ligne = n + 1;
    // Le parasite le plus courant dans un fichier tenu à la main : une
    // catégorie suivie d'une espace. Elle se verrait dans chaque menu.
    const categorie = lire('category').replace(/\s+/g, ' ').trim() || null;
    const name = lire('name').replace(/\s+/g, ' ').trim();
    const sku = lire('sku') || null;

    const prixAchat = parseMontant(lire('price_buy'));
    const prixVente = parseMontant(lire('price_sell'));
    const stock = parseMontant(lire('stock_qty'));
    const stockMin = parseMontant(lire('min_stock_level'));

    let status: ImportRow['status'] = 'ok';
    let problem: string | null = null;

    if (!name) {
      status = 'erreur'; problem = 'Nom manquant.';
    } else if (prixAchat === null || prixVente === null) {
      status = 'erreur'; problem = 'Montant illisible.';
    } else if (prixAchat < 0 || prixVente < 0 || (stock ?? -1) < 0 || (stockMin ?? -1) < 0) {
      status = 'erreur'; problem = 'Un montant ou un stock est négatif.';
    } else if (prixVente > 0 && prixAchat > prixVente) {
      status = 'erreur';
      problem = `Le prix de vente (${prixVente}) est inférieur au prix d'achat (${prixAchat}).`;
    } else {
      const cle = cleNom(name);
      if (existants.has(cle)) {
        status = 'deja_present';
        problem = 'Un produit porte déjà ce nom : il sera ignoré, ses prix ne bougent pas.';
      } else if (vusDansLeFichier.has(cle)) {
        status = 'doublon_fichier';
        problem = 'Ce nom apparaît deux fois dans le fichier : seule la première ligne est retenue.';
      } else {
        vusDansLeFichier.add(cle);
      }
    }

    rows.push({
      ligne,
      name,
      sku,
      category: categorie,
      price_buy: prixAchat ?? 0,
      price_sell: prixVente ?? 0,
      stock_qty: Math.round(stock ?? 0),
      min_stock_level: Math.round(stockMin ?? 0),
      status,
      problem,
    });
  }

  if (rows.length === 0) return { ...vide, colonnes, erreur: 'Aucune ligne de produit dans le fichier.' };

  return { rows, erreur: null, colonnes };
}

/** Les lignes que l'écran doit effectivement envoyer à la base. */
export function lignesImportables(result: ImportResult): ImportRow[] {
  return result.rows.filter((r) => r.status === 'ok');
}
