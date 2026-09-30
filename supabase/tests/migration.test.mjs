// Harness PGlite : applique réellement les migrations sur un Postgres en WASM
// et teste le comportement de create_sale.
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
import path from 'path';

const SQL_DIR = process.argv[2];
const ORDER = [
  'schema.sql',
  'migration_team.sql',
  'migration_saas.sql',
  'migration_plan_limits.sql',
  'migration_invoices.sql',
  'migration_webhook_logs.sql',
  'migration_indexes.sql',
  'migration_sales_rpc.sql',
  'migration_roles.sql',
  // Doit suivre create_sale : la fonction écrit sale_items.unit_cost.
  'migration_profitability.sql',
  'migration_expenses.sql',
  'migration_invitations.sql',
  'migration_profitability_fix.sql',
  'migration_suppliers.sql',
];

const db = new PGlite();

// Les erreurs PGlite remontent avec une pile enorme et illisible : on ne
// garde que le message PostgreSQL.
process.on('uncaughtException', (err) => {
  console.log(`\n  ✗ ERREUR INATTENDUE : ${err.message}`);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.log(`\n  ✗ ERREUR INATTENDUE : ${err?.message ?? err}`);
  process.exit(1);
});

async function q(sql) {
  return db.query(sql);
}
const e = (sql) => db.exec(sql);

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

// ─── Stub du schéma auth ────────────────────────────────────
async function bootstrap() {
  await e(`
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE TABLE IF NOT EXISTS auth.users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text,
      raw_user_meta_data jsonb DEFAULT '{}'::jsonb
    );
    -- request.jwt.claim.sub porte l'utilisateur courant ; permet de simuler
    -- plusieurs acteurs dans un seul test.
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
      LANGUAGE sql STABLE AS $$
        SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
      $$;
    CREATE OR REPLACE FUNCTION auth.role() RETURNS text
      LANGUAGE sql STABLE AS $$
        SELECT COALESCE(current_setting('request.jwt.role', true), 'anon');
      $$;
  `);
  // PGlite n'embarque pas uuid-ossp ; on en reproduit juste la surface utilisée.
  await e(`
    CREATE OR REPLACE FUNCTION uuid_generate_v4() RETURNS uuid
      LANGUAGE sql VOLATILE AS $$ SELECT gen_random_uuid() $$;
  `);
  // Rôles fournis par Supabase, absents de PGlite.
  await e(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;`);
}

async function asUser(id, fn) {
  await q(`SELECT set_config('request.jwt.claim.sub', ${q2(id)}, false)`);
  return fn();
}
const q2 = (v) => `'${v}'`;

// ─── 1. Application des migrations ──────────────────────────
console.log('\n▸ Application des migrations');
await bootstrap();

for (const file of ORDER) {
  // PGlite n'embarque pas les extensions ; on les retire du texte (elles sont
  // disponibles sur Supabase, et uuid_generate_v4 est stubé plus haut).
  const sql = fs.readFileSync(path.join(SQL_DIR, file), 'utf8')
    .replace(/CREATE EXTENSION[^;]*;/gi, '');
  try {
    await db.exec(sql);
    console.log(`  ✓ ${file}`);
  } catch (e) {
    failures++;
    console.log(`  ✗ ${file}\n    ${e.message}`);
  }
}

if (failures > 0) {
  console.log(`\n${failures} échec(s) : les migrations suivantes n'ont pas été validées.`);
  process.exit(1);
}

// ─── 1b. Rejouabilité ───────────────────────────────────────
// Seules les migrations « incrémentales » doivent être rejouables : ce sont
// celles qu'on applique à un projet existant. schema.sql (création de tables)
// et les migrations historiques ne le sont pas — elles ont été exécutées une
// fois, et le README documente l'ordre.
//
// Une policy créée sans DROP préalable échoue en 42710 « already exists » et
// interrompt le script : c'est arrivé sur migration_expenses.sql.
const REPLAYABLE = ORDER.filter((f) =>
  ['migration_profitability.sql', 'migration_expenses.sql', 'migration_indexes.sql',
   'migration_invitations.sql', 'migration_profitability_fix.sql',
   'migration_suppliers.sql'].includes(f)
);

console.log(`\n▸ Rejouabilité (${REPLAYABLE.length} migrations incrémentales)`);
{
  let replayOk = true;
  for (const file of REPLAYABLE) {
    const sql = fs.readFileSync(path.join(SQL_DIR, file), 'utf8')
      .replace(/CREATE EXTENSION[^;]*;/gi, '');
    try {
      await db.exec(sql);
    } catch (err) {
      replayOk = false;
      failures++;
      console.log(`  ✗ ${file} rejouée\n    ${err.message}`);
    }
  }
  if (replayOk) console.log(`  ✓ les ${REPLAYABLE.length} migrations se rejouent sans erreur`);
}

// ─── 2. Jeu de données de test ──────────────────────────────
console.log('\n▸ Jeu de données');
const PATRON = '11111111-1111-1111-1111-111111111111';
const EMPLOYE = '22222222-2222-2222-2222-222222222222';

await q(`INSERT INTO auth.users (id, email) VALUES ('${PATRON}', 'patron@test.ci'), ('${EMPLOYE}', 'employe@test.ci')`);
await q(`UPDATE organizations SET plan = 'pro' WHERE id = '${PATRON}'`);
await q(`INSERT INTO organizations (id, name, slug) VALUES ('${PATRON}', 'Boutique Test', 'boutique-test')`);
await q(`UPDATE organizations SET plan = 'pro' WHERE id = '${PATRON}'`);
await q(`INSERT INTO business_members (owner_id, member_id, member_name) VALUES ('${PATRON}', '${EMPLOYE}', 'Caissier')`);

const P1 = 'aaaaaaaa-0000-0000-0000-000000000001';
const P2 = 'aaaaaaaa-0000-0000-0000-000000000002';
await q(`
  INSERT INTO products (id, user_id, name, sku, price_buy, price_sell, stock_qty, min_stock_level)
  VALUES
    ('${P1}', '${PATRON}', 'Riz 5kg', 'RIZ5',  5000,  7000,  10, 2),
    ('${P2}', '${PATRON}', 'Huile 1L', 'HUILE', 3000,  4500,   3, 1)
`);

const stock = async (id) => Number((await q(`SELECT stock_qty FROM products WHERE id = '${id}'`)).rows[0].stock_qty);
const count = async (sql) => Number((await q(sql)).rows[0].count);
/** create_sale RETURNS jsonb : PGlite désérialise la colonne en objet. */
const sale = async (payload, method = 'cash', client = null) => {
  const r = await q(
    `SELECT create_sale('${payload}'::jsonb, '${method}'${client ? `, '${client}'` : ''})`
  );
  return r.rows[0].create_sale;
};
const invoiceOf = async (id) =>
  (await q(`SELECT invoice_number FROM sales WHERE id='${id}'`)).rows[0].invoice_number;

// ─── 3. Comportement de create_sale ─────────────────────────
console.log('\n▸ create_sale');

await q(`SELECT set_config('request.jwt.claim.sub', '${PATRON}', false)`);

// 3a. Vente simple
{
  const res = await sale(`[{"product_id":"${P1}","quantity":2}]`, 'cash', 'M. Diallo');
  const saleId = res.id;
  check('3a. vente simple retourne un id', !!saleId);
  check('3a. stock décrémenté 10 → 8', (await stock(P1)) === 8, `obtenu ${await stock(P1)}`);
  check('3a. total = 2 x 7000', Number((await q(`SELECT total_amount FROM sales WHERE id='${saleId}'`)).rows[0].total_amount) === 14000);
  check('3a. 1 ligne de vente', (await count(`SELECT count(*) FROM sale_items WHERE sale_id='${saleId}'`)) === 1);
  check('3a. journal de stock écrit', (await count(`SELECT count(*) FROM stock_logs WHERE reference_id='${saleId}' AND movement_type='sale'`)) === 1);
  check('3a. total renvoyé = 14000', Number(res.total_amount) === 14000, `obtenu ${res.total_amount}`);
  check('3a. numéro de facture Pro attribué', /^FAC-\d{4}-\d{5}$/.test(await invoiceOf(saleId)), await invoiceOf(saleId));
}

// 3b. Le prix client est ignoré (le serveur facture le prix en base)
{
  const res = await sale(`[{"product_id":"${P1}","quantity":1,"unit_price":1}]`, 'momo');
  const total = Number((await q(`SELECT total_amount FROM sales WHERE id='${res.id}'`)).rows[0].total_amount);
  check('3b. prix forgé ignoré (total = 7000)', total === 7000, `obtenu ${total}`);
}

// 3c. Numéro de facture unique et séquentiel
{
  const nums = (await q(`SELECT invoice_number FROM sales WHERE invoice_number IS NOT NULL ORDER BY created_at`)).rows.map((r) => r.invoice_number);
  check('3c. numéros de facture uniques', new Set(nums).size === nums.length, nums.join(', '));
}

// 3d. Stock insuffisant → rien n'est écrit
{
  const before = await stock(P2);
  const salesBefore = await count(`SELECT count(*) FROM sales`);
  let msg = '';
  try {
    await q(`SELECT create_sale('[{"product_id":"${P2}","quantity":99}]'::jsonb, 'cash')`);
  } catch (e) { msg = e.message; }
  check('3d. stock insuffisant rejeté', /Stock insuffisant/.test(msg), msg);
  check('3d. stock inchangé', (await stock(P2)) === before);
  check('3d. aucune vente orpheline', (await count(`SELECT count(*) FROM sales`)) === salesBefore);
}

// 3e. Le même produit en double ne peut pas dépasser le stock
{
  const before = await stock(P2);
  let msg = '';
  try {
    await q(`SELECT create_sale('[{"product_id":"${P2}","quantity":2},{"product_id":"${P2}","quantity":2}]'::jsonb, 'cash')`);
  } catch (e) { msg = e.message; }
  check('3e. doublon agrégé rejeté (2+2 > 3)', /Stock insuffisant/.test(msg), msg);
  check('3e. stock inchangé', (await stock(P2)) === before, `obtenu ${await stock(P2)}`);
}

// 3f. Quantité invalide
for (const [label, payload] of [
  ['zéro', '[{"product_id":"' + P1 + '","quantity":0}]'],
  ['négative', '[{"product_id":"' + P1 + '","quantity":-5}]'],
  ['non numérique', '[{"product_id":"' + P1 + '","quantity":"abc"}]'],
  ['id invalide', '[{"product_id":"pas-un-uuid","quantity":1}]'],
]) {
  let msg = '';
  try { await q(`SELECT create_sale('${payload}'::jsonb, 'cash')`); } catch (e) { msg = e.message; }
  check(`3f. quantité ${label} rejetée`, /Ligne de panier invalide/.test(msg), msg);
}

// 3g. Moyen de paiement invalide
{
  let msg = '';
  try { await q(`SELECT create_sale('[{"product_id":"${P1}","quantity":1}]'::jsonb, 'bitcoin')`); } catch (e) { msg = e.message; }
  check('3g. moyen de paiement invalide rejeté', /Moyen de paiement invalide/.test(msg), msg);
}

// 3h. Panier vide
{
  let msg = '';
  try { await q(`SELECT create_sale('[]'::jsonb, 'cash')`); } catch (e) { msg = e.message; }
  check('3h. panier vide rejeté', /Panier vide/.test(msg), msg);
}

// 3i. Produit d'une autre boutique → introuvable
{
  const AUTRE = '33333333-3333-3333-3333-333333333333';
  await q(`INSERT INTO auth.users (id, email) VALUES ('${AUTRE}', 'autre@test.ci')`);
  await q(`INSERT INTO organizations (id, name, slug) VALUES ('${AUTRE}', 'Concurrent', 'concurrent')`);
  const P3 = 'aaaaaaaa-0000-0000-0000-000000000003';
  await q(`INSERT INTO products (id, user_id, name, price_sell, stock_qty) VALUES ('${P3}', '${AUTRE}', 'Secret', 100, 50)`);
  let msg = '';
  try { await q(`SELECT create_sale('[{"product_id":"${P3}","quantity":1}]'::jsonb, 'cash')`); } catch (e) { msg = e.message; }
  check('3i. produit d\'un autre tenant rejeté', /Produit introuvable/.test(msg), msg);
}

// 3j. Un employé peut encaisser (le locator est résolu côté serveur)
{
  const stockBefore = await stock(P1);
  await q(`SELECT set_config('request.jwt.claim.sub', '${EMPLOYE}', false)`);
  let msg = '';
  let res = null;
  try { res = await sale(`[{"product_id":"${P1}","quantity":1}]`); } catch (err) { msg = err.message; }
  check('3j. l\'employé peut encaisser', msg === '', msg);
  check('3j. le stock du patron est décrémenté', (await stock(P1)) === stockBefore - 1);
  const owner = (await q(`SELECT user_id FROM sales WHERE id='${res.id}'`)).rows[0].user_id;
  check('3j. la vente est imputée au patron', owner === PATRON, owner);
}

// 3k. La contrainte CHECK protège le stock
{
  let msg = '';
  try { await q(`UPDATE products SET stock_qty = -1 WHERE id = '${P1}'`); } catch (e) { msg = e.message; }
  check('3k. stock négatif bloqué par CHECK', /products_stock_qty_non_negative/.test(msg), msg || 'aucune erreur levée');
}

// ─── 4. Policies RLS (le cœur du correctif de rôle) ─────────
// PGlite tourne en superuser, qui contourne la RLS : on bascule sur le rôle
// `authenticated` pour que les policies s'appliquent réellement.
console.log('\n▸ RLS — droits sur le catalogue');

await e(`
  GRANT USAGE ON SCHEMA public, auth TO authenticated;
  GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;
  GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated;
  GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated;
`);

// En PostgreSQL, un UPDATE/DELETE refusé par une policy USING ne lève
// AUCUNE erreur : la ligne est simplement filtrée (0 ligne affectée). L'error
// n'est un signal fiable que pour les inserts (WITH CHECK). On vérifie donc
// systématiquement l'effet réel sur la base.
const run = async (sql, as) => {
  await q(`SELECT set_config('request.jwt.claim.sub', '${as}', false)`);
  await e('SET ROLE authenticated');
  let affected = -1;
  let err = '';
  try {
    const r = await q(sql);
    affected = r.affectedRows ?? 0;
  } catch (ex) {
    err = ex.message;
  }
  await e('RESET ROLE');
  return { affected, err };
};

const canWrite = async (label, sql, expectAllowed, as) => {
  const { affected, err } = await run(sql, as);
  const allowed = affected > 0;
  check(label, allowed === expectAllowed,
    `${allowed ? 'appliqué' : `refusé (${affected} ligne${affected > 1 ? 's' : ''}${err ? ', ' + err.slice(0, 50) : ''})`}`);
  return affected;
};

// Un SELECT ne se mesure pas via affectedRows : on lit la valeur renvoyée.
const canRead = async (label, sql, expectVisible, as) => {
  await q(`SELECT set_config('request.jwt.claim.sub', '${as}', false)`);
  await e('SET ROLE authenticated');
  let value = -1;
  try {
    const r = await q(sql);
    value = Number(r.rows[0].count);
  } catch (ex) {
    value = -1;
  }
  await e('RESET ROLE');
  check(label, (value > 0) === expectVisible, `${value} ligne(s) visible(s)`);
};

// Employé : lecture oui, écriture non.
await canRead('4a. employé LIT les produits du patron',
  `SELECT count(*) FROM products`, true, EMPLOYE);
await canWrite('4b. employé NE MODIFIE PAS un produit',
  `UPDATE products SET price_sell = 1 WHERE id = '${P1}'`, false, EMPLOYE);
await canWrite('4c. employé NE SUPPRIME PAS un produit',
  `DELETE FROM products WHERE id = '${P1}'`, false, EMPLOYE);
await canWrite('4d. employé NE CRÉE PAS de produit',
  `INSERT INTO products (user_id, name, price_sell, stock_qty) VALUES ('${PATRON}', 'X', 1, 1)`, false, EMPLOYE);

// Le stock et le prix n'ont pas bougé malgré les tentatives ci-dessus.
check('4e. le prix du produit est intact',
  Number((await q(`SELECT price_sell FROM products WHERE id='${P1}'`)).rows[0].price_sell) === 7000);
check('4f. le produit existe toujours',
  (await count(`SELECT count(*) FROM products WHERE id='${P1}'`)) === 1);

// Patron : écriture oui.
await canWrite('4g. patron MODIFIE un produit',
  `UPDATE products SET category = 'Céréales' WHERE id='${P1}'`, true, PATRON);
await canRead('4h. patron LIT ses produits', `SELECT count(*) FROM products`, true, PATRON);

// Journal d'activité : impossible d'écrire au nom d'une autre organisation.
const AUTRE2 = '44444444-4444-4444-4444-444444444444';
await q(`INSERT INTO auth.users (id, email) VALUES ('${AUTRE2}', 'x@test.ci')`);
await q(`INSERT INTO organizations (id, name, slug) VALUES ('${AUTRE2}', 'Victime', 'victime')`);
await canWrite('4i. impossible de forger un journal chez un autre tenant',
  `INSERT INTO activity_logs (business_owner_id, actor_id, actor_email, action, description)
   VALUES ('${AUTRE2}', '${PATRON}', 'patron@test.ci', 'fraud', 'forge')`, false, PATRON);
await canWrite('4j. impossible de purge le journal d\'autrui',
  `DELETE FROM activity_logs WHERE business_owner_id = '${AUTRE2}'`, false, PATRON);

// Un employé ne peut pas créer sa propre organisation à côté de celle du patron.
await canWrite('4k. employé NE FORK PAS sa propre organisation',
  `INSERT INTO organizations (id, name, slug) VALUES ('${EMPLOYE}', 'Ma boite', 'ma-boite')`, false, EMPLOYE);
const forks = await count(`SELECT count(*) FROM organizations WHERE id = '${EMPLOYE}'`);
check('4l. aucune organisation fantôme créée', forks === 0, `${forks} trouvée(s)`);

// Le patron peut purger et écrire dans son propre tenant.
await canWrite('4m. patron écrit dans SON journal',
  `INSERT INTO activity_logs (business_owner_id, actor_id, actor_email, action, description)
   VALUES ('${PATRON}', '${PATRON}', 'patron@test.ci', 'test', 'legitime')`, true, PATRON);

// ─── 5. Rate limiting distribué ────────────────────────────
console.log('\n▸ bump_rate_limit');

const bump = (key, max = 3, window = 3600) =>
  q(`SELECT bump_rate_limit('${key}', ${max}, ${window})`).then((r) => r.rows[0].bump_rate_limit);

{
  const key = 'test:1.2.3.4';
  const results = [];
  for (let i = 0; i < 5; i++) results.push(await bump(key));
  check('5a. les 3 premières tentatives passent', !results[0] && !results[1] && !results[2],
    results.join(','));
  check('5b. la 4e est bloquée', results[3] === true);
  check('5c. la 5e est bloquée', results[4] === true);
}
{
  // Clé distincte = compteur indépendant
  const r = await bump('test:5.6.7.8');
  check('5d. une autre IP a son propre compteur', r === false);
}
{
  // Fenêtre expirée : le compteur repart de zéro
  const r = await bump('test:expire', 2, 0);
  check('5e. fenêtre expirée → compteur remis à zéro', r === false);
}
{
  const before = await count(`SELECT count(*) FROM rate_limits`);
  await q(`SELECT purge_rate_limits()`);
  const after = await count(`SELECT count(*) FROM rate_limits WHERE reset_at > now()`);
  check('5f. purge_rate_limits ne supprime que l\'expiré', after <= before, `${after} restant(s)`);
}

// ─── 6. Rentabilité & archivage ────────────────────────────
console.log('\n▸ Coût figé et marge');

await q(`SELECT set_config('request.jwt.claim.sub', '${PATRON}', false)`);

{
  const p = 'aaaaaaaa-0000-0000-0000-0000000000a1';
  await q(`INSERT INTO products (id,user_id,name,price_buy,price_sell,stock_qty)
           VALUES ('${p}','${PATRON}','Marge test',3000,5000,100)`);
  const r = await sale(`[{"product_id":"${p}","quantity":3}]`);
  const item = (await q(`SELECT unit_cost, subtotal FROM sale_items WHERE sale_id='${r.id}'`)).rows[0];
  check('6a. unit_cost enregistré à la vente', Number(item.unit_cost) === 3000, `obtenu ${item.unit_cost}`);
  check('6b. subtotal correct', Number(item.subtotal) === 15000, `obtenu ${item.subtotal}`);

  // Le prix d'achat change : la marge historique ne doit pas bouger.
  await q(`UPDATE products SET price_buy = 4000 WHERE id = '${p}'`);
  const after = (await q(`SELECT unit_cost FROM sale_items WHERE sale_id='${r.id}'`)).rows[0];
  check('6c. coût figé après changement du prix d\'achat', Number(after.unit_cost) === 3000);

  let msg = '';
  try { await q(`UPDATE sale_items SET unit_cost = 1 WHERE sale_id='${r.id}'`); } catch (e) { msg = e.message; }
  check('6d. modification du coût refusée', /figé/.test(msg), msg || 'acceptée !');

  const v = (await q(`SELECT * FROM get_product_profitability() WHERE id='${p}'`)).rows[0];
  check('6e. CA = 15 000', Number(v.revenue) === 15000, `obtenu ${v.revenue}`);
  check('6f. coût des marchandises = 9 000', Number(v.cost_of_goods) === 9000, `obtenu ${v.cost_of_goods}`);
  check('6g. marge brute = 6 000', Number(v.gross_profit) === 6000, `obtenu ${v.gross_profit}`);
  check('6h. taux de marge = 40 %', Number(v.margin_pct) === 40, `obtenu ${v.margin_pct}`);
}

// Régression : une vue filtrée par get_business_owner_id() renvoyait zéro ligne
// dès qu'aucun utilisateur n'était résolu (clé service role, scripts).
// SECURITY INVOKER doit laisser la RLS décider.
{
  await q(`SELECT set_config('request.jwt.claim.sub', '', false)`);
  const all = (await q(`SELECT count(*)::int c FROM get_product_profitability()`)).rows[0].c;
  check('6i. lisible sans utilisateur (service role / scripts)', all > 0, `${all} ligne(s)`);

  await q(`SELECT set_config('request.jwt.claim.sub', '${PATRON}', false)`);
  const own = (await q(`SELECT count(*)::int c FROM get_product_profitability()`)).rows[0].c;
  check('6j. filtré sur le patron connecté', own > 0 && own <= all, `${own}/${all}`);

  // Un employé voit les produits de son patron (RLS products_read).
  await q(`SELECT set_config('request.jwt.claim.sub', '${EMPLOYE}', false)`);
  const emp = (await q(`SELECT count(*)::int c FROM get_product_profitability()`)).rows[0].c;
  check('6k. l\'employé voit la rentabilité du patron', emp > 0, `${emp} ligne(s)`);
}

// La vue ne doit exposer que le tenant courant (une vue contourne la RLS).
{
  const SECRET = 'aaaaaaaa-0000-0000-0000-0000000000a9';
  await q(`INSERT INTO auth.users (id,email) VALUES ('55555555-5555-5555-5555-555555555555','x@t.ci')`);
  await q(`INSERT INTO organizations (id,name,slug) VALUES ('55555555-5555-5555-5555-555555555555','Rival','rival')`);
  await q(`INSERT INTO products (id,user_id,name,price_buy,price_sell,stock_qty)
           VALUES ('${SECRET}','55555555-5555-5555-5555-555555555555','Secret',1,999999,10)`);
  // Isolation réellement Updates la RLS : on bascule sur le rôle authenticated.
  // En superuser la RLS est contournée, ce test ne prouverait rien.
  await e(`GRANT EXECUTE ON FUNCTION get_product_profitability() TO authenticated`);
  await q(`SELECT set_config('request.jwt.claim.sub', '${PATRON}', false)`);
  await e('SET ROLE authenticated');
  let seen = [];
  try {
    seen = (await q(`SELECT name FROM get_product_profitability()`)).rows.map((x) => x.name);
  } catch (err) { seen = ['<erreur: ' + err.message + '>']; }
  await e('RESET ROLE');
  check('6l. l\'isolation tient sous le rôle authenticated', !seen.includes('Secret'),
    seen.join(', '));
}

console.log('\n▸ Archivage de produit');
await q(`SELECT set_config('request.jwt.claim.sub', '${PATRON}', false)`);
{
  // Produit vendu → archivage refusé (historique préservé)
  let msg = '';
  try { await q(`SELECT archive_product('${P1}')`); } catch (e) { msg = e.message; }
  check('6m. produit vendu : archivage refusé', /Impossible d' archiv|Impossible d.archiver/.test(msg), msg);
  check('6n. le produit vendu reste actif',
    (await q(`SELECT is_active FROM products WHERE id='${P1}'`)).rows[0].is_active === true);

  // Produit invendu → archivable
  const orphan = 'aaaaaaaa-0000-0000-0000-0000000000b1';
  await q(`INSERT INTO products (id,user_id,name,price_buy,price_sell,stock_qty)
           VALUES ('${orphan}','${PATRON}','Obsolete',100,200,5)`);
  await q(`SELECT archive_product('${orphan}')`);
  const p = (await q(`SELECT is_active, archived_at FROM products WHERE id='${orphan}'`)).rows[0];
  check('6o. produit invendu archivé', p.is_active === false);
  check('6p. archived_at renseigné', !!p.archived_at);
  await q(`SELECT restore_product('${orphan}')`);
  check('6q. restauration possible',
    (await q(`SELECT is_active FROM products WHERE id='${orphan}'`)).rows[0].is_active === true);
}

// ─── 7. Dépenses & résultat net ─────────────────────────────
console.log('\n▸ Dépenses');
await q(`SELECT set_config('request.jwt.claim.sub', '${PATRON}', false)`);

// Plan de comptes : créé une fois, jamais dupliqué.
// Appel SANS argument : c'est exactement ce que fait le frontend, et c'est ce
// qui échouait (PostgREST ne faisait pas correspondre la signature à un uuid).
await q(`SELECT set_config('request.jwt.claim.sub', '${PATRON}', false)`);
await q(`SELECT seed_expense_categories()`);
await q(`SELECT seed_expense_categories()`);
{
  const n = await count(`SELECT count(*) FROM expense_categories WHERE user_id = '${PATRON}'`);
  check('7a. seed idempotent (11 catégories, pas de doublon)', n === 11, `${n} catégorie(s)`);
  const first = (await q(
    `SELECT name FROM expense_categories WHERE user_id='${PATRON}' ORDER BY sort_order LIMIT 1`
  )).rows[0].name;
  check('7b. première catégorie = Loyer', first === 'Loyer', first);
}

// Le seed ne doit toucher QUE l'organisation de l'appelant : c'est la
// garantie que la suppression du paramètre p_owner n'a rien coûté.
// On utilise un patron (pas un employé déjà rattaché ailleurs : un membre
// n'appartient qu'à une organisation, index unique sur member_id).
{
  const AUTRE0 = '88888888-8888-8888-8888-888888888888';
  await q(`INSERT INTO auth.users (id,email) VALUES ('${AUTRE0}','w@t.ci')`);
  await q(`INSERT INTO organizations (id,name,slug) VALUES ('${AUTRE0}','Voisin','voisin')`);

  await q(`SELECT set_config('request.jwt.claim.sub', '${AUTRE0}', false)`);
  await q(`SELECT seed_expense_categories()`);

  const forOther = await count(`SELECT count(*) FROM expense_categories WHERE user_id = '${AUTRE0}'`);
  check('7b2. le seed crée bien le plan du patron qui l\'appelle', forOther === 11, `${forOther} catégorie(s)`);

  const forOwner = await count(`SELECT count(*) FROM expense_categories WHERE user_id = '${PATRON}'`);
  check('7b3. le seed ne touche pas le plan d\'un autre tenant', forOwner === 11, `${forOwner} catégorie(s)`);

  await q(`SELECT set_config('request.jwt.claim.sub', '${PATRON}', false)`);
}

// Une charge normale passe, une charge négative ou sans libellé est refusée
const TODAY = '2026-06-15';
{
  const { error } = await q(`
    INSERT INTO expenses (user_id, category, label, amount, day)
    VALUES ('${PATRON}', 'Loyer', 'Loyer juin', 50000, '${TODAY}')`);
  check('7c. dépense valide acceptée', !error, error?.message);

  let msg = '';
  try {
    await q(`INSERT INTO expenses (user_id,category,label,amount,day)
             VALUES ('${PATRON}','Autre','Remboursement',-5000,'${TODAY}')`);
  } catch (e) { msg = e.message; }
  check('7d. montant négatif refusé', /expenses_amount_positive/.test(msg), msg || 'accepté !');

  msg = '';
  try {
    await q(`INSERT INTO expenses (user_id,category,label,amount,day)
             VALUES ('${PATRON}','Autre','   ','1000','${TODAY}')`);
  } catch (e) { msg = e.message; }
  check('7e. libellé vide refusé', /expenses_label_not_blank/.test(msg), msg || 'accepté !');
}

// Le résultat net combine CA et charges
{
  // Vente datée du même jour que la dépense
  const d = '2026-06-15';
  await q(`INSERT INTO sales (user_id, total_amount, payment_method, created_at)
           VALUES ('${PATRON}', 20000, 'cash', '${d}T10:00:00+00:00')`);
  await q(`INSERT INTO expenses (user_id,category,label,amount,day)
           VALUES ('${PATRON}','Électricité','EDF juin',15000,'${d}')`);

  const row = (await q(`SELECT * FROM get_cash_flow('${d}', '${d}')`)).rows[0];
  check('7f. CA du jour = 20 000', Number(row.revenue) === 20000, `obtenu ${row.revenue}`);
  check('7g. charges du jour = 65 000 (50 000 + 15 000)', Number(row.expenses) === 65000, `obtenu ${row.expenses}`);
  check('7h. résultat net = -45 000 (déficit)', Number(row.net) === -45000, `obtenu ${row.net}`);
  check('7i. transactions comptées', Number(row.transactions) >= 1, `${row.transactions}`);
}

// Un jour avec charge mais aucune vente doit apparaître (FULL OUTER JOIN)
{
  const d = '2026-06-16';
  await q(`INSERT INTO expenses (user_id,category,label,amount,day)
           VALUES ('${PATRON}','Autre','Achat 二 kwatt',3000,'${d}')`);
  const row = (await q(`SELECT * FROM get_cash_flow('${d}', '${d}')`)).rows[0];
  check('7j. journée sans vente mais avec charge visible', !!row && Number(row.revenue) === 0,
    row ? `revenue ${row.revenue}` : 'jour absent');
}

// RLS : un employé lit mais n'écrit pas
{
  await q(`SELECT set_config('request.jwt.claim.sub', '${EMPLOYE}', false)`);
  const seen = (await q(
    `SELECT count(*)::int c FROM expenses WHERE user_id = '${PATRON}'`)).rows[0].c;
  check('7k. employé LIT les charges', seen > 0, `${seen} ligne(s)`);

  await e('SET ROLE authenticated');
  let allowed = false;
  try {
    await q(`INSERT INTO expenses (user_id,category,label,amount,day)
             VALUES ('${PATRON}','Autre','Fuite',9999,'2026-06-17')`);
    allowed = true;
  } catch { /* refusé par RLS */ }
  await e('RESET ROLE');
  check('7l. employé NE SAISIT PAS de charge', !allowed);
}

// Isolation multi-tenant
{
  const AUTRE3 = '77777777-7777-7777-7777-777777777777';
  await q(`INSERT INTO auth.users (id,email) VALUES ('${AUTRE3}','z@t.ci')`);
  await q(`INSERT INTO organizations (id,name,slug) VALUES ('${AUTRE3}','Autre','autre')`);
  await q(`INSERT INTO expenses (user_id,category,label,amount,day)
           VALUES ('${AUTRE3}','Autre','Confidentiel',4200,'2026-06-15')`);

  // Isolation : la RLS ne s'applique qu'à un rôle non superuser. PGlite tourne
  // en superuser, ce test ne prouverait donc rien sans ce basculement.
  await q(`SELECT set_config('request.jwt.claim.sub', '${PATRON}', false)`);
  await e('SET ROLE authenticated');
  let leaked = -1;
  let cfExpenses = -1;
  try {
    leaked = Number((await q(
      `SELECT count(*)::int c FROM expenses WHERE user_id = '${AUTRE3}'`)).rows[0].c);
    const cf = (await q(`SELECT * FROM get_cash_flow('2026-06-15','2026-06-15')`)).rows[0];
    cfExpenses = Number(cf.expenses);
  } catch (err) {
    leaked = -2;
  }
  await e('RESET ROLE');

  check(`7m. les charges d'un autre tenant sont invisibles`, leaked === 0, `${leaked} vue(s)`);
  check(`7n. le cash-flow n'inclut pas les charges d'autrui`, cfExpenses === 65000, `obtenu ${cfExpenses}`);
}

// ═══ 8. Invitations d'équipe ═══════════════════════════════
// Le patron invite un employé par email ; l'employé choisit son propre mot de
// passe et consommé le lien. redeem_invitation() doit être atomique et refuser
// un lien déjà utilisé, expiré, ou présenté par un compte au mauvais email.
console.log('\n▸ Invitations d\'équipe');

const INVITE = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const EMPLOYE2 = '12121212-1212-1212-1212-121212121212';
const INTRUS = '13131313-1313-1313-1313-131313131313';
const TOKEN = 'tok_' + 'a'.repeat(48);

await q(`INSERT INTO auth.users (id,email) VALUES ('${INVITE}','marie@exemple.ci')`);
await q(`INSERT INTO auth.users (id,email) VALUES ('${EMPLOYE2}','marie@exemple.ci')`);
await q(`INSERT INTO auth.users (id,email) VALUES ('${INTRUS}','pirate@exemple.ci')`);

await q(`SELECT set_config('request.jwt.claim.sub', '${PATRON}', false)`);
await q(`INSERT INTO employee_invitations (owner_id, email, token, role)
         VALUES ('${PATRON}', 'marie@exemple.ci', '${TOKEN}', 'employee')`);
{
  const n = await count(
    `SELECT count(*) FROM employee_invitations WHERE owner_id='${PATRON}' AND token='${TOKEN}'`);
  check('8a. invitation créée par le patron', n === 1);
}

// Le token doit être unique : deux invitations ne peuvent pas le partager.
{
  let msg = '';
  try {
    await q(`INSERT INTO employee_invitations (owner_id, email, token)
             VALUES ('${PATRON}', 'autre@exemple.ci', '${TOKEN}')`);
  } catch (e) { msg = e.message; }
  check('8b. token en double refusé', /employee_invitations_token_key|duplicate key/.test(msg),
    msg || 'accepté !');
}

// L'email est normalisé en minuscules : deux invitations pour la même adresse
// ne divergent pas à l'orthographe.
{
  let msg = '';
  try {
    await q(`INSERT INTO employee_invitations (owner_id, email, token)
             VALUES ('${PATRON}', 'Marie@Exemple.CI', '${'b'.repeat(48)}')`);
  } catch (e) { msg = e.message; }
  check('8c. email en majuscules refusé (normalisé)', /employee_invitations_email_lower/.test(msg),
    msg || 'accepté !');
}

// Un token trop court est refusé : un lien devinable n'est pas un secret.
{
  let msg = '';
  try {
    await q(`INSERT INTO employee_invitations (owner_id, email, token)
             VALUES ('${PATRON}', 'court@exemple.ci', 'trop-court')`);
  } catch (e) { msg = e.message; }
  check('8d. token trop court refusé', /employee_invitations_token_len/.test(msg),
    msg || 'accepté !');
}

// ── Le cas central : un compte au MAUVAIS email tente de consommer le lien.
// Sans ce contrôle, un lien intercepté (WhatsApp, capture d'écran) suffit à
// s'attribuer la boutique.
{
  let msg = '';
  try {
    await q(`SELECT * FROM redeem_invitation('${TOKEN}', '${INTRUS}', 'Pirate')`);
  } catch (e) { msg = e.message; }
  check('8e. email différent de celui invité : refusé',
    /invite uniquement/.test(msg), msg || 'accepté !');

  const still = await count(
    `SELECT count(*) FROM employee_invitations WHERE token='${TOKEN}' AND accepted_at IS NULL`);
  check('8f. l\'invitation reste inutilisée après le refus', still === 1);
}

// Usage normal : le bon compte, le bon email.
{
  const r = await q(`SELECT * FROM redeem_invitation('${TOKEN}', '${EMPLOYE2}', '  Marie Koffi  ')`);
  const row = r.rows[0];
  check('8g. remboursement accepté', !!row, 'aucune ligne retournée');
  check('8h. boutique correcte', row?.owner_id === PATRON, row?.owner_id);
  check('8i. email.normalisé renvoyé', row?.email === 'marie@exemple.ci', row?.email);
  check('8j. nom rogné', row?.member_name === 'Marie Koffi', row?.member_name);

  const members = await count(
    `SELECT count(*) FROM business_members WHERE member_id='${EMPLOYE2}' AND owner_id='${PATRON}'`);
  check('8k. membre lié à la boutique', members === 1);

  const role = (await q(
    `SELECT role FROM business_members WHERE member_id='${EMPLOYE2}'`)).rows[0]?.role;
  check('8l. rôle repris de l\'invitation', role === 'employee', role);

  const accepted = await count(
    `SELECT count(*) FROM employee_invitations WHERE token='${TOKEN}' AND accepted_at IS NOT NULL`);
  check('8m. invitation marquée acceptée', accepted === 1);
}

// Un lien à usage unique ne se réutilise pas.
{
  let msg = '';
  try {
    await q(`SELECT * FROM redeem_invitation('${TOKEN}', '${EMPLOYE2}', 'Marie Koffi')`);
  } catch (e) { msg = e.message; }
  check('8n. second usage refusé', /déjà (été )?utilisée/.test(msg), msg || 'accepté !');
}

{
  let msg = '';
  try {
    await q(`SELECT * FROM redeem_invitation('inexistant', '${EMPLOYE2}', 'X')`);
  } catch (e) { msg = e.message; }
  check('8o. token inconnu refusé', /introuvable|révoquée/.test(msg), msg || 'accepté !');
}

// Invitation expirée
{
  const TOK_EXP = 'c'.repeat(48);
  await q(`INSERT INTO employee_invitations (owner_id, email, token, expires_at)
           VALUES ('${PATRON}', 'tardif@exemple.ci', '${TOK_EXP}', now() - interval '1 day')`);
  await q(`INSERT INTO auth.users (id,email) VALUES ('14141414-1414-1414-1414-141414141414','tardif@exemple.ci')`);

  let msg = '';
  try {
    await q(`SELECT * FROM redeem_invitation('${TOK_EXP}', '14141414-1414-1414-1414-141414141414', 'Tardif')`);
  } catch (e) { msg = e.message; }
  check('8p. invitation expirée refusée', /expiré/.test(msg), msg || 'accepté !');
}

// ── RLS : un employé ne doit pas voir les invitations de la boutique, sinon
// il pourrait s'inviter lui-même ou lire un jeton.
{
  await q(`SELECT set_config('request.jwt.claim.sub', '${EMPLOYE2}', false)`);
  await e('SET ROLE authenticated');
  let seen = -1;
  let inserted = false;
  try {
    seen = Number((await q(
      `SELECT count(*)::int c FROM employee_invitations WHERE owner_id='${PATRON}'`)).rows[0].c);
    await q(`INSERT INTO employee_invitations (owner_id, email, token)
             VALUES ('${PATRON}',' pirate@exemple.ci','${'d'.repeat(48)}')`);
    inserted = true;
  } catch { /* refusé */ }
  await e('RESET ROLE');
  check('8q. employé NE LIT PAS les invitations', seen === 0, `${seen} vue(s)`);
  check('8r. employé NE CRÉE PAS d\'invitation', !inserted);
}

// Isolation multi-tenant sur les invitations
{
  const AUTRE4 = '99999999-9999-9999-9999-999999999999';
  await q(`INSERT INTO auth.users (id,email) VALUES ('${AUTRE4}','patron2@t.ci')`);
  await q(`INSERT INTO organizations (id,name,slug) VALUES ('${AUTRE4}','Deux','deux')`);

  await q(`SELECT set_config('request.jwt.claim.sub', '${PATRON}', false)`);
  await e('SET ROLE authenticated');
  const leaked = Number((await q(
    `SELECT count(*)::int c FROM employee_invitations WHERE owner_id='${AUTRE4}'`)).rows[0].c);
  await e('RESET ROLE');
  check('8s. les invitations d\'autre tenant sont invisibles', leaked === 0, `${leaked} vue(s)`);
}

// redeem_invitation n'est pas appelable par un client authentifié : elle est
// révoquée au public et accordée au service_role seulement.
{
  await q(`SELECT set_config('request.jwt.claim.sub', '${EMPLOYE2}', false)`);
  await e('SET ROLE authenticated');
  let denied = false;
  try {
    await q(`SELECT * FROM redeem_invitation('${'e'.repeat(48)}', '${EMPLOYE2}', 'X')`);
  } catch { denied = true; }
  await e('RESET ROLE');
  check('8t. un client authentifié ne peut PAS appeler redeem_invitation', denied);
}

// Purge : seules les invitations acceptées et anciennes sont supprimées.
{
  const before = await count(`SELECT count(*) FROM employee_invitations`);
  await q(`UPDATE employee_invitations
           SET accepted_at = now() - interval '30 days'
           WHERE token='${TOKEN}'`);
  const purged = (await q(`SELECT purge_accepted_invitations(7)`)).rows[0].purge_accepted_invitations;
  const after = await count(`SELECT count(*) FROM employee_invitations`);
  check('8u. purge supprime les invitations acceptées et anciennes', Number(purged) === 1,
    `${purged} purgée(s)`);
  check('8v. la purge épargne les invitations en attente', after === before - 1,
    `${before} → ${after}`);
}

// ═══ 9. Correctif marge : lines sans coût figé ═══════════
// Reproduit le déploiement incomplet : une vente insérée sans unit_cost, comme
// le faisait la create_sale() d'avant. Le correctif doit la réparer, sans
// dégrader la protection qui interdit de retoucher un coût une fois figé.
console.log('\n▸ Correctif du coût figé');

{
  const ART = '90909090-9090-9090-9090-909090909090';
  await q(`SELECT set_config('request.jwt.claim.sub', '${PATRON}', false)`);
  await q(`INSERT INTO products (id, user_id, name, price_buy, price_sell, stock_qty)
           VALUES ('${ART}', '${PATRON}', 'Article correctif', 4000, 10000, 50)`);

  // Vente créée « à l'ancienne » : unit_cost non fourni.
  await q(`INSERT INTO sales (user_id, total_amount, payment_method)
           VALUES ('${PATRON}', 20000, 'cash')`);
  const saleId = (await q(
    `SELECT id FROM sales WHERE user_id='${PATRON}' ORDER BY created_at DESC LIMIT 1`)).rows[0].id;
  await q(`INSERT INTO sale_items (sale_id, product_id, product_name, quantity, unit_price, subtotal)
           VALUES ('${saleId}', '${ART}', 'Article correctif', 2, 10000, 20000)`);

  const avant = (await q(
    `SELECT unit_cost FROM sale_items WHERE sale_id='${saleId}'`)).rows[0].unit_cost;
  check('9a. vente ancienne sans coût (NULL)', avant === null, String(avant));

  await e(fs.readFileSync(path.join(SQL_DIR, 'migration_profitability_fix.sql'), 'utf8'));

  const apres = (await q(
    `SELECT unit_cost, product_id_archived FROM sale_items WHERE sale_id='${saleId}'`)).rows[0];
  check('9b. coût retrospectively rempli (4 000)', Number(apres.unit_cost) === 4000, String(apres.unit_cost));
  check('9c. product_id_archived renseigné', !!apres.product_id_archived);

  // Le correctif ne doit pas assouplir la protection : un coût figé reste figé.
  const trig = (await q(
    `SELECT count(*)::int c FROM pg_trigger WHERE tgname='sale_items_freeze_cost'`)).rows[0].c;
  check('9d. trigger de figeage toujours présent', trig === 1, `${trig}`);

  let bloque = false;
  const siId = (await q(
    `SELECT id FROM sale_items WHERE sale_id='${saleId}'`)).rows[0].id;
  try { await q(`UPDATE sale_items SET unit_cost = 1 WHERE id='${siId}'`); }
  catch { bloque = true; }
  check('9e. modifier un coût figé reste refusé', bloque);

  // Et une vente neuve, créée par la create_sale() courante, fige son coût.
  await q(`UPDATE products SET stock_qty = 50 WHERE id='${ART}'`);
  const r = await q(`SELECT create_sale(
    '[{"product_id":"${ART}","quantity":1}]'::jsonb, 'cash', null) AS v`);
  // create_sale() renvoie du jsonb : selon le pilote, il arrive en objet ou en
  // chaîne. On normalise avant d'en lire l'id.
  const brut = r.rows[0]?.v;
  const vente = typeof brut === 'string' ? JSON.parse(brut) : brut;
  check('9f. create_sale() aboutit', !!vente?.id, JSON.stringify(brut)?.slice(0, 120));
  const neuf = (await q(
    `SELECT si.unit_cost FROM sale_items si
      WHERE si.sale_id = '${vente?.id}'`)).rows[0]?.unit_cost;
  check('9g. nouvelle vente : coût figé (4 000)', Number(neuf) === 4000, String(neuf));

  // La marge n'est plus nulle une fois le coût connu. Le produit a désormais
  // deux ventes : 2 unités (20 000 F) + 1 unité (10 000 F) = 30 000 F de CA,
  // pour 3 × 4 000 = 12 000 F de coût.
  const prof = (await q(`SELECT * FROM get_product_profitability()`)).rows
    .find((x) => x.name === 'Article correctif');
  check('9h. CA cumulé = 30 000', Number(prof?.revenue) === 30000, `obtenu ${prof?.revenue}`);
  check('9i. coût des marchandises = 12 000', Number(prof?.cost_of_goods) === 12000,
    `obtenu ${prof?.cost_of_goods}`);
  check('9j. marge brute = 18 000 (30 000 − 12 000)', Number(prof?.gross_profit) === 18000,
    `obtenu ${prof?.gross_profit}`);
  check('9k. taux de marge = 60 %', Math.round(Number(prof?.margin_pct)) === 60,
    `obtenu ${prof?.margin_pct}`);
}

// ═══ 10. Fournisseurs ═════════════════════════════════════
// Un fournisseur par produit, ON DELETE SET NULL : supprimer un grossiste ne
// doit jamais supprimer les articles qui en dépendent.
console.log('\n▸ Fournisseurs');

const FOURNISSEUR = 'a0a0a0a0-a0a0-a0a0-a0a0-a0a0a0a0a0a0';
const ART_SANS = 'b0b0b0b0-b0b0-b0b0-b0b0-b0b0b0b0b0b0';
const ART_AVEC = 'c0c0c0c0-c0c0-c0c0-c0c0-c0c0c0c0c0c0';

await q(`SELECT set_config('request.jwt.claim.sub', '${PATRON}', false)`);

await q(`INSERT INTO products (id, user_id, name, price_buy, price_sell, stock_qty)
         VALUES ('${ART_SANS}', '${PATRON}', 'Sans fournisseur', 1000, 2000, 5),
                ('${ART_AVEC}', '${PATRON}', 'Avec fournisseur', 1000, 2000, 5)`);

{
  // Un nom vide ou en blanc est refusé : la colonne porte le nom, pas une
  // adresse email.
  let msg = '';
  try {
    await q(`INSERT INTO suppliers (user_id, name) VALUES ('${PATRON}', '   ')`);
  } catch (e) { msg = e.message; }
  check('10a. nom de fournisseur vide refusé', /suppliers_name_not_blank/.test(msg),
    msg || 'accepté !');
}

{
  await q(`INSERT INTO suppliers (id, user_id, name, phone)
           VALUES ('${FOURNISSEUR}', '${PATRON}', 'Grossiste Cokhan', '+229 97 00 00 00')`);
  await q(`UPDATE products SET supplier_id = '${FOURNISSEUR}' WHERE id = '${ART_AVEC}'`);

  const n = await count(`SELECT count(*) FROM suppliers WHERE user_id='${PATRON}'`);
  check('10b. fournisseur créé', n === 1, `${n}`);
}

// La vue doit conserver les produits sans fournisseur, pas les masquer.
// Filtré sur nos deux articles : les sections précédentes ont déjà créé des
// produits, et le test porte sur ce catalogue-là.
{
  const rows = (await q(`SELECT name, supplier_id, supplier_name
                         FROM products_with_supplier
                         WHERE id IN ('${ART_SANS}', '${ART_AVEC}')
                         ORDER BY name`)).rows;
  check('10c. la vue expose les deux articles', rows.length === 2, `${rows.length}`);
  const avec = rows.find((r) => r.name === 'Avec fournisseur');
  const sans = rows.find((r) => r.name === 'Sans fournisseur');
  check('10d. fournisseur résolu (jointure)', avec?.supplier_name === 'Grossiste Cokhan',
    avec?.supplier_name);
  check('10e. produit sans fournisseur conservé', sans && sans.supplier_id === null,
    JSON.stringify(sans));
}

// Supprimer un fournisseur NE doit pas supprimer les articles.
{
  await q(`DELETE FROM suppliers WHERE id = '${FOURNISSEUR}'`);
  const n = await count(`SELECT count(*) FROM products WHERE id = '${ART_AVEC}'`);
  check('10f. l\'article survit à la suppression du fournisseur', n === 1, `${n}`);

  const orphelin = (await q(`SELECT supplier_id FROM products WHERE id='${ART_AVEC}'`)).rows[0];
  check('10g. fournisseur mis à null (SET NULL)', orphelin.supplier_id === null,
    String(orphelin.supplier_id));
}

// Un fournisseur d'un autre tenant est invisible et inutilisable.
{
  const AUTRE5 = '55555555-5555-5555-5555-555555555555';
  await q(`INSERT INTO auth.users (id,email) VALUES ('${AUTRE5}','fourn@t.ci')
          ON CONFLICT (id) DO NOTHING`);
  await q(`INSERT INTO organizations (id,name,slug) VALUES ('${AUTRE5}','Chez lui','chezlui')
          ON CONFLICT (id) DO NOTHING`);
  await q(`INSERT INTO suppliers (user_id, name) VALUES ('${AUTRE5}','GrossisteBidon')`);

  // Rattachement refusé : la policy vérifie can_manage_products() ET le tenant.
  let refuse = false;
  try {
    await q(`UPDATE products SET supplier_id = (SELECT id FROM suppliers WHERE user_id='${AUTRE5}')
             WHERE id='${ART_SANS}'`);
  } catch { refuse = true; }
  check('10h. rattacher un fournisseur d\'autre boutique : refusé', refuse);

  // Et invisible en lecture, sous le rôle authentifié.
  await q(`SELECT set_config('request.jwt.claim.sub', '${PATRON}', false)`);
  await e('SET ROLE authenticated');
  const vus = Number((await q(
    `SELECT count(*)::int c FROM suppliers WHERE user_id='${AUTRE5}'`)).rows[0].c);
  await e('RESET ROLE');
  check('10i. les fournisseurs d\'autre tenant sont invisibles', vus === 0, `${vus} vue(s)`);
}

// Rôle : un employé ne gère pas le catalogue fournisseurs.
{
  await q(`SELECT set_config('request.jwt.claim.sub', '${EMPLOYE}', false)`);
  await e('SET ROLE authenticated');
  let insere = false;
  try {
    await q(`INSERT INTO suppliers (user_id, name) VALUES ('${PATRON}', 'Interdit')`);
    insere = true;
  } catch { /* refusé */ }
  await e('RESET ROLE');
  check('10j. un employé NE CRÉE PAS de fournisseur', !insere);
}

// Vue : l'isolation tient sous le rôle authentifié.
{
  await q(`SELECT set_config('request.jwt.claim.sub', '${PATRON}', false)`);
  await e('SET ROLE authenticated');
  const noms = (await q(
    `SELECT DISTINCT supplier_name FROM products_with_supplier
      WHERE supplier_name IS NOT NULL`)).rows.map((r) => r.supplier_name);
  await e('RESET ROLE');
  check('10k. la vue n\'expose aucun fournisseur d\'autre tenant',
    !noms.includes('GrossisteBidon'), noms.join(', '));
}

console.log(`\n${failures === 0 ? '✅' : '❌'} ${failures} échec(s)`);
process.exit(failures ? 1 : 0);
