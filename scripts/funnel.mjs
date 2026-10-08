#!/usr/bin/env node
// Affiche le parcours d'activation des boutiques : inscrits → assistant
// terminé → première vente → ventes en semaine 2 → ventes en semaine 4.
// La mesure P3 de l'évaluation marketing, lue directement dans la base via
// get_activation_funnel() (migration_activation_funnel.sql) — aucun outil
// externe, aucune donnée qui sort du projet.
//
// Usage :
//   node scripts/funnel.mjs                          → 28 derniers jours
//   node scripts/funnel.mjs --from 2026-10-01 --to 2026-10-08
//   node scripts/funnel.mjs --exclude 'QA|Test'      → masque les boutiques de recette
//
// Lecture : les taux de semaine 2 et 4 ne divisent que par les boutiques
// ÉVALUABLES (fenêtre entièrement écoulée) — une boutique inscrite hier
// n'est pas inactive, elle est trop récente pour être jugée. Les lignes
// marquées « * » du détail sont celles-là.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const env = {};
for (const line of fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8').split('\n')) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const token = process.env.SUPABASE_ACCESS_TOKEN ?? env.SUPABASE_ACCESS_TOKEN;
const ref = /^https:\/\/([a-z0-9]+)\.supabase\.co/.exec(env.NEXT_PUBLIC_SUPABASE_URL ?? '')?.[1];
if (!token) { console.error('✗ SUPABASE_ACCESS_TOKEN absent de .env.local'); process.exit(2); }
if (!ref) { console.error('✗ NEXT_PUBLIC_SUPABASE_URL illisible dans .env.local'); process.exit(2); }

// — Arguments ————————————————————————————————————————————
const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const jour = (d) => new Date(d).toISOString().slice(0, 10);
const to = arg('--to') ?? jour(new Date());
const from = arg('--from') ?? jour(new Date(Date.now() - 27 * 86400_000));
const exclude = arg('--exclude');
if (!DATE.test(from) || !DATE.test(to)) {
  console.error(`✗ --from et --to doivent être au format AAAA-MM-JJ (reçu : ${from}, ${to})`);
  process.exit(2);
}
if (from > to) { console.error(`✗ --from (${from}) est après --to (${to})`); process.exit(2); }
let excludeRe = null;
if (exclude) {
  try { excludeRe = new RegExp(exclude); }
  catch (e) { console.error(`✗ --exclude n'est pas une expression régulière : ${e.message}`); process.exit(2); }
}

// — Lecture ——————————————————————————————————————————————
// Le mode d'ouverture (P2) n'est pas dans get_activation_funnel() : c'est un
// état courant de la boutique, pas une règle de cohorte. On le jointure —
// c'est exactement ce que fait cette requête, et le relevé reste en un seul
// aller-retour.
const sql = `SELECT f.*, o.display_mode, o.display_mode_at
  FROM get_activation_funnel('${from}'::date, '${to}'::date) f
  JOIN organizations o ON o.id = f.org_id`;
const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: sql }),
});
const text = await res.text();
if (!res.ok) {
  console.error(`✗ ${res.status} — ${text}`);
  if (/get_activation_funnel/.test(text) && /does not exist|42883/.test(text)) {
    console.error('  → migration non appliquée : node scripts/supabase-sql.mjs supabase/migration_activation_funnel.sql');
  } else if (/display_mode/.test(text) && /does not exist|42703/.test(text)) {
    console.error('  → migration non appliquée : node scripts/supabase-sql.mjs supabase/migration_display_mode.sql');
  }
  process.exit(1);
}
const all = JSON.parse(text);
const rows = (excludeRe ? all.filter((r) => !excludeRe.test(r.org_name ?? '')) : all);

// — Calcul du parcours ————————————————————————————————————
const total = rows.length;
const fini = rows.filter((r) => r.onboarding_done === true).length;
const vendu = rows.filter((r) => r.first_sale_at != null).length;
const m2 = rows.filter((r) => r.mature_week2 === true);
const m4 = rows.filter((r) => r.mature_week4 === true);
const etapes = [
  ['Inscrits', total, total],
  ['Assistant terminé', fini, total],
  ['Première vente', vendu, total],
  ['Semaine 2 : au moins 1 vente', m2.filter((r) => r.sales_week2 >= 1).length, m2.length],
  ['Semaine 2 : 5 ventes ou plus', m2.filter((r) => r.sales_week2 >= 5).length, m2.length],
  ['Semaine 4 : au moins 1 vente', m4.filter((r) => r.sales_week4 >= 1).length, m4.length],
];

const pct = (x, y) => (y === 0 ? '  —' : `${String(Math.round((x / y) * 100)).padStart(3)} %`);
console.log(`\nParcours d'activation — inscrits du ${from} au ${to}${exclude ? ` (hors /${exclude}/)` : ''}\n`);
console.log('Étape                                Comptes   Taux');
console.log('──────────────────────────────────── ──────── ──────');
for (const [label, x, y] of etapes) {
  console.log(`${label.padEnd(36)} ${`${x}/${y}`.padStart(8)} ${pct(x, y)}`);
}

// — Mode d'ouverture (P2) ————————————————————————————
// Dernier relevé : est-ce que le patron ouvre l'application depuis l'icône
// installée ou depuis le navigateur. « Jamais relevée » = le mode n'a pas
// encore été écrit (colonne à NULL — patron non reconnecté depuis la
// migration, ou écriture impossible) : c'est un trou de mesure, pas un
// mode, et il se dit comme les autres.
if (total > 0) {
  const installe = rows.filter((r) => r.display_mode === 'standalone').length;
  const nav = rows.filter((r) => r.display_mode === 'navigateur').length;
  console.log('\nOuverture de l’application (dernier relevé)     Boutiques');
  console.log('───────────────────────────────────────────── ────────');
  console.log(`${'Application installée'.padEnd(45)} ${String(installe).padStart(8)}`);
  console.log(`${'Navigateur'.padEnd(45)} ${String(nav).padStart(8)}`);
  console.log(`${'Jamais relevée (pas encore de donnée)'.padEnd(45)} ${String(total - installe - nav).padStart(8)}`);
}

// — Détail ————————————————————————————————————————————————
if (total > 0) {
  const d = (v) => (v == null ? '—' : String(v).slice(0, 10));
  const etat = (r) =>
    r.onboarding_done ? 'terminé' : (r.onboarding_step ? `arrêt: ${r.onboarding_step}` : 'non fait');
  const mode = (r) =>
    r.display_mode === 'standalone' ? 'installée' : (r.display_mode === 'navigateur' ? 'nav' : '—');
  console.log('\nDétail par boutique\n');
  console.log('Boutique                   Inscrite   Assistant    1re vente     S2   S4  Plan       Mode');
  console.log('────────────────────────── ────────── ──────────── ────────── ──── ──── ────── ─────────');
  for (const r of [...rows].sort((a, b) => String(a.org_created_at).localeCompare(String(b.org_created_at)))) {
    const s2 = r.mature_week2 ? String(r.sales_week2) : `${r.sales_week2}*`;
    const s4 = r.mature_week4 ? String(r.sales_week4) : `${r.sales_week4}*`;
    console.log(
      `${String(r.org_name).slice(0, 26).padEnd(26)} ${d(r.org_created_at).padEnd(10)} `
      + `${etat(r).slice(0, 12).padEnd(12)} ${d(r.first_sale_at).padEnd(10)} `
      + `${s2.padStart(4)} ${s4.padStart(4)} ${String(r.plan ?? '—').padEnd(6)} ${mode(r).padEnd(9)}`,
    );
  }
  console.log('\n* fenêtre pas encore écoulée : la boutique n\'est pas encore évaluable sur cette semaine.');
  console.log('  S2/S4 = ventes de la 2ᵉ / 4ᵉ semaine de vie, en jours locaux de la boutique.');
  console.log('  Mode = comment la boutique ouvre l’app : installée, nav (navigateur), — jamais relevé.');
} else {
  console.log('\nAucune inscription dans la période.');
}
