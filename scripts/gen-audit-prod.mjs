#!/usr/bin/env node
// Génère scripts/audit-prod.sql — contrôle « signatures + logique » à exécuter
// sur une base réelle (Supabase SQL Editor ou psql). Les empreintes attendues
// proviennent des fichiers supabase/ dans l'ordre des sections APPLY.
//
// Usage :
//   node scripts/gen-audit-prod.mjs           → réécrit scripts/audit-prod.sql
//   node scripts/gen-audit-prod.mjs --check   → ne rien écrire ; exit 1 si le
//                                               fichier committed est périmé
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'scripts', 'audit-prod.sql');
const APPLY = path.join(ROOT, 'APPLY_MIGRATIONS.sql');
const BANNER = /^--\s+⬇\s+([\w.]+\.sql)\s*$/gm;
const check = process.argv.includes('--check');

const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');
// Code = corps sans commentaires (pleine ligne et en fin de ligne), espaces
// réduits : invariant validé 42/42 entre Postgres et ce parseur.
const logicOf = (body) => body.split('\n')
  .map(l => l.replace(/[ \t]+/g, ' ').replace(/^ +| +$/g, ''))
  .filter(l => l !== '' && !l.startsWith('--'))
  .map(l => l.replace(/[ \t]+--.*$/, '').replace(/^ +| +$/g, ''))
  .filter(l => l !== '')
  .join(' ');

// — parseur de définitions de fonction (corps entre $$, signatures normalisées) —
const TYPES = new Set(['uuid', 'text', 'json', 'jsonb', 'integer', 'int', 'bigint', 'smallint', 'boolean', 'bool',
  'numeric', 'decimal', 'real', 'double', 'character', 'varchar', 'bpchar', 'date', 'time', 'timestamp', 'timestamptz',
  'interval', 'bytea', 'serial', 'oid', 'name', 'money']);
const ALIAS = {
  int: 'integer', int4: 'integer', int8: 'bigint', int2: 'smallint', bool: 'boolean',
  varchar: 'character varying', bpchar: 'character', decimal: 'numeric',
  float8: 'double precision', float4: 'real', timestamptz: 'timestamp with time zone',
  timetz: 'time with time zone',
};
function splitArgs(s) {
  const res = [];
  let depth = 0, cur = '', inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      cur += c;
      if (c === "'") {
        if (s[i + 1] === "'") { cur += s[i + 1]; i++; } else inStr = false;
      }
      continue;
    }
    if (c === "'") { inStr = true; cur += c; continue; }
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) { res.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) res.push(cur);
  return res;
}
function parseType(arg) {
  let a = arg.trim().replace(/^(IN|OUT|INOUT|VARIADIC)\s+/i, '');
  if (!a) return null;
  a = a.replace(/\s+DEFAULT\s+[\s\S]*$/i, '');
  const m = /^([A-Za-z_][A-Za-z0-9_$]*)(\s*\([\d,\s]*\))?(\s+[\w" ].*)?$/.exec(a);
  if (!m) return null;
  const first = m[1], rest = (m[3] || '').trim();
  let type;
  if (TYPES.has(first.toLowerCase())) type = first + (m[2] || '') + (rest ? ' ' + rest : '');
  else {
    type = rest;
    if (!type) return null;
    const tm = /^([A-Za-z_][A-Za-z0-9_$]*)(\s*\([\d,\s]*\))?/.exec(type);
    if (!tm) return null;
    type = tm[1] + (tm[2] || '');
  }
  type = type.toLowerCase().replace(/\(\s*\d+(\s*,\s*\d+)?\s*\)/g, '').replace(/\s+/g, ' ').trim();
  if (ALIAS[type]) type = ALIAS[type];
  return type || null;
}
const normSig = (s) => s.replace(/\s+/g, '');

// Événements (CREATE porte le corps, DROP efface) d'un texte SQL
function parseEvents(src) {
  const events = [];
  let m;
  const reCreate = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([A-Za-z_][A-Za-z0-9_$]*)\s*\(([\s\S]*?)\)\s*RETURNS\b/g;
  while ((m = reCreate.exec(src))) {
    const lineStart = src.lastIndexOf('\n', m.index) + 1;
    if (/^\s*--/.test(src.slice(lineStart, m.index))) continue;
    const types = splitArgs(m[2]).map(parseType);
    if (types.some(t => t === null)) continue;
    const sig = normSig(`${m[1]}(${types.join(', ')})`);
    const win = src.slice(m.index);
    let body = null;
    const dq = /AS\s+(\$[A-Za-z0-9_]*\$)/.exec(win);
    if (dq) {
      const open = dq.index + dq[0].length;
      const close = win.indexOf(dq[1], open);
      if (close > 0) body = win.slice(open, close);
    } else {
      const sq = /AS\s+'((?:[^']|'')*)'/.exec(win);
      if (sq) body = sq[1].replace(/''/g, "'");
    }
    if (body === null) continue;
    events.push({ pos: m.index, kind: 'create', sig, body });
  }
  const reDrop = /DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_$]*)\s*(?:\(([\s\S]*?)\))?\s*;/g;
  while ((m = reDrop.exec(src))) {
    const lineStart = src.lastIndexOf('\n', m.index) + 1;
    if (/^\s*--/.test(src.slice(lineStart, m.index))) continue;
    if (m[2] === undefined) events.push({ pos: m.index, kind: 'drop-all', name: m[1] });
    else {
      const types = splitArgs(m[2]).map(parseType);
      if (types.some(t => t === null)) continue;
      events.push({ pos: m.index, kind: 'drop', sig: normSig(`${m[1]}(${types.join(', ')})`) });
    }
  }
  events.sort((a, b) => a.pos - b.pos);
  return events;
}
// Applique les événements à l'ÉTAT PARTAGÉ : un DROP d'une section retire la
// création d'une section précédente (arité ancienne remplacée plus loin).
function applyEvents(state, events) {
  for (const e of events) {
    if (e.kind === 'create') state[e.sig] = { brut: md5(e.body), code: md5(logicOf(e.body)) };
    else if (e.kind === 'drop') delete state[e.sig];
    else for (const k of Object.keys(state)) if (k.startsWith(e.name + '(')) delete state[k];
  }
}

// — état final des fichiers dans l'ordre des sections APPLY —
const applyText = fs.readFileSync(APPLY, 'utf8');
const order = [...applyText.matchAll(BANNER)].map(m => m[1]);
if (order.length < 2) {
  console.error('✗ Sections ⬇ introuvables dans APPLY_MIGRATIONS.sql');
  process.exit(2);
}
const state = {};
for (const f of order) {
  const p = path.join(ROOT, 'supabase', f);
  if (!fs.existsSync(p)) { console.error(`✗ Fichier manquant : supabase/${f}`); process.exit(2); }
  applyEvents(state, parseEvents(fs.readFileSync(p, 'utf8')));
}
const sigs = Object.keys(state).sort();

const values = sigs
  .map(s => `    ('${s}', '${state[s].brut}', '${state[s].code}')`)
  .join(',\n');

const sql = `-- ============================================================================
--  AUDIT PROD ↔ DÉPÔT — GÉNÉRÉ par scripts/gen-audit-prod.mjs (ne pas éditer).
--
--  À exécuter sur la base cible (Supabase SQL Editor → New query, ou psql).
--  Chaque ligne doit dire OK :
--    OK           = identique au dépôt, byte à byte
--    FORMAT       = même logique, commentaires/espaces seuls diffèrent (sans
--                   risque comportemental ; re-synchronisable par réapplication)
--    DIVERGENCE   = la base ne fait pas ce que le dépôt dit (à corriger)
--    MANQUANTE    = fonction absente de la base
--    EN PLUS      = fonction présente en base mais pas dans le dépôt
--
--  ${sigs.length} fonctions · ordre des sections = APPLY_MIGRATIONS.sql
-- ============================================================================
WITH expect(sig, brut_md5, code_md5) AS (
  VALUES
${values}
),
src AS (
  SELECT p.oid::regprocedure::text AS sig, p.prosrc
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
),
lines AS (
  SELECT s.sig,
         btrim(regexp_replace(btrim(regexp_replace(l, '[ \\t]+', ' ', 'g')), '[ \\t]+--.*$', '')) AS y,
         ord
  FROM src s, LATERAL regexp_split_to_table(s.prosrc, E'\\n') WITH ORDINALITY t(l, ord)
),
code AS (
  SELECT sig, md5(string_agg(y, ' ' ORDER BY ord)) AS code_md5
  FROM lines
  WHERE y <> '' AND y !~ '^--'
  GROUP BY sig
),
actual AS (
  SELECT s.sig, md5(s.prosrc) AS brut_md5, c.code_md5
  FROM src s LEFT JOIN code c USING (sig)
)
SELECT COALESCE(e.sig, a.sig) AS signature,
       CASE
         WHEN a.sig IS NULL THEN 'MANQUANTE EN BASE'
         WHEN e.sig IS NULL THEN 'EN PLUS (pas dans le dépôt)'
         WHEN a.code_md5 IS DISTINCT FROM e.code_md5 THEN '★ DIVERGENCE DE LOGIQUE ★'
         WHEN a.brut_md5 IS DISTINCT FROM e.brut_md5 THEN 'FORMAT SEULEMENT'
         ELSE 'OK'
       END AS verdict
FROM expect e
FULL OUTER JOIN actual a ON a.sig = e.sig
ORDER BY CASE
           WHEN a.sig IS NULL OR e.sig IS NULL OR a.code_md5 IS DISTINCT FROM e.code_md5 THEN 0
           WHEN a.brut_md5 IS DISTINCT FROM e.brut_md5 THEN 1
           ELSE 2
         END,
         COALESCE(e.sig, a.sig) COLLATE "C";
`;

if (check) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (current === sql) {
    console.log(`✓ scripts/audit-prod.sql à jour (${sigs.length} fonctions)`);
    process.exit(0);
  }
  console.error('✗ scripts/audit-prod.sql est périmé (les fichiers ont changé)');
  console.error('  → corriger avec : node scripts/gen-audit-prod.mjs');
  process.exit(1);
}
fs.writeFileSync(OUT, sql);
console.log(`✓ scripts/audit-prod.sql régénéré (${sigs.length} fonctions)`);
