// SYNCHRONISATION APPLY ↔ FICHIERS — garde-fou contre la dérive silencieuse.
//
// APPLY_MIGRATIONS.sql est la référence « part de zéro » à coller dans le
// Supabase SQL Editor. Les tests de migrations appliquent les fichiers
// individuels : sans ce contrôle, une migration modifiée sans régénérer APPLY
// passe la CI vertement avec un APPLY obsolète (cas `sale_items_consume_ingredients`,
// descente récursive de l'arbre de recettes, 2026-10-06).
//
// Trois contrôles, tous purs fichiers (aucune base nécessaire) :
//   1. APPLY est exactement ce que produirait sa régénération depuis les fichiers ;
//   2. scripts/audit-prod.sql (empreintes attendues) n'a pas périmé ;
//   3. les sections ⬇ couvrent exactement les fichiers de migration — une
//      migration ajoutée sans section dans APPLY est détectée.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

let failures = 0, passes = 0;
const check = (label, ok, detail) => {
  if (ok) { passes++; console.log(`  ✓ ${label}`); }
  else { failures++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

const ROOT = process.cwd();
const run = (script, args) => {
  try {
    execFileSync(process.execPath, [path.join(ROOT, script), ...args], { encoding: 'utf8', stdio: 'pipe' });
    return { ok: true, out: '' };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() };
  }
};

console.log('APPLY_MIGRATIONS.sql ↔ supabase/*.sql — synchronisation');

const regen = run('scripts/regen-apply.mjs', ['--check']);
check(
  'APPLY_MIGRATIONS.sql = régénération depuis les fichiers',
  regen.ok,
  regen.out.split('\n')[0] || 'inconnu',
);
if (!regen.ok && regen.out) console.log(`      ${regen.out.replace(/\n/g, '\n      ')}`);

const audit = run('scripts/gen-audit-prod.mjs', ['--check']);
check(
  'scripts/audit-prod.sql = empreintes des fichiers courants',
  audit.ok,
  audit.out.split('\n')[0] || 'inconnu',
);
if (!audit.ok && audit.out) console.log(`      ${audit.out.replace(/\n/g, '\n      ')}`);

// — couverture des sections : chaque schéma/migration a sa section, rien d'autre —
const apply = fs.readFileSync(path.join(ROOT, 'APPLY_MIGRATIONS.sql'), 'utf8');
const sections = [...apply.matchAll(/^--\s+⬇\s+([\w.]+\.sql)\s*$/gm)].map(m => m[1]);
const sqlFiles = fs.readdirSync(path.join(ROOT, 'supabase'))
  .filter(f => f.endsWith('.sql'))
  .sort();
// Aides manuelles, pas des migrations à enchaîner :
const HELPERS = ['BETA_SUIVI.sql', 'TEST_ACTIVER_PRO.sql', 'VERIFIER.sql'];
const migrations = sqlFiles.filter(f => !HELPERS.includes(f));
const missing = migrations.filter(f => !sections.includes(f));
const orphans = sections.filter(s => !migrations.includes(s));
check(
  `les ${migrations.length} migrations ont chacune une section, et aucune section orpheline`,
  missing.length === 0 && orphans.length === 0 && sections.length === migrations.length,
  `sections=${sections.length} migrations=${migrations.length}`
    + (missing.length ? ` sans section=${missing.join(',')}` : '')
    + (orphans.length ? ` sections orphelines=${orphans.join(',')}` : ''),
);

console.log(`\n${passes} réussi(s), ${failures} échoué(s)`);
if (failures > 0) {
  console.log('  → corriger par : node scripts/regen-apply.mjs && node scripts/gen-audit-prod.mjs');
}
process.exit(failures > 0 ? 1 : 0);
