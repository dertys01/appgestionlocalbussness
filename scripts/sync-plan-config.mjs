#!/usr/bin/env node
// Pose les quotas des plans dans plan_config, à partir de
// NEXT_PUBLIC_PLANS_CONFIG (.env.local en local, le tableau de bord du
// déploiement en production pour le build).
//
// Usage :
//   node scripts/sync-plan-config.mjs               → applique et affiche
//   node scripts/sync-plan-config.mjs --dry-run     → affiche le SQL sans appliquer
//
// POURQUOI CE SCRIPT EXISTE
//   Le dépôt est public : aucun quota ne peut être écrit dans une migration.
//   plan_config est donc la table VIDE que ce script remplit. Le mécanisme
//   est versionné, les valeurs ne le sont pas.
//
// POURQUOI UN DELETE PUIS UN INSERT (et pas un upsert)
//   Synchroniser veut dire : la base contient EXACTEMENT ce que dit la
//   configuration, plus rien. Un upsert laisserait survivre un quota retiré
//   du JSON — la forme exacte de l'oubli le plus difficile à diagnostiquer.
//   Seule exception : les trois clés sont réécrites à chaque exécution, donc
//   aucun plan ni quota ne peut rester orphelin.
//
// UNE VALEUR « illimité » = 2147483647 (voir migration_plan_config.sql) :
// c'est un int comme les autres, borné en date par within_plan_history.
//
// APRÈS UN CHANGEMENT DE VALEUR : relancer ce script, puis recharger les
// écrans (les quotas affichés par l'écran viennent du build, le build du
// NEXT_PUBLIC_PLANS_CONFIG — relancer npm run build pour l'affichage, ce
// script pour la base qui tranche).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ILLIMITE = 2147483647;

const env = {};
for (const line of fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8').split('\n')) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const brut = process.env.NEXT_PUBLIC_PLANS_CONFIG ?? env.NEXT_PUBLIC_PLANS_CONFIG;
if (!brut) {
  console.error('✗ NEXT_PUBLIC_PLANS_CONFIG absente de .env.local — rien à synchroniser (et surtout, rien à deviner).');
  process.exit(2);
}

let config;
try {
  config = JSON.parse(brut);
} catch (e) {
  console.error(`✗ NEXT_PUBLIC_PLANS_CONFIG n'est pas du JSON : ${e.message}`);
  process.exit(2);
}

const PLANS = ['free', 'starter', 'pro'];
const CLES = { products: 'products', employees: 'employees', historyDays: 'history_days' };

const lignes = [];
for (const plan of PLANS) {
  const quotas = config?.quotas?.[plan];
  if (!quotas) {
    console.error(`✗ quotas.manquants pour le plan « ${plan} » — refus de synchroniser une configuration incomplète.`);
    process.exit(2);
  }
  for (const [jsonKey, dbKey] of Object.entries(CLES)) {
    const v = quotas[jsonKey];
    if (v === null || v === undefined) {
      lignes.push(`  ('${plan}', '${dbKey}', ${ILLIMITE})`);
    } else if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
      lignes.push(`  ('${plan}', '${dbKey}', ${Math.floor(v)})`);
    } else {
      console.error(`✗ quota invalide pour ${plan}.${jsonKey} : ${JSON.stringify(v)} (nombre ≥ 0 ou null attendu).`);
      process.exit(2);
    }
  }
}

const sql = `-- généré par scripts/sync-plan-config.mjs — ne pas éditer à la main
BEGIN;
DELETE FROM plan_config;
INSERT INTO plan_config (plan, key, value) VALUES
${lignes.join(',\n')};
COMMIT;
`;

if (process.argv.includes('--dry-run')) {
  console.log(sql);
  process.exit(0);
}

const token = process.env.SUPABASE_ACCESS_TOKEN ?? env.SUPABASE_ACCESS_TOKEN;
const ref = /^https:\/\/([a-z0-9]+)\.supabase\.co/.exec(env.NEXT_PUBLIC_SUPABASE_URL ?? '')?.[1];
if (!token) { console.error('✗ SUPABASE_ACCESS_TOKEN absent de .env.local'); process.exit(2); }
if (!ref) { console.error('✗ NEXT_PUBLIC_SUPABASE_URL illisible dans .env.local'); process.exit(2); }

const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: sql }),
});
const text = await res.text();
if (!res.ok) {
  console.error(`✗ ${res.status} — ${text}`);
  process.exit(1);
}
console.log(`✓ plan_config synchronisée sur ${ref} (${lignes.length} quotas)`);
console.log(text);
