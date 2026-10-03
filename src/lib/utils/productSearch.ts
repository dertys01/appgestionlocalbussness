/**
 * Recherche de produit au point de vente.
 *
 * Fonction pure : ni réseau, ni base, ni React. Ce qu'elle classe est
 * testable sans lever de serveur — et le tri est la moitié de l'ergonomie
 * d'une caisse.
 *
 * Le catalogue d'une boutique de quartier n'est pas une bibliothèque : c'est
 * quelques centaines de références dont les noms se ressemblent. « A17 128/4 »
 * et « A17 128/6 » ne se distinguent pas à l'œil. Chercher suppose donc de
 * savoir taper — et une faute de frappe ne doit pas renvoyer « aucun
 * résultat », qui se lit comme un produit absent du stock.
 */

import { lireEntier } from '@/lib/utils/nombres';

/** Ce dont la recherche a besoin d'un produit. Le reste lui est indifférent. */
export interface Recherchable {
  name: string;
  sku?: string | null;
  category?: string | null;
  price_buy?: number | null;
  price_sell?: number | null;
}

export interface Resultat<T> {
  product: T;
  score: number;
}

/* ── Normalisation ───────────────────────────────────────────────────────── */

/** minuscules, sans accent, ponctuation réduite à l'espace */
export function normaliser(s: string): string {
  return (s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Les mots d'un nom. « HP 15-fd1311TU / core ultra 5 » donne
 * [hp, 15, fd1311tu, core, ultra, 5]. C'est ce qui permet à « 128/6 » de
 * tomber sur la bonne variante : la barre oblique est une ponctuation, pas
 * une information.
 */
export function mots(s: string): string[] {
  return normaliser(s).split(' ').filter(Boolean);
}

/* ── Distance de Levenshtein, bornée ─────────────────────────────────────── */

/**
 * Distance d'édition, avec sortie dès que la borne est dépassée.
 * On ne calcule que la ligne courante : au-delà de 100 colonnes la
 * difference ne tient plus dans un entier, et le coût n'a plus de rapport
 * avec le bénéfice sur un nom de produit.
 */
export function distance(a: string, b: string, max = 3): number {
  if (a === b) return 0;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  if (la === 0) return lb;
  if (lb === 0) return la;

  let precedente = Array.from({ length: lb + 1 }, (_, i) => i);
  for (let i = 1; i <= la; i++) {
    const courante = [i];
    let minimum = i;
    for (let j = 1; j <= lb; j++) {
      const cout = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(
        precedente[j] + 1,
        courante[j - 1] + 1,
        precedente[j - 1] + cout,
      );
      courante[j] = v;
      if (v < minimum) minimum = v;
    }
    if (minimum > max) return max + 1;
    precedente = courante;
  }
  return precedente[lb];
}

/**
 * Combien de fautes on tolère sur un mot.
 *
 * Zéro en dessous de trois caractères, et ce n'est pas de la prudence
 * typographique : « 4 » et « 6 » sont à une distance d'édition de 1, et « 128/6 »
 * trouvait donc « A17 128/4 ». Le caissier encaisse la mauvaise variante, et
 * l'écart de prix part dans la mauvaise caisse. Sur deux caractères, une
 * différence n'est jamais une faute de frappe — c'est une autre référence.
 */
function toleranceMot(mot: string): number {
  if (mot.length <= 2) return 0;
  if (mot.length <= 4) return 1;
  if (mot.length <= 8) return 2;
  return 3;
}

/* ── Score ───────────────────────────────────────────────────────────────── */

/** Un mot de la requête correspond-il à un mot du produit, faute comprise. */
function correspond(mq: string, tokens: string[]): boolean {
  for (const mn of tokens) {
    if (mn === mq || mn.startsWith(mq) || mq.startsWith(mn)) return true;
    const tol = toleranceMot(mq);
    if (Math.abs(mn.length - mq.length) <= tol && distance(mn, mq, tol) <= tol) return true;
  }
  return false;
}

/**
 * Barème, du plus fort au plus faible. Les scores ne sont pas des
 * probabilités : ils ne servent qu'à ordonner, et l'ordre est le tout.
 *
 * L'ordre entre « commence par » et « contient » est le point qui compte :
 * chercher « samsung a17 » doit d'abord proposer « Samsung A17 128/6 » et
 * ensuite « Coque pour Samsung A17 ». Noter la correspondance intérieure plus
 * haut que le préfixe inversait les deux.
 */
const SCORE = {
  exact: 1000,
  prefixe: 900,
  contient: 800,
  mot: 700,
  tousLesMots: 650,
  sku: 600,
  prix: 550,
  categorie: 500,
  approx: 300,
} as const;

function scorerUn<T extends Recherchable>(p: T, requete: string, requeteNorm: string): number {
  const nomNorm = normaliser(p.name);
  if (!requeteNorm) return 0;

  // Correspondance franche sur le nom entier.
  if (nomNorm === requeteNorm) return SCORE.exact;
  if (nomNorm.startsWith(requeteNorm)) return SCORE.prefixe;
  if (nomNorm.includes(requeteNorm)) return SCORE.contient;

  const motsDuNom = mots(p.name);
  const motsRequete = requeteNorm.split(' ').filter(Boolean);

  // Tout ce sur quoi un mot de la requête peut porter : le nom, le code, et la
  // catégorie — « laptop hp » doit trouver le HP du rayon portable.
  const tousTokens = [
    ...motsDuNom,
    ...mots(p.sku ?? ''),
    ...mots(p.category ?? ''),
  ];

  /**
   * Une requête composée — « 128/6 », « a17 5g » — doit être satisfaite en
   * entier, faute de faute comprise.
   *
   * Sinon « 128/6 » ramenait aussi « A17 128/4 » : un seul des deux mots
   * suffisait. Le caissier voit alors une 4 Go au moment de vouloir une 6 Go,
   * et l'écart de prix — 9 000 F — part dans la mauvaise caisse. Une
   * correspondance partielle sur une saisie à plusieurs mots est donc
   * éliminatoire, pas seulement moins bien classée.
   */
  if (motsRequete.length > 1) {
    return motsRequete.every((mq) => correspond(mq, tousTokens))
      ? SCORE.tousLesMots
      : -1;
  }

  const motExact = motsRequete.some((mq) => motsDuNom.some((mn) => mn === mq));
  if (motExact) return SCORE.mot;

  // SKU / code-barres.
  const sku = normaliser(p.sku ?? '');
  if (sku && (sku === requeteNorm || sku.includes(requeteNorm))) return SCORE.sku;

  // Un nombre tapé est aussi un prix. « 150000 » doit trouver le produit à
  // 150 000 F même si aucun nom ne contient ce nombre.
  const saisi = lireEntier(requete);
  if (saisi !== null) {
    const achete = Number(p.price_buy ?? 0);
    const vendu = Number(p.price_sell ?? 0);
    if (vendu === saisi || achete === saisi) return SCORE.prix;
  }

  // Catégorie : « laptop », « smartphones ».
  const cat = normaliser(p.category ?? '');
  if (cat && (cat === requeteNorm || cat.includes(requeteNorm))) return SCORE.categorie;

  // Enfin la tolérance aux fautes, mot à mot.
  for (const mr of motsRequete) {
    for (const mn of motsDuNom) {
      const tol = toleranceMot(mr);
      if (Math.abs(mn.length - mr.length) > tol) continue;
      if (distance(mn, mr, tol) <= tol) {
        // Le début du mot compte plus : « sams » doit retrouver « samsung »
        // avant « poisson ».
        return SCORE.approx + (mn.startsWith(mr.slice(0, Math.min(3, mr.length))) ? 20 : 0);
      }
    }
  }

  return -1;
}

/**
 * Classe les produits par pertinence. Les non trouvés sont retirés, pas
 * remontés en fin de liste : afficher 1000 cartes dont aucune ne correspond
 * ferait croire que la recherche a échoué.
 */
export function rechercher<T extends Recherchable>(
  products: T[],
  requete: string,
): Resultat<T>[] {
  const requeteNorm = normaliser(requete);
  const out: Resultat<T>[] = [];

  for (const product of products) {
    const score = scorerUn(product, requete, requeteNorm);
    if (score >= 0) out.push({ product, score });
  }

  return out.sort((a, b) =>
    b.score !== a.score
      ? b.score - a.score
      : a.product.name.localeCompare(b.product.name, 'fr'),
  );
}

/** Identifiants des produits vendus recently, du plus vendu au moins vendu. */
export function plusVendus(map: Record<string, number>): string[] {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);
}
