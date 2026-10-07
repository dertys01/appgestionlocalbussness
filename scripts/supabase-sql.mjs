#!/usr/bin/env node
// Exécute du SQL sur le projet Supabase de .env.local, via l'API de gestion
// (https://api.supabase.com/v1/projects/{ref}/database/query).
//
// Usage :
//   node scripts/supabase-sql.mjs supabase/migration_x.sql   → applique un fichier
//   node scripts/supabase-sql.mjs --query "SELECT 1"         → une requête
//
// Le jeton (SUPABASE_ACCESS_TOKEN) est un jeton PERSONNEL : il ouvre tous les
// projets du compte, pas seulement celui-ci. Il vit dans .env.local, ignoré par
// git, et nulle part ailleurs.
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

const args = process.argv.slice(2);
let query;
if (args[0] === '--query') query = args.slice(1).join(' ');
else if (args[0]) query = fs.readFileSync(path.resolve(args[0]), 'utf8');
else { console.error('Usage : supabase-sql.mjs <fichier.sql> | --query "SQL"'); process.exit(2); }

const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query }),
});
const text = await res.text();
if (!res.ok) {
  console.error(`✗ ${res.status} — ${text}`);
  process.exit(1);
}
console.log(args[0] === '--query' ? text : `✓ ${args[0]} appliquée sur ${ref}\n${text}`);
