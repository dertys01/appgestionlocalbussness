// Tests de src/lib/utils/period.ts — arithmétique de dates, bornes et
// regroupement. Exécute avec : node --experimental-strip-types
import assert from 'node:assert/strict';
import {
  MAX_PERIOD_DAYS, PERIOD_PRESETS, addDays, bucketFor, bucketKey, bucketLabel,
  buildBuckets, clampRange, daysBetween, isValidRange, parseISODate,
  rangeFromDays, toISODate, todayISO,
} from '../src/lib/utils/period.ts';

let failed = 0;
const t = (label: string, fn: () => void) => {
  try { fn(); console.log(`  \u2713 ${label}`); }
  catch (e) { failed++; console.log(`  \u2717 ${label}\n      ${(e as Error).message}`); }
};

const FIXED = '2026-03-15'; // un dimanche

t('toISODate / parseISODate font l’aller-retour', () => {
  assert.equal(toISODate(parseISODate(FIXED)), FIXED);
});

t('addDays traverse le mois et l’année bissextile', () => {
  assert.equal(addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(addDays('2024-02-28', 1), '2024-02-29', '2024 est bissextile');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});

t('daysBetween compte les bornes incluses', () => {
  assert.equal(daysBetween('2026-03-01', '2026-03-01'), 1);
  assert.equal(daysBetween('2026-03-01', '2026-03-31'), 31);
  assert.equal(daysBetween('2026-03-31', '2026-04-01'), 2, 'le changement de mois compte');
  assert.equal(daysBetween('2026-01-01', '2026-12-31'), 365);
  assert.equal(daysBetween('2024-01-01', '2024-12-31'), 366, 'année bissextile');
});

t('daysBetween ne se décale pas au passage de l’heure d’été', () => {
  // Deux dates à 23 h et 1 h en heure locale : un calcul en millisecondes
  // brutes peut rendre 0 jour et faire échouer une borne.
  assert.equal(daysBetween('2026-03-28', '2026-03-30'), 3);
  assert.equal(daysBetween('2026-10-24', '2026-10-26'), 3);
});

t('rangeFromDays : N jours, aujourd’hui compris', () => {
  const r = rangeFromDays(7, '2026-03-15');
  assert.equal(r.to, '2026-03-15');
  assert.equal(r.from, '2026-03-09');
  assert.equal(daysBetween(r.from, r.to), 7);
});

t('rangeFromDays plafonne à un an', () => {
  const r = rangeFromDays(5000, '2026-03-15');
  assert.equal(daysBetween(r.from, r.to), MAX_PERIOD_DAYS);
});

t('clampRange borne une période trop longue', () => {
  const c = clampRange({ from: '2020-01-01', to: '2026-03-15' });
  assert.equal(c.to, '2026-03-15');
  assert.equal(daysBetween(c.from, c.to), MAX_PERIOD_DAYS);
  assert.equal(c.from, '2025-03-16');
});

t('clampRange respecte un plafond de plan (30 jours)', () => {
  const c = clampRange({ from: '2025-01-01', to: '2026-03-15' }, 30);
  assert.equal(daysBetween(c.from, c.to), 30);
  assert.equal(c.from, '2026-02-14');
});

t('clampRange laisse passer une période courte', () => {
  const c = clampRange({ from: '2026-03-01', to: '2026-03-15' });
  assert.equal(c.from, '2026-03-01');
  assert.equal(c.to, '2026-03-15');
});

t('isValidRange rejette les bornes inversées et le format', () => {
  assert.equal(isValidRange({ from: '2026-01-01', to: '2026-03-01' }), true);
  assert.equal(isValidRange({ from: '2026-03-01', to: '2026-01-01' }), false);
  assert.equal(isValidRange({ from: '01/03/2026', to: '2026-03-01' }), false);
});

t('bucketFor change de granularité selon l’amplitude', () => {
  assert.equal(bucketFor(7), 'day');
  assert.equal(bucketFor(31), 'day');
  assert.equal(bucketFor(32), 'week');
  assert.equal(bucketFor(120), 'week');
  assert.equal(bucketFor(121), 'month');
  assert.equal(bucketFor(365), 'month');
});

t('bucketKey semaine : la semaine commence le lundi', () => {
  // 2026-03-15 est un dimanche : il appartient à la semaine du 9 au 15.
  assert.equal(bucketKey('2026-03-15', 'week'), '2026-03-09');
  assert.equal(bucketKey('2026-03-09', 'week'), '2026-03-09');
  assert.equal(bucketKey('2026-03-16', 'week'), '2026-03-16', 'lundi suivant');
});

t('bucketKey mois', () => {
  assert.equal(bucketKey('2026-03-01', 'month'), '2026-03');
  assert.equal(bucketKey('2026-03-31', 'month'), '2026-03');
  assert.equal(bucketKey('2026-04-01', 'month'), '2026-04');
});

t('bucketLabel produit du texte lisible', () => {
  assert.equal(bucketLabel('2026-03-09', 'day'), '09/03');
  assert.ok(bucketLabel('2026-03', 'month').length > 0);
});

t('buildBuckets ne laisse aucun trou sur un mois vide', () => {
  const pts = buildBuckets({ from: '2026-03-01', to: '2026-03-31' }, 'day', () => 0);
  assert.equal(pts.length, 31);
  assert.ok(pts.every((p) => p.value === 0));
});

t('buildBuckets somme les valeurs par jour', () => {
  const values: Record<string, number> = { '2026-03-01': 100, '2026-03-05': 250 };
  const pts = buildBuckets({ from: '2026-03-01', to: '2026-03-05' }, 'day', (k) => values[k] ?? 0);
  assert.equal(pts.length, 5);
  assert.equal(pts[0].value, 100);
  assert.equal(pts[4].value, 250);
});

t('buildBuckets regroupe par semaine', () => {
  const pts = buildBuckets({ from: '2026-03-01', to: '2026-03-31' }, 'week', () => 0);
  assert.ok(pts.length >= 4 && pts.length <= 7, `attendu 4 à 7 semaines, obtenu ${pts.length}`);
  const keys = new Set(pts.map((p) => p.key));
  assert.equal(keys.size, pts.length, 'pas de doublon de colonne');
});

t('buildBuckets sur un an donne une colonne par mois', () => {
  const pts = buildBuckets(rangeFromDays(365, '2026-03-15'), 'month', () => 0);
  assert.equal(pts.length, 13, `attendu 13 mois (année partiale incluse), obtenu ${pts.length}`);
});

t('buildBuckets : la première colonne est complète, pas tronquée', () => {
  // Du 15 au 20 mars, en semaines : la colonne doit démarrer au lundi 9.
  const pts = buildBuckets({ from: '2026-03-15', to: '2026-03-20' }, 'week', () => 0);
  assert.equal(pts[0].key, '2026-03-09');
});

t('buildBuckets : la dernière colonne est tronquée à la fin demandée', () => {
  const pts = buildBuckets(rangeFromDays(7, '2026-03-15'), 'day', () => 0);
  assert.equal(pts[pts.length - 1].key, '2026-03-15');
  assert.equal(pts.length, 7);
});

t('todayISO renvoie une date valide au format attendu', () => {
  assert.match(todayISO(), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(daysBetween(todayISO(), todayISO()), 1);
});

t('les préréglages vont jusqu’à un an', () => {
  const values = PERIOD_PRESETS.map((p) => p.value);
  assert.ok(values.includes(180), '6 mois manquant');
  assert.ok(values.includes(365), '1 an manquant');
  assert.ok(values.every((v) => v <= MAX_PERIOD_DAYS));
});

console.log(`\n${failed === 0 ? '✅' : '❌'} ${failed} échec(s)`);
process.exit(failed ? 1 : 0);
