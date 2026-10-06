#!/usr/bin/env node
// Régénère APPLY_MIGRATIONS.sql : concaténation des fichiers supabase/ dans
// l'ordre des sections (bannières ⬇), en conservant l'en-tête et le format.
//
// Usage :
//   node scripts/regen-apply.mjs           → réécrit APPLY_MIGRATIONS.sql
//   node scripts/regen-apply.mjs --check   → ne rien écrire ; exit 1 si APPLY
//                                            diffère de ce que produirait la
//                                            régénération (usage CI)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APPLY = path.join(ROOT, 'APPLY_MIGRATIONS.sql');
const BANNER = /^--\s+⬇\s+([\w.]+\.sql)\s*$/;
const RULE = /^--\s+=+$/;
const check = process.argv.includes('--check');

const current = fs.readFileSync(APPLY, 'utf8');
const lines = current.split('\n');

const marks = [];
for (let i = 0; i < lines.length; i++) {
  const m = BANNER.exec(lines[i]);
  if (m) marks.push({ file: m[1], line: i });
}
if (marks.length < 2) {
  console.error('✗ Aucune bannière ⬇ exploitable dans APPLY_MIGRATIONS.sql');
  process.exit(2);
}
const firstOpener = marks[0].line - 1;
if (!RULE.test(lines[firstOpener] ?? '')) {
  console.error('✗ Bannière d’ouverture introuvable avant la première section');
  process.exit(2);
}

// En-tête conservé tel quel (notice de haut de fichier + blancs de séparation).
const out = lines.slice(0, firstOpener);
for (let i = 0; i < marks.length; i++) {
  const mk = marks[i];
  if (i > 0) out.push(''); // ligne blanche avant chaque bannière
  const opener = lines[mk.line - 1];
  const closer = lines[mk.line + 1];
  if (!RULE.test(opener ?? '') || !RULE.test(closer ?? '')) {
    console.error(`✗ Bannière malformée près de la ligne ${mk.line + 1} (${mk.file})`);
    process.exit(2);
  }
  const file = path.join(ROOT, 'supabase', mk.file);
  if (!fs.existsSync(file)) {
    console.error(`✗ Fichier manquant : supabase/${mk.file}`);
    process.exit(2);
  }
  // Le contenu du fichier, sans son newline final (repris par le join) :
  // un fichier se terminant sans newline (migration_ca_caisse.sql) reste ainsi
  // sans newline en fin d'APPLY, comme historiquement.
  const content = fs.readFileSync(file, 'utf8').split('\n');
  if (content.at(-1) === '') content.pop();
  out.push(opener, lines[mk.line], closer, '', ...content);
}
const built = out.join('\n');

if (check) {
  if (built === current) {
    console.log(`✓ APPLY_MIGRATIONS.sql à jour (${marks.length} sections, fichiers à jour)`);
    process.exit(0);
  }
  const a = current.split('\n');
  const b = built.split('\n');
  let first = 0;
  while (first < a.length && first < b.length && a[first] === b[first]) first++;
  console.error(`✗ APPLY_MIGRATIONS.sql diffère de la régénération depuis les fichiers`);
  console.error(`  première divergence : ligne ${first + 1}`);
  console.error(`  actuel ${a.length} lignes / régénéré ${b.length} lignes`);
  console.error(`  → corriger avec : node scripts/regen-apply.mjs`);
  process.exit(1);
}
fs.writeFileSync(APPLY, built);
console.log(`✓ APPLY_MIGRATIONS.sql régénéré (${marks.length} sections, ${built.split('\n').length} lignes)`);
