// Reproduit le cas que les tests ne voyaient pas : appliquer
// migration_weighted_sales.sql sur une base où products_with_supplier EXISTE
// déjà. C'est la situation réelle de tout projet ayant déjà reçu la série de
// migrations — l'ordre des fichiers fait que la vue est créée après l'ALTER, et
// les tests, qui partent d'une base neuve, ne la rencontrent jamais.
//
// Scénario : appliquer toutes les migrations, puis rejouer la série complète
// comme le fait un utilisateur qui colle APPLY_MIGRATIONS.sql.
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
import path from 'path';

const ORDER = [
  'schema.sql', 'migration_team.sql', 'migration_saas.sql', 'migration_plan_limits.sql',
  'migration_invoices.sql', 'migration_webhook_logs.sql', 'migration_indexes.sql',
  'migration_sales_rpc.sql', 'migration_roles.sql', 'migration_price_override.sql',
  'migration_weighted_sales.sql', 'migration_credit.sql', 'migration_profitability.sql',
  'migration_expenses.sql', 'migration_invitations.sql', 'migration_profitability_fix.sql',
  'migration_suppliers.sql', 'migration_credit_fns.sql',
];

let failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${label}`);
  else { failed++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

const db = new PGlite();
const read = (f) => fs.readFileSync(path.join('supabase', f), 'utf8')
  .replace(/CREATE EXTENSION[^;]*;/gi, '');

process.on('unhandledRejection', (e) => { console.log(`  ERREUR : ${e.message}`); process.exit(1); });

await db.exec(`
  CREATE SCHEMA IF NOT EXISTS auth;
  CREATE TABLE IF NOT EXISTS auth.users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text, raw_user_meta_data jsonb DEFAULT '{}'::jsonb);
  CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
    $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS
    $$ SELECT COALESCE(current_setting('request.jwt.role', true), 'anon') $$;
  CREATE OR REPLACE FUNCTION uuid_generate_v4() RETURNS uuid LANGUAGE sql VOLATILE AS
    $$ SELECT gen_random_uuid() $$;
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
`);

console.log('▸ Première application (base neuve)');
for (const f of ORDER) {
  try { await db.exec(read(f)); }
  catch (e) { failed++; console.log(`  ✗ ${f} — ${e.message}`); }
}

const vue = (await db.query(
  `SELECT count(*)::int c FROM pg_views WHERE viewname='products_with_supplier'`)).rows[0].c;
check('la vue products_with_supplier existe', vue === 1, `${vue}`);

// On remet les colonnes en entier, comme avant la migration du poids : c'est
// l'état de la base de l'utilisateur au moment où il colle le fichier.
await db.exec(`
  DROP VIEW IF EXISTS products_with_supplier;
  ALTER TABLE sale_items   ALTER COLUMN quantity TYPE integer;
  ALTER TABLE products     ALTER COLUMN stock_qty TYPE integer;
  ALTER TABLE products     ALTER COLUMN min_stock_level TYPE integer;
  ALTER TABLE stock_logs   ALTER COLUMN quantity_change TYPE integer,
                            ALTER COLUMN stock_before TYPE integer,
                            ALTER COLUMN stock_after TYPE integer;
`);
await db.exec(read('migration_suppliers.sql'));  // la vue est de retour

console.log('\n▸ Seconde application (base déjà peuplée — le cas réel)');
for (const f of ORDER) {
  try { await db.exec(read(f)); }
  catch (e) { failed++; console.log(`  ✗ ${f}\n      ${e.message}`); }
}

const types = (await db.query(`
  SELECT table_name, column_name, data_type FROM information_schema.columns
   WHERE (table_name, column_name) IN (
     ('sale_items','quantity'), ('products','stock_qty'), ('stock_logs','stock_after'))`)).rows;
for (const t of types) {
  check(`${t.table_name}.${t.column_name} en NUMERIC`, t.data_type === 'numeric', t.data_type);
}

const vue2 = (await db.query(
  `SELECT count(*)::int c FROM pg_views WHERE viewname='products_with_supplier'`)).rows[0].c;
check('la vue est recréée', vue2 === 1, `${vue2}`);

const col = (await db.query(
  `SELECT data_type FROM information_schema.columns
    WHERE table_name='sale_items' AND column_name='list_price'`)).rows[0];
check('sale_items.list_price conservée', col?.data_type === 'numeric', col?.data_type);

// ── Autonomie du fichier ──────────────────────────────────
// Le test précédent ne prouve PAS que migration_weighted_sales.sql répare ce
// qu'il casse : migration_suppliers.sql passe après et recréerait la vue de
// toute façon. Or ce fichier EST réappliqué seul, par le test de rejouabilité
// (pour rétablir la dernière version de create_sale()).
//
// S'appuyer sur une migration ultérieure est un pari : si un jour suppliers est
// déplacée avant, la vue disparaît sans la moindre erreur — le catalogue devient
// invisible. On teste donc le fichier isolement, comme il sera réellement
// appliqué.
console.log('\n▸ weighted_sales seule, sur une base qui a déjà tout');
try {
  await db.exec(read('migration_weighted_sales.sql'));
} catch (e) {
  failed++;
  console.log(`  ✗ application isolée\n      ${e.message}`);
}
const vue3 = (await db.query(
  `SELECT count(*)::int c FROM pg_views WHERE viewname='products_with_supplier'`)).rows[0].c;
check('la vue survit à une application isolée', vue3 === 1, `${vue3}`);

// Et elle est réellement lisible : une vue vide ou cassée ne se voit pas au
// pg_views, seulement à la première requête de l'application.
// products.user_id référence auth.users : la ligne de test doit s'appuyer sur un
// utilisateur réel, sinon c'est la contrainte qui échoue et non la vue.
try {
  await db.exec(`
    INSERT INTO auth.users (id, email)
      VALUES ('99999999-9999-4999-8999-999999999999', 'vue@test.ci')
      ON CONFLICT DO NOTHING;
    INSERT INTO products (user_id, name)
      VALUES ('99999999-9999-4999-8999-999999999999', 'Article vue')`);
  const lue = (await db.query(`SELECT count(*)::int c FROM products_with_supplier`)).rows[0].c;
  check('la vue se lit', lue >= 1, `${lue}`);
} catch (e) {
  failed++;
  console.log(`  ✗ lecture de la vue\n      ${e.message}`);
}

// security_invoker doit survivre à la recréation : une vue en SECURITY DEFINER
// contournerait la RLS et exposerait le catalogue d'un autre tenant.
const inv = (await db.query(
  `SELECT c.reloptions FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relname = 'products_with_supplier' AND n.nspname = 'public'`)).rows[0];
check('security_invoker conservé',
  (inv?.reloptions ?? []).includes('security_invoker=true'),
  JSON.stringify(inv?.reloptions));

console.log(`\n${failed === 0 ? '✅' : '❌'} ${failed} échec(s)`);
await db.close();
process.exit(failed ? 1 : 0);
