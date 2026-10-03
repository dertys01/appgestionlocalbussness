/**
 * Lecture d'un montant écrit comme on l'écrit ici.
 *
 * Un seul module, parce que cette lecture est subtile et qu'en écrire deux
 * versions a déjà produit deux bugs : un prix Beninaise (« 520.000 ») lu comme
 * cinq cent vingt, et un prix à la virgule décimale (« 1.200,50 ») lu comme
 * 1,2005. Les deux fois le symptôme était un prix faux, pas une erreur franche.
 */

/** Retire les espaces, fines ou non — c'est le séparateur de milliers usuel. */
function sansEspaces(s: string): string {
  return s.replace(/[\s\u00a0\u202f]/g, '');
}

/**
 * Lit un montant, à la fraction près.
 *
 * `520.000` → 520000 · `1.349.400` → 1349400 · `110k` → 110000
 * `1200.5` → 1200,5 · `15000.00` → 15000 · `1.200,50` → 1200,50
 *
 * Le séparateur décimal est le plus à droite des deux lorsqu'il y en a deux,
 * et l'autre est alors un milliers. À un seul point, c'est un milliers si les
 * groupes font trois chiffres, une décimale sinon.
 *
 * Renvoie `null` si la saisie n'est pas un nombre — pour pouvoir distinguer
 * « zéro » de « je n'ai rien lu », ce qui n'a pas le même sens dans un
 * import que dans une recherche.
 */
export function lireMontant(brut: string): number | null {
  let s = (brut ?? '').trim().toLowerCase();
  if (!s) return 0;

  let multiplicateur = 1;
  if (s.endsWith('k')) { multiplicateur = 1e3; s = s.slice(0, -1); }
  else if (s.endsWith('m')) { multiplicateur = 1e6; s = s.slice(0, -1); }

  s = sansEspaces(s).replace(/[^\d.,-]/g, '');
  if (!s || s === '-') return null;

  const point = s.lastIndexOf('.');
  const virgule = s.lastIndexOf(',');
  let normalise: string;

  if (point >= 0 && virgule >= 0) {
    normalise = point > virgule
      ? s.replace(/,/g, '')
      : s.replace(/\./g, '').replace(',', '.');
  } else if (virgule >= 0) {
    normalise = s.replace(',', '.');
  } else if (point >= 0) {
    const parts = s.split('.');
    const groupes = parts.slice(1);
    const tousMilliers =
      groupes.length > 0 && groupes.every((g) => g.length === 3) && parts[0].length <= 3;
    normalise = tousMilliers ? parts.join('') : s;
  } else {
    normalise = s;
  }

  const n = Number(normalise);
  if (!Number.isFinite(n)) return null;
  // Deux décimales, comme le NUMERIC(12,2) de la colonne.
  return Math.round(n * multiplicateur * 100) / 100;
}

/**
 * Entier strict, pour comparer une saisie à un prix de colonne.
 *
 * Accepte les trois écritures de milliers — « 150000 », « 150 000 »,
 * « 150.000 » — mais refuse le reste : « 1200.5 » n'est pas un prix de
 * colonne, et surtout « a17 » ne doit pas devenir le nombre 17. Une lecture
 * trop permissive comparerait un numéro de modèle aux prix de la boutique, et
 * ferait remonter n'importe quel article à 17 F.
 */
export function lireEntier(brut: string): number | null {
  const s = sansEspaces((brut ?? '').trim().toLowerCase());
  if (!s) return null;
  const estNombre = /^\d{1,9}$/.test(s);
  const estGroupe = /^\d{1,3}(?:[.,]\d{3})+$/.test(s);
  if (!estNombre && !estGroupe) return null;
  const n = lireMontant(brut);
  return n !== null && Number.isInteger(n) ? n : null;
}
