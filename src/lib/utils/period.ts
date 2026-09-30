/**
 * Sélecteur de période partagé.
 *
 * Trois modules avaient chacun leur propre liste de périodes, et aucune ne
 * dépassait 90 jours. Un commerçant qui veut comparer l'année dernière ne le
 * pouvait pas, et le code était dupliqué trois fois.
 *
 * Toutes les dates sont manipulées en heure locale puis rendues en
 * `YYYY-MM-DD`. Un `toISOString()` convertit en UTC et peut décaler le jour
 * d'un cran autour de minuit : sur une période de 365 jours, une vente
 * enregistrée à 00 h 30 se retrouve à la mauvaise journée.
 */

/** Au-delà d'un an, un rapport devient illisible et la requête coûte cher. */
export const MAX_PERIOD_DAYS = 365;

export type PeriodPreset = 7 | 30 | 90 | 180 | 365;

export const PERIOD_PRESETS: { value: PeriodPreset; label: string }[] = [
  { value: 7, label: '7 jours' },
  { value: 30, label: '30 jours' },
  { value: 90, label: '90 jours' },
  { value: 180, label: '6 mois' },
  { value: 365, label: '1 an' },
];

export interface DateRange {
  /** YYYY-MM-DD, inclus */
  from: string;
  /** YYYY-MM-DD, inclus */
  to: string;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function toISODate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function todayISO(): string {
  return toISODate(new Date());
}

export function addDays(iso: string, days: number): string {
  const d = parseISODate(iso);
  d.setDate(d.getDate() + days);
  return toISODate(d);
}

export function parseISODate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function daysBetween(from: string, to: string): number {
  const MS = 86_400_000;
  // UTC sur des dates locales : sinon un changement d'heure fait 23 h ou 25 h
  // et l'arrondi décale d'un jour. Le mois est indexé à partir de 1 pour les
  // chaînes ISO mais 0 pour Date.UTC — sans le -1, « 2026-02-14 » comptait
  // comme mars et toutes les bornes étaient fausses.
  const utc = (iso: string) => {
    const [y, m, d] = iso.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((utc(to) - utc(from)) / MS) + 1; // bornes incluses
}

/** Les N derniers jours, aujourd'hui compris. */
export function rangeFromDays(days: number, end: string = todayISO()): DateRange {
  const capped = Math.min(Math.max(1, Math.round(days)), MAX_PERIOD_DAYS);
  return { from: addDays(end, -(capped - 1)), to: end };
}

/**
 * Borne une période à `maxDays` en nombre de jours, et à `floor` si le plan
 * limite l'historique. Le retour est toujours valide : `from <= to`.
 */
export function clampRange(range: DateRange, maxDays: number = MAX_PERIOD_DAYS): DateRange {
  let { from } = range;
  const { to } = range;

  if (daysBetween(from, to) > maxDays) {
    from = addDays(to, -(maxDays - 1));
  }
  return { from, to };
}

export function isValidRange(range: DateRange): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(range.from)
    && /^\d{4}-\d{2}-\d{2}$/.test(range.to)
    && range.from <= range.to;
}

// ─── Agrégation pour l'affichage ────────────────────────────

export type Bucket = 'day' | 'week' | 'month';

/**
 * Un histogramme de 365 barres journalières est illisible sur un téléphone. On
 * regroupe donc selon l'amplitude : jours jusqu'à un mois, semaines jusqu'à
 * quatre mois, mois au-delà.
 */
export function bucketFor(days: number): Bucket {
  if (days <= 31) return 'day';
  if (days <= 120) return 'week';
  return 'month';
}

/**
 * Clé de regroupement d'une date ISO. La semaine commence le lundi, comme en
 * France : une semaine dimanche-samedi coupe les dimanches hors du graphique.
 */
export function bucketKey(iso: string, bucket: Bucket): string {
  const d = parseISODate(iso);
  if (bucket === 'day') return toISODate(d);
  if (bucket === 'month') return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  // Lundi de la semaine courante
  const shift = (d.getDay() + 6) % 7;
  return toISODate(new Date(d.getFullYear(), d.getMonth(), d.getDate() - shift));
}

/** Étiquette lisible d'une clé de regroupement. */
export function bucketLabel(key: string, bucket: Bucket): string {
  if (bucket === 'month') {
    const [y, m] = key.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString('fr-FR', { month: 'short', year: '2-digit' });
  }
  return parseISODate(key).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
}

/**
 * Series de points couvrant toute la periode, sans trous : sans cela un mois
 * sans vente disparait de l'histogramme et les mois voisins se retrouvent
 * colles, ce qui donne l'impression d'une vente quotidienne.
 */
export function buildBuckets(
  range: DateRange,
  bucket: Bucket,
  valueFor: (iso: string) => number
): { key: string; label: string; value: number }[] {
  const out: { key: string; label: string; value: number }[] = [];
  const end = parseISODate(range.to);
  const start = parseISODate(range.from);
  const cursor = new Date(start);

  // Recule jusqu'au début du bucket contenant `from`, pour que la première
  // colonne soit complète plutôt que tronquée.
  if (bucket === 'week') {
    const shift = (cursor.getDay() + 6) % 7;
    cursor.setDate(cursor.getDate() - shift);
  } else if (bucket === 'month') {
    cursor.setDate(1);
  }

  let guard = 0;
  while (cursor <= end && guard++ < 800) {
    const key = bucketKey(toISODate(cursor), bucket);
    if (!out.some((b) => b.key === key)) {
      out.push({ key, label: bucketLabel(key, bucket), value: valueFor(key) });
    }
    if (bucket === 'month') cursor.setMonth(cursor.getMonth() + 1);
    else cursor.setDate(cursor.getDate() + (bucket === 'week' ? 7 : 1));
  }
  return out;
}
