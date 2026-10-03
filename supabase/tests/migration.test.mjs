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
  // Crée require_feature(), referenced par les trois fonctions payantes
  // (get_product_profitability, get_cash_flow, get_customer_debts). Doit
  // précéder ces trois migrations, sinon la fonction n'existe pas encore.
  'migration_plan_gate.sql',
  // Les trois migrations qui redéfinissent create_sale(). Vues dans cet ordre,
  // la dernière version l'emporte : vente au poids (NUMERIC + virgule).
  //
  // ⚠ Toute migration antérieure listée APRÈS celles-ci réécrirait
  //   create_sale() dans sa version entière — y compris pendant le test de
  //   rejouabilité, qui les rejoue dans l'ordre du tableau. C'est exactement ce
  //   qui faisait échouer la section « vente au poids » : migration_sales_rpc.sql
  //   rejouée réinstallait la version à quantités entières, et 1,5 kg était
  //   refusé avec « Ligne de panier invalide ».
  'migration_price_override.sql',
  'migration_weighted_sales.sql',
  // Crée sales.settled : les deux migrations suivantes filtrent dessus pour la
  // recette à l'encaissement. Doit précéder profitability et expenses.
  'migration_credit.sql',
  // Cree sales.amount_received, lu par les deux migrations suivantes.
  'migration_partial_payment.sql',
  'migration_profitability.sql',
  'migration_expenses.sql',
  'migration_invitations.sql',
  'migration_profitability_fix.sql',
  'migration_suppliers.sql',
  'migration_credit_fns.sql',
  // Doit etre applique apres organizations (schema.sql) : son trigger
  // s'execute sur chaque creation de boutique.
  'migration_beta_program.sql',
  // DOIT RESTER DERNIERE. Elle ferme les failles ouvertes plus tôt : RLS sur
  // rate_limits, verrou de organizations.plan, index unique sur subscriptions,
  // policies de business_members et la garde de redeem_invitation(). La placer
  // avant redeviendrait ces failles a la seconde migration suivante.
  'migration_sales_summary.sql',
  'migration_security.sql',
];

// schema.sql et migration_team.sql sont appliqués deux fois, à la fin : sur une
// base existante, un `CREATE TABLE` sans IF NOT EXISTS échoue en 42P07 et
// interrompt le script en cours de route. C'est ce que l'utilisateur a rencontré
// en collant le fichier complet.

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
      raw_user_meta_data jsonb DEFAULT '{}'::jsonb,
      -- Colonnes jeton que migration_security.sql section 6 remplit quand elles
      -- sont NULL : GoTrue les lit dans un string non nullable.
      confirmation_token text,
      recovery_token text,
      email_change_token_new text,
      email_change text
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
  // Et leurs privilèges par défaut, eux aussi. Supabase accorde EXECUTE sur
  // les fonctions à anon, authenticated et service_role au moment de la
  // création (ALTER DEFAULT PRIVILEGES) : le grant ne vient PAS de PUBLIC.
  // Sans cette ligne, le harnais diffère de la base réelle — un
  // `REVOKE ... FROM PUBLIC` y passe alors qu'en production il laisse la clé
  // anon parfaitement capable d'appeler la fonction. Un test vert qui ne
  // prouve rien, c'est pire qu'absent.
  await e(`ALTER DEFAULT PRIVILEGES IN SCHEMA public
             GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;`);
}

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
// TOUTES les migrations doivent être rejouables : le fichier
// APPLY_MIGRATIONS.sql les concatène et l'utilisateur le colle en un bloc sur
// une base déjà peuplée. Un `CREATE TABLE` sans IF NOT EXISTS échoue alors en
// 42P07 et interrompt le script — c'est ce qu'il a rencontré.
//
// Une policy créée sans DROP préalable échoue de même en 42710.
//
// ⚠ La rejouabilité teste que le SCRIPT ne casse pas, pas qu'il produit le bon
// état. Rejouer chaque migration dans l'ordre du tableau réinstalle
// create_sale() dans sa version la plus ancienne — migration_sales_rpc.sql la
// redéfinit entièrement. La base se retrouvait avec une fonction à quantités
// entières alors que la colonne était numérique, et la section « vente au
// poids » échouait sur 1,5 kg.
//
// On rejoue donc dans l'ordre d'application reel, et on remet la derniere
// version de chaque fonction a la fin : c'est l'etat attendu apres coup.
const REPLAYABLE = ORDER;

const DERNIERE_VERSION = [
  // Fonctions redefinies par plusieurs migrations : seule la derniere compte.
  'migration_sales_rpc.sql',      // bump_rate_limit, purge_rate_limits
  'migration_price_override.sql', // create_sale (prix negocié)
  'migration_weighted_sales.sql', // create_sale (NUMERIC) + vue fournisseur
  // ⚠ suppliers passe après weighted_sales : celui-ci recrée
  //   products_with_supplier, et il lui faut la table suppliers pour ce faire.
  'migration_suppliers.sql',     // products_with_supplier (remise en état)
  'migration_profitability.sql',  // archive_product, restore_product, gel du cout
  'migration_expenses.sql',       // seed_expense_categories
  'migration_invitations.sql',    // redeem_invitation, purge_accepted_invitations
  'migration_roles.sql',          // can_manage_products
  'migration_credit_fns.sql',     // normalize_phone, record_credit_sale, pay, soldes
  'migration_partial_payment.sql', // amount_received + remplissage des ventes
  // ⚠ migration_saas.sql est volontairement ABSENTE. Elle contient le seed
  //   « créer une organisation pour tout utilisateur Auth existant », qui
  //   n'est pas une redéfinition de fonction : la rejouer donnait une
  //   organisation fantôme à l'employé du test 4k et cassait deux assertions.
  //   Un seed de données n'a pas à être rejoué pour que le schéma soit bon.
  //
  // get_cash_flow() porte un type de retour différent depuis la section 8 de
  // migration_security.sql (colonne cogs ajoutée). Son corps n'existe donc
  // qu'à un seul endroit, et c'est ici qu'on le rétablit : la rejouabilité a
  // pu réinstaller l'ancienne version via migration_expenses.sql, et la
  // remise en état s'arrête à migration_partial_payment.sql.
  // En DERNIÈRE position, comme la règle du dépôt l'impose.
  'migration_security.sql',
];

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

  // Remise en état : la rejouabilité a réinstallé les fonctions dans leur
  // version la plus ancienne (create_sale() est redéfinie en entier par
  // migration_sales_rpc.sql). Sans cette étape, la suite teste une base qui
  // ne correspond à aucun déploiement réel.
  for (const file of DERNIERE_VERSION) {
    const sql = fs.readFileSync(path.join(SQL_DIR, file), 'utf8')
      .replace(/CREATE EXTENSION[^;]*;/gi, '');
    try {
      await db.exec(sql);
    } catch (err) {
      failures++;
      console.log(`  ✗ ${file} (état final)\n    ${err.message}`);
    }
  }
  const def = (await q(
    `SELECT pg_get_functiondef(oid) AS d FROM pg_proc WHERE proname = 'create_sale'`)).rows[0]?.d ?? '';
  const etatFinal = def.includes("replace(e->>'quantity', ',', '.')");
  if (!etatFinal) {
    failures++;
    console.log('  ✗ create_sale() n\'est pas revenue à la version quantité décimale');
  }
}

// ─── 2. Jeu de données de test ──────────────────────────────
console.log('\n▸ Jeu de données');
const PATRON = '11111111-1111-1111-1111-111111111111';
const EMPLOYE = '22222222-2222-2222-2222-222222222222';

// Le programme bêta est FERMÉ pendant toute la suite, sauf sa section dédiée.
//
// Sans cela, chaque INSERT INTO organizations du harnais consommerait une place
// et passerait la boutique en Pro — y compris celles que la section sur le verrou
// de plan crée volontairement en gratuit pour vérifier qu'il sont refusées. Le
// test échouerait non pas parce que le code est faux, mais parce qu'un programme
// de test est ouvert. C'est le genre de couplings qui fait qu'un test rouge ne
// veut plus rien dire.
await e(`UPDATE beta_program SET open = false, slots_used = 0 WHERE id = 1`);

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

// 3b. Le prix catalogue reste la référence : il n'est jamais modifié par la vente.
//
// Cette règle a changé. create_sale() ignorait auparavant tout prix transmis
// (test 3b d'origine : « prix forgé ignoré »), parce qu'un client ne doit pas
// pouvoir facturer 1 FCFA. Mais dans un marché où le marchandage est la règle,
// l'impossibilité de modifier un prix est un blocage, pas une protection.
//
// Le prix catalogue n'est donc plus imposé, mais il est conservé dans
// sale_items.list_price : c'est la traçabilité qui remplace le verrou.
{
  const res = await sale(`[{"product_id":"${P1}","quantity":1,"unit_price":1}]`, 'momo');
  const li = (await q(`SELECT unit_price, list_price FROM sale_items WHERE sale_id='${res.id}'`)).rows[0];
  check('3b. prix convenu appliqué (1)', Number(li.unit_price) === 1, `obtenu ${li.unit_price}`);
  check('3b2. prix catalogue conservé pour comparaison', Number(li.list_price) === 7000, `obtenu ${li.list_price}`);
  check('3b3. remise restituée = 6 999', Number(res.discount_amount) === 6999, `obtenu ${res.discount_amount}`);

  // Ce que la vente ne doit PAS pouvoir faire : sortir le stock d'un autre
  // tenant, ou donner le stock. C'est la véritable surface d'attaque.
  const vol = Number((await q(`SELECT total_amount FROM sales WHERE id='${res.id}'`)).rows[0].total_amount);
  check('3b4. total = prix convenu × quantité', vol === 1, `obtenu ${vol}`);
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
  } catch {
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
  // Insertion directe en SQL, sans passer par create_sale(). C'est le cas du
  // trigger fill_amount_received() : sans lui, amount_received resterait à 0 et
  // cette vente payée disparaîtrait du chiffre d'affaires sans lever la moindre
  // erreur. Le test vérifie que le trigger rattrape l'oubli.
  const d = '2026-06-15';
  await q(`INSERT INTO sales (user_id, total_amount, payment_method, created_at)
           VALUES ('${PATRON}', 20000, 'cash', '${d}T10:00:00+00:00')`);
  await q(`INSERT INTO expenses (user_id,category,label,amount,day)
           VALUES ('${PATRON}','Électricité','EDF juin',15000,'${d}')`);

  const saisi = (await q(`SELECT amount_received FROM sales
     WHERE user_id = '${PATRON}' AND total_amount = 20000
       AND created_at::text LIKE '${d}%'`)).rows[0];
  check('7f0. insertion directe : amount_received renseigné par le trigger',
    Number(saisi?.amount_received) === 20000, String(saisi?.amount_received));

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
           VALUES ('${PATRON}','Autre','Achat 2 kwatt',3000,'${d}')`);
  const row = (await q(`SELECT * FROM get_cash_flow('${d}', '${d}')`)).rows[0];
  check('7j. journée sans vente mais avec charge visible', !!row && Number(row.revenue) === 0,
    row ? `revenue ${row.revenue}` : 'jour absent');
}

// Le coût des marchandises vendues fait partie du résultat. Sans lui, l'écran
// « Charges » affichait CA − charges : un bénéfice fictif, puisque le prix de
// la marchandise n'était déduit nulle part. Relevé en prod sur 30 jours :
// 1 161 200 F affichés pour 207 444 F réels, l'écart valant exactement le CMV.
{
  const d = '2026-06-18';
  const p = '9c9c9c9c-0000-4000-8000-000000000001';
  const s = '9c9c9c9c-0000-4000-8000-000000000002';
  await q(`INSERT INTO products (id, user_id, name, price_buy, price_sell, stock_qty)
           VALUES ('${p}', '${PATRON}', 'Sac de riz 25 kg', 4000, 10000, 50)`);
  await q(`INSERT INTO sales (id, user_id, total_amount, payment_method, created_at)
           VALUES ('${s}', '${PATRON}', 30000, 'cash', '${d}T09:00:00+00:00')`);
  await q(`INSERT INTO sale_items
             (sale_id, product_id, product_name, quantity, unit_price, subtotal, unit_cost)
           VALUES ('${s}', '${p}', 'Sac de riz 25 kg', 3, 10000, 30000, 4000)`);

  const row = (await q(`SELECT * FROM get_cash_flow('${d}', '${d}')`)).rows[0];
  check('7o. CA du jour = 30 000', Number(row?.revenue) === 30000, `obtenu ${row?.revenue}`);
  check('7p. coût des marchandises = 12 000 (3 × 4 000)', Number(row?.cogs) === 12000,
    `obtenu ${row?.cogs}`);
  check('7q. le résultat déduit bien le coût : CA − CMV − charges',
    Number(row?.net) === Number(row?.revenue) - Number(row?.cogs) - Number(row?.expenses),
    `net ${row?.net} pour CA ${row?.revenue}, CMV ${row?.cogs}, charges ${row?.expenses}`);
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
  } catch {
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

// ═══ 11. Prix négocié ═════════════════════════════════════
// Cas réel de marché : « c'est le dernier prix ». Le prix catalogue reste la
// référence et la remise doit rester traçable, sinon la caisse peut cacher du
// chiffre d'affaires.
console.log('\n▸ Prix négocié');

const NEGO = 'd0d0d0d0-d0d0-d0d0-d0d0-d0d0d0d0d0d0';
await q(`SELECT set_config('request.jwt.claim.sub', '${PATRON}', false)`);
await q(`INSERT INTO products (id, user_id, name, price_buy, price_sell, stock_qty)
         VALUES ('${NEGO}', '${PATRON}', 'Article négocié', 4000, 10000, 100)`);

const vendre = async (items) => {
  const r = await q(`SELECT create_sale('${items}'::jsonb, 'cash', null) AS v`);
  const b = r.rows[0]?.v;
  return typeof b === 'string' ? JSON.parse(b) : b;
};
const ligne = (saleId) =>
  q(`SELECT * FROM sale_items WHERE sale_id='${saleId}'`);

{
  // 1. Prix catalogue : le comportement historique doit être inchangé.
  const v = await vendre(
    JSON.stringify([{ product_id: NEGO, quantity: 2 }]));
  const li = (await ligne(v.id)).rows[0];
  check('11a. sans prix transmis : prix catalogue', Number(li.unit_price) === 10000, String(li.unit_price));
  check('11b. list_price renseigné même sans remise', Number(li.list_price) === 10000, String(li.list_price));
  check('11c. total = 2 × 10 000', Number(v.total_amount) === 20000, String(v.total_amount));
  check('11d. aucune remise signalée', Number(v.discount_amount) === 0, String(v.discount_amount));
}

{
  // 2. Le cas du marchandage : prix convenu inférieur au catalogue.
  const v = await vendre(
    JSON.stringify([{ product_id: NEGO, quantity: 2, unit_price: 8000 }]));
  const li = (await ligne(v.id)).rows[0];
  check('11e. prix convenu enregistré', Number(li.unit_price) === 8000, String(li.unit_price));
  check('11f. prix catalogue conservé (remise traçable)', Number(li.list_price) === 10000, String(li.list_price));
  check('11g. total recalculé sur le prix convenu', Number(v.total_amount) === 16000, String(v.total_amount));
  check('11h. remise signalée = 4 000', Number(v.discount_amount) === 4000, String(v.discount_amount));
  // La marge doit suivre le prix réellement encaissé, pas le catalogue.
  check('11i. coût figé sur la ligne inchangé', Number(li.unit_cost) === 4000, String(li.unit_cost));
}

{
  // 3. Revente à perte : autorisée, mais comptée.
  const v = await vendre(
    JSON.stringify([{ product_id: NEGO, quantity: 1, unit_price: 3000 }]));
  const li = (await ligne(v.id)).rows[0];
  check('11j. vente à perte autorisée (3 000 < coût 4 000)', Number(v.total_amount) === 3000, String(v.total_amount));
  check('11k. vente à perte signalée (at_loss_count)', Number(v.at_loss_count) === 1, String(v.at_loss_count));
  check('11l. coût figé malgré la perte', Number(li.unit_cost) === 4000, String(li.unit_cost));
}

{
  // 4. Prix supérieur au catalogue : autorisé (vente flash, lot au détail).
  const v = await vendre(
    JSON.stringify([{ product_id: NEGO, quantity: 1, unit_price: 12000 }]));
  const li = (await ligne(v.id)).rows[0];
  check('11m. prix supérieur au catalogue accepté', Number(li.unit_price) === 12000, String(li.unit_price));
  check('11n. remise = 0 (pas de remise, pas de majoration)', Number(v.discount_amount) === 0, String(v.discount_amount));
}

{
  // 5. Garde-fous : ce qui n'a pas de sens marchand est refusé.
  let msg = '';
  try {
    await vendre(JSON.stringify([{ product_id: NEGO, quantity: 1, unit_price: 0 }]));
  } catch (e) { msg = e.message; }
  check('11o. prix à 0 refusé', /Ligne de panier invalide/.test(msg), msg || 'accepté !');

  msg = '';
  try {
    await vendre(JSON.stringify([{ product_id: NEGO, quantity: 1, unit_price: -500 }]));
  } catch (e) { msg = e.message; }
  check('11p. prix négatif refusé', /Ligne de panier invalide/.test(msg), msg || 'accepté !');

  msg = '';
  try {
    await vendre(JSON.stringify([{ product_id: NEGO, quantity: 1, unit_price: 'gratuit' }]));
  } catch (e) { msg = e.message; }
  check('11q. prix non numérique refusé', /Ligne de panier invalide/.test(msg), msg || 'accepté !');
}

{
  // 6. Deux prix différents pour le même article : ambigu, donc refusé.
  //    Prendre le minimum ou le maximum permettrait de fabriquer un panier truqué.
  let msg = '';
  try {
    await vendre(JSON.stringify([
      { product_id: NEGO, quantity: 1, unit_price: 100 },
      { product_id: NEGO, quantity: 1, unit_price: 9000 },
    ]));
  } catch (e) { msg = e.message; }
  check('11r. deux prix pour le même article : refusé', /Deux prix différents/.test(msg), msg || 'accepté !');
}

{
  // 7. Même article à deux lignes, même prix : l'agrégation doit encore
  //    fonctionner, et le prix convenu être conservé.
  const v = await vendre(JSON.stringify([
    { product_id: NEGO, quantity: 2, unit_price: 7000 },
    { product_id: NEGO, quantity: 1, unit_price: 7000 },
  ]));
  const li = (await ligne(v.id)).rows;
  check('11s. lignes agrégées en une seule', li.length === 1, `${li.length} ligne(s)`);
  check('11t. quantités cumulées (2 + 1 = 3)', Number(li[0].quantity) === 3, String(li[0].quantity));
  check('11u. prix convenu conservé après agrégation', Number(li[0].unit_price) === 7000, String(li[0].unit_price));
  check('11v. total = 3 × 7 000', Number(v.total_amount) === 21000, String(v.total_amount));
}

{
  // 8. Le stock est décrémenté du montant réel, même avec un prix négocié.
  //    Ventes abouties : 2 (11a) + 2 (11e) + 1 (11j) + 1 (11m) + 3 (11s) = 9.
  //    Les ventes refusées (prix 0, négatif, non numérique, conflit) ne doivent
  //    rien consommer : c'est le point qu'on vérifie ici.
  const stock = (await q(`SELECT stock_qty FROM products WHERE id='${NEGO}'`)).rows[0].stock_qty;
  check('11w. stock décrémenté du seul volume vendu (9 unités)',
    Number(stock) === 100 - 9, `stock = ${stock}, attendu ${100 - 9}`);
}

{
  // 9. Une remise ne doit pas pouvoir servir à sortir le stock d'un autre
  //    tenant : le prix ne dispense pas de la validation de stock.
  let refuse = false;
  try {
    await q(`SELECT set_config('request.jwt.claim.sub',
      (SELECT owner_id FROM business_members LIMIT 1), false)`);
    await vendre(JSON.stringify([{ product_id: NEGO, quantity: 1, unit_price: 100 }]));
  } catch { refuse = true; }
  await q(`SELECT set_config('request.jwt.claim.sub', '${PATRON}', false)`);
  check('11x. un employé ne vend pas un produit du patron', refuse);
}

// ═══ 12. Changer la signature de retour d'une fonction ══════
// PostgreSQL refuse en 42P13 de remplacer une fonction dont le type de retour
// diffère : les paramètres OUT font partie de la signature. C'est ce que
// l'utilisateur a rencontré en collant APPLY_MIGRATIONS.sql après l'ajout des
// colonnes de prix négocié à get_product_profitability().
//
// On vérifie le mécanisme : une fonction à signature retour A, remplacée par une
// à signature retour B, doit rester applicable.
console.log('\n▸ Changement de signature de retour');

{
  const signA = 'alpha int, beta int';
  const signB = 'alpha int, beta int, gamma int';

  await e(`CREATE OR REPLACE FUNCTION sig_test() RETURNS TABLE (${signA})
           LANGUAGE sql STABLE AS $$ SELECT 1 AS alpha, 2 AS beta $$`);

  // Sans DROP préalable, ce remplacement échoue : c'est le cas que la migration
  // doit éviter.
  let refuse = false;
  try {
    await e(`CREATE OR REPLACE FUNCTION sig_test() RETURNS TABLE (${signB})
             LANGUAGE sql STABLE AS $$ SELECT 1 AS alpha, 2 AS beta, 3 AS gamma $$`);
  } catch (err) {
    refuse = /42P13|cannot change return type/i.test(err.message);
  }
  check('12a. sans DROP, le changement de signature est refusé (42P13)', refuse);

  // Avec DROP : le remplacement passe.
  await e(`DROP FUNCTION IF EXISTS sig_test()`);
  await e(`CREATE FUNCTION sig_test() RETURNS TABLE (${signB})
           LANGUAGE sql STABLE AS $$ SELECT 1 AS alpha, 2 AS beta, 3 AS gamma $$`);
  const r = (await q(`SELECT * FROM sig_test()`)).rows[0];
  check('12b. avec DROP préalable, la nouvelle signature s\'applique', r?.gamma === 3, JSON.stringify(r));

  await e(`DROP FUNCTION IF EXISTS sig_test()`);
}

// Et la migration réelle : ses trois nouvelles colonnes doivent être là.
{
  const cols = (await q(
    `SELECT * FROM get_product_profitability() LIMIT 1`)).fields.map((f) => f.name);
  check('12c. get_product_profitability() expose avg_sold_price',
    cols.includes('avg_sold_price'), cols.join(', '));
  check('12d. … discount_given', cols.includes('discount_given'));
  check('12e. … units_sold_at_loss', cols.includes('units_sold_at_loss'));
}

// ═══ 13. Vente au poids ═══════════════════════════════════
// Le blocage n° 1 du marché : tout se vend au kilo, et la quantité était un
// INTEGER validé par `^[0-9]+$`. 1,2 kg de riz était impossible à enregistrer.
console.log('\n▸ Vente au poids');

const RIZ = 'e0e0e0e0-0000-4000-8000-000000000001';
await q(`SELECT set_config('request.jwt.claim.sub', '${PATRON}', false)`);
await q(`INSERT INTO products (id, user_id, name, unit, price_buy, price_sell, stock_qty)
         VALUES ('${RIZ}', '${PATRON}', 'Riz', 'kg', 600, 750, 50)`);

const vendreK = async (items) => {
  const r = await q(`SELECT create_sale('${items}'::jsonb, 'cash', null) AS v`);
  const b = r.rows[0]?.v;
  return typeof b === 'string' ? JSON.parse(b) : b;
};
const ligneK = (saleId) => q(`SELECT * FROM sale_items WHERE sale_id='${saleId}'`);

{
  // 1. Le cas de base : 1,5 kg à 750 F = 1 125 F.
  const v = await vendreK(JSON.stringify([{ product_id: RIZ, quantity: 1.5 }]));
  const li = (await ligneK(v.id)).rows[0];
  check('13a. 1,5 kg accepté', Number(li.quantity) === 1.5, String(li.quantity));
  check('13b. total = 1,5 × 750', Number(v.total_amount) === 1125, String(v.total_amount));
}

{
  // 2. La virgule décimale : un clavier de téléphone au Bénin produit « 1,2 ».
  //    Sans conversion, ::numeric échoue et la vente est refusée sans raison
  //    visible.
  const v = await vendreK(JSON.stringify([{ product_id: RIZ, quantity: '2,25' }]));
  const li = (await ligneK(v.id)).rows[0];
  check('13c. virgule décimale acceptée (2,25)', Number(li.quantity) === 2.25, String(li.quantity));
  check('13d. total = 2,25 × 750', Number(v.total_amount) === 1687.5, String(v.total_amount));
}

{
  // 3. Trois décimales : 1,250 kg se pèse au gramme près.
  const v = await vendreK(JSON.stringify([{ product_id: RIZ, quantity: '1.250' }]));
  check('13e. trois décimales acceptées', Number((await ligneK(v.id)).rows[0].quantity) === 1.25);
}

{
  // 4. Le stock décrémente proprement, sans reste fantôme.
  const stock = (await q(`SELECT stock_qty FROM products WHERE id='${RIZ}'`)).rows[0].stock_qty;
  // 50 − 1,5 − 2,25 − 1,25 = 45
  check('13f. stock décrémenté sans arrondi', Number(stock) === 45, `stock = ${stock}`);
}

{
  // 5. L'agrégation additionne les fractions, elle ne les écrase pas.
  //    1,2 + 0,8 = 2 et non 1 : c'est le cas des deux scans du même lot.
  const v = await vendreK(JSON.stringify([
    { product_id: RIZ, quantity: 1.2 },
    { product_id: RIZ, quantity: 0.8 },
  ]));
  const li = (await ligneK(v.id)).rows;
  check('13g. fractions agrégées en une ligne', li.length === 1, `${li.length} ligne(s)`);
  check('13h. 1,2 + 0,8 = 2 (pas 1)', Number(li[0].quantity) === 2, String(li[0].quantity));
  check('13i. total = 2 × 750', Number(v.total_amount) === 1500, String(v.total_amount));
}

{
  // 6. Le prix négocié s'applique au poids, pas au total.
  //    « 700 le kilo au lieu de 750 » — pas « 1400 les 2 kg ».
  const v = await vendreK(JSON.stringify([{ product_id: RIZ, quantity: 2, unit_price: 700 }]));
  check('13j. prix négocié au poids', Number(v.total_amount) === 1400, String(v.total_amount));
  check('13k. remise = 50 × 2', Number(v.discount_amount) === 100, String(v.discount_amount));
}

{
  // 7. Stock insuffisant : la comparaison est décimale, pas entière.
  //    Avec 1,5 kg restants, vendre 1,6 doit échouer — un cast en int
  //    tronquerait 1,6 à 1 et autoriserait la vente.
  await q(`UPDATE products SET stock_qty = 1.5 WHERE id='${RIZ}'`);
  let msg = '';
  try {
    await vendreK(JSON.stringify([{ product_id: RIZ, quantity: 1.6 }]));
  } catch (e) { msg = e.message; }
  check('13l. 1,5 en stock, 1,6 demandé : refusé', /Stock insuffisant/.test(msg), msg || 'accepté !');

  // Et 1,5 en stock, 1,5 demandé : passe, le stock tombe à zéro.
  const v = await vendreK(JSON.stringify([{ product_id: RIZ, quantity: 1.5 }]));
  const stock = (await q(`SELECT stock_qty FROM products WHERE id='${RIZ}'`)).rows[0].stock_qty;
  check('13m. 1,5 en stock, 1,5 demandé : accepté', !!v.id, msg);
  check('13n. stock exactement à zéro', Number(stock) === 0, `stock = ${stock}`);
}

{
  // 8. Le stock ne peut pas devenir négatif par fractions.
  await q(`UPDATE products SET stock_qty = 0.4 WHERE id='${RIZ}'`);
  let refuse = false;
  try {
    await vendreK(JSON.stringify([{ product_id: RIZ, quantity: 0.5 }]));
  } catch { refuse = true; }
  check('13o. 0,4 en stock, 0,5 demandé : refusé', refuse);
  const stock = (await q(`SELECT stock_qty FROM products WHERE id='${RIZ}'`)).rows[0].stock_qty;
  check('13p. stock resté à 0,4 (pas de décrément partiel)', Number(stock) === 0.4, `stock = ${stock}`);
}

{
  // 9. Garde-fous sur la quantité.
  let msg = '';
  try {
    await q(`UPDATE products SET stock_qty = 100 WHERE id='${RIZ}'`);
    await vendreK(JSON.stringify([{ product_id: RIZ, quantity: 0 }]));
  } catch (e) { msg = e.message; }
  check('13q. quantité nulle refusée', /Ligne de panier invalide/.test(msg), msg || 'acceptée !');

  msg = '';
  try { await vendreK(JSON.stringify([{ product_id: RIZ, quantity: -2 }])); }
  catch (e) { msg = e.message; }
  check('13r. quantité négative refusée', /Ligne de panier invalide/.test(msg), msg || 'acceptée !');

  msg = '';
  try { await vendreK(JSON.stringify([{ product_id: RIZ, quantity: 'un kilo' }])); }
  catch (e) { msg = e.message; }
  check('13s. quantité non numérique refusée', /Ligne de panier invalide/.test(msg), msg || 'acceptée !');

  msg = '';
  try { await vendreK(JSON.stringify([{ product_id: RIZ, quantity: '1.2.3' }])); }
  catch (e) { msg = e.message; }
  check('13t. deux points refusés', /Ligne de panier invalide/.test(msg), msg || 'acceptée !');
}

{
  // 10. L'unité est enregistrée et n'affecte aucun calcul.
  const u = (await q(`SELECT unit FROM products WHERE id='${RIZ}'`)).rows[0].unit;
  check('13u. unité enregistrée', u === 'kg', u);

  // Un produit créé avant la migration — donc sans unité explicite — vaut « pce »
  // et non NULL : l'écran affiche toujours quelque chose. P1 vient de la section
  // create_sale, il existe donc.
  const defaut = (await q(`SELECT unit FROM products WHERE id = '${P1}'`)).rows[0]?.unit;
  check('13v. unité par défaut = pce', defaut === 'pce', String(defaut));
}

{
  // 11. La marge au kilo reste juste : c'est le but de l'opération.
  //     Nom distinct de P2 (« Huile 1L » existe déjà) : sinon .find() renvoie
  //     le premier homonyme, qui n'a jamais été vendu.
  await q(`INSERT INTO products (id, user_id, name, unit, price_buy, price_sell, stock_qty)
           VALUES ('e1e1e1e1-0000-4000-8000-000000000002', '${PATRON}', 'Huile litre', 'L', 800, 1000, 20)`);
  await vendreK(JSON.stringify([{ product_id: 'e1e1e1e1-0000-4000-8000-000000000002', quantity: 2.5 }]));
  const prof = (await q(`SELECT * FROM get_product_profitability()`)).rows
    .find((x) => x.name === 'Huile litre');
  check('13w. CA = 2,5 × 1 000', Number(prof.revenue) === 2500, `obtenu ${prof.revenue}`);
  check('13x. coût = 2,5 × 800', Number(prof.cost_of_goods) === 2000, `obtenu ${prof.cost_of_goods}`);
  check('13y. marge = 500', Number(prof.gross_profit) === 500, `obtenu ${prof.gross_profit}`);
  check('13z. taux = 20 %', Math.round(Number(prof.margin_pct)) === 20, `obtenu ${prof.margin_pct}`);
}

// ═══ 14. Crédit client ═══════════════════════════════════
// Le carnet de dette. Choix comptable : recette à l'encaissement. Une vente à
// crédit ne compte ni dans le chiffre d'affaires ni dans la marge tant qu'elle
// n'est pas réglée — mais le stock part immédiatement.
console.log('\n▸ Crédit client');

const ART_C = 'f0f0f0f0-0000-4000-8000-00000000000a';
await q(`SELECT set_config('request.jwt.claim.sub', '${PATRON}', false)`);
await q(`INSERT INTO products (id, user_id, name, price_buy, price_sell, stock_qty)
         VALUES ('${ART_C}', '${PATRON}', 'Article crédit', 4000, 10000, 100)`);

const credit = async (qty, nom, tel) => {
  const r = await q(`SELECT record_credit_sale(
    '[{"product_id":"${ART_C}","quantity":${qty}}]'::jsonb, '${nom}', '${tel}', null) AS v`);
  const b = r.rows[0]?.v;
  return typeof b === 'string' ? JSON.parse(b) : b;
};

{
  // 1. Normalisation du numéro : trois écritures, un seul client.
  const n1 = (await q(`SELECT normalize_phone('+229 97 00 00 01') AS n`)).rows[0].n;
  const n2 = (await q(`SELECT normalize_phone('22997000001') AS n`)).rows[0].n;
  const n3 = (await q(`SELECT normalize_phone('97000001') AS n`)).rows[0].n;
  check('14a. « +229 97… » normalisé', n1 === '22997000001', n1);
  check('14b. « 229… » normalisé', n2 === '22997000001', n2);
  check('14c. numéro local préfixé 229', n3 === '22997000001', n3);

  const invalide = (await q(`SELECT normalize_phone('123') AS n`)).rows[0].n;
  check('14d. numéro trop court refusé', invalide === null, String(invalide));
  const vide = (await q(`SELECT normalize_phone('abc') AS n`)).rows[0].n;
  check('14e. texte non numérique refusé', vide === null, String(vide));
}

{
  // 2. Sans téléphone, pas de dette : elle serait orpheline.
  let msg = '';
  try { await credit(1, 'Sans tel', ''); } catch (e) { msg = e.message; }
  check('14f. vente à crédit sans téléphone : refusée', /téléphone est obligatoire/.test(msg), msg || 'acceptée !');

  msg = '';
  try { await credit(1, '', '+229 97 00 00 02'); } catch (e) { msg = e.message; }
  check('14g. vente à crédit sans nom : refusée', /nom du client/.test(msg), msg || 'acceptée !');
}

{
  // 3. La vente passe, le stock part, l'argent n'entre pas.
  const v = await credit(2, 'Koffi', '+229 97 00 00 01');
  check('14h. vente à crédit enregistrée', !!v?.id);
  check('14i. total correct (2 × 10 000)', Number(v.total_amount) === 20000, String(v.total_amount));
  check('14j. numéro normalisé renvoyé', v.client_phone === '22997000001', v.client_phone);

  const stock = (await q(`SELECT stock_qty FROM products WHERE id='${ART_C}'`)).rows[0].stock_qty;
  check('14k. le stock part quand même', Number(stock) === 98, `stock = ${stock}`);

  const s = (await q(`SELECT settled, payment_method, client_phone FROM sales WHERE id='${v.id}'`)).rows[0];
  check('14l. vente marquée non encaissée', s.settled === false);
  check('14m. moyen de paiement = credit', s.payment_method === 'credit', s.payment_method);
  check('14n. téléphone sur la vente', s.client_phone === '22997000001', String(s.client_phone));
}

{
  // 4. LE POINT CENTRAL : la vente ne compte PAS dans le chiffre d'affaires.
  const prof = (await q(`SELECT * FROM get_product_profitability()`)).rows
    .find((x) => x.name === 'Article crédit');
  check('14o. CA = 0 (recette à l\'encaissement)', Number(prof.revenue) === 0, `obtenu ${prof.revenue}`);
  check('14p. marge = 0 tant que non réglée', Number(prof.gross_profit) === 0, `obtenu ${prof.gross_profit}`);
  check('14q. coût des marchandises = 0 (non encaissé)', Number(prof.cost_of_goods) === 0, `obtenu ${prof.cost_of_goods}`);
  check('14r. MAIS les unités vendues comptent (fait physique)', Number(prof.units_sold) === 2, `obtenu ${prof.units_sold}`);
  check('14s. crédit en cours exposé à part', Number(prof.unsettled_credit) === 20000, `obtenu ${prof.unsettled_credit}`);
}

{
  // 5. Le résultat net ne doit PAS compter le crédit. Le harnais a déjà fait
  //    des ventes cash aujourd'hui : on compare donc le cash-flow du jour au
  //    cumul des ventes ENCAISSÉES de ce jour. L'écart doit être nul — si le
  //    crédit entrait, l'écart serait de 20 000.
  const jour = (await q(
    `SELECT (created_at AT TIME ZONE 'Africa/Porto-Novo')::date::text AS d
       FROM sales WHERE client_phone = '22997000001' LIMIT 1`)).rows[0].d;
  const ca = Number((await q(`SELECT * FROM get_cash_flow('${jour}', '${jour}')`)).rows[0]?.revenue ?? 0);
  // Le cash-flow vaut SUM(amount_received) : c'est la définition. La vente à
  // crédit du harnais est à 0 encaissé, donc elle n'entre pas — et c'est
  // exactement ce que ce test vérifie.
  const encaisse = Number((await q(
    `SELECT COALESCE(SUM(amount_received), 0) AS c FROM sales
      WHERE (created_at AT TIME ZONE 'Africa/Porto-Novo')::date::text = '${jour}'`)).rows[0].c);
  check('14t. le cash-flow = encaissements du jour (crédit non réglé exclu)',
    Math.abs(ca - encaisse) < 1, `cash-flow ${ca} vs encaissé ${encaisse}`);
}

{
  // 6. Le solde apparaît, et le plus ancien d'abord.
  const dettes = (await q(`SELECT * FROM get_customer_debts()`)).rows;
  check('14u. une dette listée', dettes.length === 1, `${dettes.length}`);
  check('14v. solde = 20 000', Number(dettes[0].total_due) === 20000, `obtenu ${dettes[0].total_due}`);
  check('14w. fiche client créée', dettes[0].phone === '22997000001', dettes[0].phone);
}

{
  // 7. Encaissement partiel : la norme. 8 000 sur 20 000.
  const d = (await q(`SELECT id FROM customer_debts WHERE phone='22997000001'`)).rows[0].id;
  const r = await q(`SELECT pay_customer_debt('${d}', 8000, 'cash', null) AS v`);
  const p = r.rows[0].v;
  check('14x. versement partiel accepté', !!p);
  check('14y. solde avant = 20 000', Number(p.balance_before) === 20000, String(p.balance_before));
  check('14z. solde après = 12 000', Number(p.balance_after) === 12000, String(p.balance_after));
  check('14aa. aucune vente soldée (règlement partiel)', Number(p.sales_settled) === 0, String(p.sales_settled));

  const encore = (await q(`SELECT count(*)::int c FROM sales WHERE NOT settled AND client_phone='22997000001'`)).rows[0].c;
  check('14ab. la vente reste ouverte', encore === 1, `${encore}`);
}

{
  // 8. La vente apparaît dans le CA dès l'encaissement complet.
  const d = (await q(`SELECT id FROM customer_debts WHERE phone='22997000001'`)).rows[0].id;
  const r = await q(`SELECT pay_customer_debt('${d}', 12000, 'momo', 'solde') AS v`);
  const p = r.rows[0].v;
  check('14ac. solde soldé', Number(p.balance_after) === 0, String(p.balance_after));
  check('14ad. une vente réglée', Number(p.sales_settled) === 1, String(p.sales_settled));

  const prof = (await q(`SELECT * FROM get_product_profitability()`)).rows
    .find((x) => x.name === 'Article crédit');
  check('14ae. CA apparaît après encaissement (20 000)', Number(prof.revenue) === 20000, `obtenu ${prof.revenue}`);
  check('14af. coût apparaît (8 000)', Number(prof.cost_of_goods) === 8000, `obtenu ${prof.cost_of_goods}`);
  check('14ag. marge apparaît (12 000)', Number(prof.gross_profit) === 12000, `obtenu ${prof.gross_profit}`);
  check('14ah. plus de crédit en cours', Number(prof.unsettled_credit) === 0, `obtenu ${prof.unsettled_credit}`);

  // Et l'écran de dettes ne montre plus un client à 0 F.
  const dettes = (await q(`SELECT * FROM get_customer_debts()`)).rows;
  check('14ai. dette soldée : plus de client listé', dettes.length === 0, `${dettes.length}`);
}

{
  // 9. Un second client, pour tester l'isolation entre dettes.
  await credit(1, 'Adjovi', '+229 96 11 22 33');
  const dettes = (await q(`SELECT * FROM get_customer_debts()`)).rows;
  check('14aj. deux dettes distinctes', dettes.length === 1, `${dettes.length}`);
  check('14ak. bonne fiche', dettes[0]?.phone === '22996112233', dettes[0]?.phone);
}

{
  // 10. Un numéro écrit différemment ne crée pas un second débiteur.
  const v = await credit(1, 'Koffi encore', '96 11 22 33');
  check('14al. réécriture du numéro : même dette', !!v?.id);
  const dettes = (await q(`SELECT * FROM get_customer_debts()`)).rows;
  check('14am. toujours un seul débiteur', dettes.length === 1, `${dettes.length}`);
  const nom = dettes[0]?.name;
  check('14an. nom mis à jour', nom === 'Koffi encore', String(nom));
}

{
  // 11. Encaisser sur une fiche sans dette, ou deux fois : refusé.
  const soldée = (await q(
    `SELECT id FROM customer_debts WHERE phone='22997000001'`)).rows[0].id;
  let msg = '';
  try {
    await q(`SELECT pay_customer_debt('${soldée}', 500, 'cash', null)`);
  } catch (e) { msg = e.message; }
  check('14ao. encaissement sur une dette soldée : refusé', /n'a pas de dette en cours/.test(msg), msg || 'accepté !');

  msg = '';
  try {
    await q(`SELECT pay_customer_debt('${soldée}', 0, 'cash', null)`);
  } catch (e) { msg = e.message; }
  check('14ap. versement nul : refusé', /Montant de versement invalide/.test(msg), msg || 'accepté !');

  msg = '';
  try {
    await q(`SELECT pay_customer_debt('${soldée}', 100, 'carte', null)`);
  } catch (e) { msg = e.message; }
  check('14aq. moyen de paiement inconnu : refusé', /Moyen de paiement invalide/.test(msg), msg || 'accepté !');
}

{
  // 12. Un patron ne peut pas encaisser la dette d'un autre tenant.
  const AUTRE6 = '66666666-6666-6666-6666-666666666666';
  await q(`INSERT INTO auth.users (id,email) VALUES ('${AUTRE6}','dette@t.ci') ON CONFLICT DO NOTHING`);
  await q(`INSERT INTO organizations (id,name,slug) VALUES ('${AUTRE6}','Chez lui2','chezlui2') ON CONFLICT DO NOTHING`);
  await q(`INSERT INTO customer_debts (user_id, phone, name)
           VALUES ('${AUTRE6}', '22990000000', 'Dette étrangère') ON CONFLICT DO NOTHING`);
  const detteEtrangere = (await q(
    `SELECT id FROM customer_debts WHERE user_id='${AUTRE6}'`)).rows[0].id;

  let refuse = false;
  try {
    await q(`SELECT pay_customer_debt('${detteEtrangere}', 1000, 'cash', null)`);
  } catch { refuse = true; }
  check('14ar. encaisser la dette d\'autre boutique : refusé', refuse);

  // Et on ne voit pas ses dettes.
  const vus = (await q(`SELECT count(*)::int c FROM get_customer_debts()
                         WHERE phone = '22990000000'`)).rows[0].c;
  check('14as. les dettes d\'autre tenant sont invisibles', Number(vus) === 0, `${vus}`);
}

{
  // 13. Le stock d'un produit cédé à crédit a bien disparu — c'est le point :
  //     la recette attend l'encaissement, la marchandise, elle, est partie.
  //     100 − 2 (14h) − 1 (14j) − 1 (14j) = 96
  const stock = (await q(`SELECT stock_qty FROM products WHERE id='${ART_C}'`)).rows[0].stock_qty;
  check('14at. stock décrémenté par les ventes à crédit', Number(stock) === 96, `stock = ${stock}`);

  // Et la quantité vendue, elle, compte pour toutes les ventes : c'est un fait
  // physique, Prévisions s'en sert pour estimer la rotation.
  const prof = (await q(`SELECT * FROM get_product_profitability()`)).rows
    .find((x) => x.name === 'Article crédit');
  check('14au. unités vendues = 4 (crédit compris)', Number(prof.units_sold) === 4, `obtenu ${prof.units_sold}`);
}

// ═══ 15. Deux boutiques Pro ════════════════════════════════
// Régression d'un bug qui rendait la caisse inutilisable : le compteur de
// facture est par boutique, mais l'index d'unicité portait sur la seule colonne
// invoice_number. Les deux premières boutiques Pro de la plateforme produisaient
// donc toutes deux « FAC-2026-00001 », et la seconde se faisait REFUSER sa
// vente. Un client payant incapable d'encaisser.
console.log('\n▸ Deux boutiques Pro');

{
  const A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  await q(`INSERT INTO auth.users (id,email) VALUES ('${A}','pa@test.ci'),('${B}','pb@test.ci') ON CONFLICT DO NOTHING`);
  await q(`INSERT INTO organizations (id,name,slug,plan) VALUES
             ('${A}','Boutique A','boutique-a','pro'),
             ('${B}','Boutique B','boutique-b','pro') ON CONFLICT DO NOTHING`);
  await q(`INSERT INTO products (id,user_id,name,price_buy,price_sell,stock_qty) VALUES
             ('cccccccc-0000-4000-8000-000000000001','${A}','Article A',4000,10000,50),
             ('dddddddd-0000-4000-8000-000000000001','${B}','Article B',4000,10000,50)
           ON CONFLICT DO NOTHING`);

  const vendre = async (uid, pid) => {
    await q(`SELECT set_config('request.jwt.claim.sub','${uid}',false)`);
    const r = await q(`SELECT create_sale(
      '[{"product_id":"${pid}","quantity":1}]'::jsonb,'cash',null,null) AS v`);
    const b = r.rows[0].v;
    return typeof b === 'string' ? JSON.parse(b) : b;
  };

  const va = await vendre(A, 'cccccccc-0000-4000-8000-000000000001');
  check('15A. la première boutique Pro encaisse', Number(va?.total_amount) === 10000, JSON.stringify(va));

  let vb = null, refus = '';
  try { vb = await vendre(B, 'dddddddd-0000-4000-8000-000000000001'); }
  catch (e) { refus = e.message.split('\n')[0]; }
  check('15B. la DEUXIÈME boutique Pro encaisse aussi', !!vb?.id, refus || 'sa caisse est morte');
  check('15C. sa vente vaut bien 10 000', Number(vb?.total_amount) === 10000, String(vb?.total_amount));

  // Chaque boutique a sa propre séquence. C'est la sémantique attendue d'une
  // numérotation de factures : elle est par contribuable, pas par pays.
  check('15D. les deux|numéros peuvent coincider sans erreur',
    typeof va?.invoice_number === 'string' && typeof vb?.invoice_number === 'string',
    `${va?.invoice_number} / ${vb?.invoice_number}`);

  // Et la séquence avance bien dans la durée pour une même boutique.
  const va2 = await vendre(A, 'cccccccc-0000-4000-8000-000000000001');
  check('15E. la séquence avance dans la même boutique',
    va2?.invoice_number !== va?.invoice_number,
    `${va?.invoice_number} puis ${va2?.invoice_number}`);

  // L'unicité reste réelle là où elle doit l'être : deux ventes d'une même
  // boutique ne peuvent pas porter le même numéro.
  const doublon = (await q(`SELECT count(*)::int c FROM sales
     WHERE user_id='${A}' AND invoice_number = '${va?.invoice_number}'`)).rows[0].c;
  check('15F. unicité maintenue par boutique', Number(doublon) === 1, `${doublon} ligne(s)`);

  await q(`SELECT set_config('request.jwt.claim.sub','${PATRON}',false)`);
}

// ═══ 16. Verrou de plan côté serveur ═══════════════════════
// Le cadenas du menu ne protégeait rien. Les trois fonctions payantes étaient
// appelables en RPC sans qu'aucun plan soit consulté : un client en plan
// gratuit obtenait sa rentabilité, son résultat net et son carnet de dette en
// appelant depuis la console du navigateur. C'est le produit entier qui
// devenait gratuit.
//
// Ces tests vérifient le refus, pas seulement la présence du code.
console.log('\n▸ Verrou de plan');

const FREE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
await q(`INSERT INTO auth.users (id,email) VALUES ('${FREE}','gratuit@test.ci') ON CONFLICT DO NOTHING`);
await q(`INSERT INTO organizations (id,name,slug,plan) VALUES ('${FREE}','Boutique Gratuite','boutique-gratuite','free') ON CONFLICT DO NOTHING`);
await q(`INSERT INTO products (id,user_id,name,price_buy,price_sell,stock_qty)
         VALUES ('f0f0f0f0-0000-4000-8000-00000000000b','${FREE}','Article gratuit',4000,10000,50)
         ON CONFLICT DO NOTHING`);

// Le produit doit exister ET avoir déjà vendu AVANT de vérifier le refus : sinon
// le test passerait pour la mauvaise raison — aucune ligne à renvoyer, donc
// rien à protéger. La vente passe par create_sale(), ce qui prouve au passage
// qu'un client gratuit peut vendre.
await q(`SELECT set_config('request.jwt.claim.sub', '${FREE}', false)`);
await q(`SELECT create_sale(
  '[{"product_id":"f0f0f0f0-0000-4000-8000-00000000000b","quantity":2}]'::jsonb,
  'cash', null, null)`);

{
  const plan = (await q(`SELECT current_org_plan() AS p`)).rows[0].p;
  check('16a. le plan de la boutique est lu en base', plan === 'free', plan);
}

{
  // Le trou : avant migration_plan_gate, cet appel renvoyait les chiffres.
  let msg = '';
  try { await q(`SELECT * FROM get_product_profitability()`); } catch (e) { msg = e.message; }
  check('16b. rentabilité refusée en plan gratuit', /plan starter/i.test(msg), msg || 'RENVOYÉE !');
  check('16c. le message nomme le plan à prendre', /starter/i.test(msg), msg);
}

{
  let msg = '';
  try { await q(`SELECT * FROM get_cash_flow('2000-01-01','2100-01-01')`); } catch (e) { msg = e.message; }
  check('16d. résultat net refusé en plan gratuit', /plan starter/i.test(msg), msg || 'RENVOYÉ !');
}

{
  // Vendre à crédit puis demander le relevé : c'est ce que contient la liste
  // des débiteurs — nom et numéro de ceux qui doivent de l'argent.
  await q(`SELECT record_credit_sale(
             '[{"product_id":"f0f0f0f0-0000-4000-8000-00000000000b","quantity":1}]'::jsonb,
             'Débiteur gratuit','+229 95 00 00 00',null)`);
  let msg = '';
  try { await q(`SELECT * FROM get_customer_debts()`); } catch (e) { msg = e.message; }
  check('16e. carnet de dette refusé en plan gratuit', /plan starter/i.test(msg), msg || 'RENVOYÉ !');
}

{
  // Prévisions : l'API qui ramenait l'historique de ventes, ligne à ligne.
  let msg = '';
  try { await q(`SELECT * FROM get_units_sold_since(30)`); } catch (e) { msg = e.message; }
  check('16f. prévisions refusées en plan gratuit', /plan pro/i.test(msg), msg || 'RENVOYÉES !');
}

{
  // Le contournement classique : passer un nom de fonctionnalité bidon en
  // espérant un accès granted. Une faute de frappe ne doit rien ouvrir.
  let msg = '';
  try { await q(`SELECT require_feature('reports ')`); } catch (e) { msg = e.message; }
  check('16g. fonctionnalité inconnue refusée', /inconnue/i.test(msg), msg || 'ACCEPTÉE !');
}

{
  // Un plan en Starter a les rapports, mais pas les prévisions. C'est le
  // raccourcissement à ne pas faire : si Starter avait eu les deux, personne
  // n'aurait jamais payé Pro.
  await q(`UPDATE organizations SET plan='starter' WHERE id='${FREE}'`);
  let ok = true, msg = '';
  try { await q(`SELECT * FROM get_product_profitability()`); } catch (e) { ok = false; msg = e.message; }
  check('16h. Starter accède à la rentabilité', ok, msg);
  ok = true; msg = '';
  try { await q(`SELECT * FROM get_cash_flow('2000-01-01','2100-01-01')`); } catch (e) { ok = false; msg = e.message; }
  check('16i. Starter accède au résultat net', ok, msg);
  ok = true; msg = '';
  try { await q(`SELECT * FROM get_customer_debts()`); } catch (e) { ok = false; msg = e.message; }
  check('16j. Starter accède au carnet de dette', ok, msg);

  ok = true; msg = '';
  try { await q(`SELECT * FROM get_units_sold_since(30)`); } catch (e) { ok = false; msg = e.message; }
  check('16k. Starter n\'a PAS les prévisions', !ok && /plan pro/i.test(msg), msg || 'accès accordé !');
}

{
  await q(`UPDATE organizations SET plan='pro' WHERE id='${FREE}'`);
  const r = await q(`SELECT * FROM get_units_sold_since(30)`);
  check('16l. Pro accède aux prévisions', Array.isArray(r.rows), '');
}

{
  // La vente, elle, ne doit jamais être bloquée. Un client gratuit doit pouvoir
  // travailler : c'est l'application. Verrouiller la caisse décourage, et un
  // commerce arrêté ne demande jamais d'upgrade.
  const v = await q(`SELECT create_sale(
    '[{"product_id":"f0f0f0f0-0000-4000-8000-00000000000b","quantity":1}]'::jsonb,'cash',null,null) AS v`);
  const b = v.rows[0].v;
  const o = typeof b === 'string' ? JSON.parse(b) : b;
  check('16m. la vente reste possible en plan gratuit', Number(o?.total_amount) === 10000, JSON.stringify(o));

  // Et le stock baisse : c'est une vraie vente, pas un dry-run.
  // 50 − 2 (fixture) − 1 (ici) − 1 (16e, dette créée pour 16e) = 46
  const st = (await q(`SELECT stock_qty FROM products WHERE id='f0f0f0f0-0000-4000-8000-00000000000b'`)).rows[0].stock_qty;
  check('16n. le stock décrémente en plan gratuit', Number(st) === 46, `stock = ${st}`);
}

{
  // Une boutique qui n'existe pas ou n'a pas de plan est traitée comme gratuit.
  // En cas de doute, le coût doit tomber sur le vendeur, jamais sur le client.
  await q(`SELECT set_config('request.jwt.claim.sub',
           'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', false)`);
  const plan = (await q(`SELECT current_org_plan() AS p`)).rows[0].p;
  check('16o. boutique inconnue traitée comme gratuit', plan === 'free', plan);
}

// Retour au patron Pro pour la suite de la suite.
await q(`SELECT set_config('request.jwt.claim.sub', '${PATRON}', false)`);

// ═══ 17. Acompte ══════════════════════════════════════════
// « Laisse-moi 50 000 sur 130 000 » est le geste le plus courant d'une boutique
// de quartier. Avant, le choix « Crédit » signifiait 100 % à découvert : ou le
// commerçant encaissait tout et inventait un montant, ou il laissait une dette
// trop grosse. Aucune des deux ne décrivait la réalité.
//
// La règle : amount_received porte ce qui est réellement rentré, et le chiffre
// d'affaires vaut SUM(amount_received). La caisse et le chiffre d'affaires ne
// peuvent donc pas diverger.
console.log('\n▸ Acompte');

const ART_A = 'e0e0e0e0-0000-4000-8000-00000000000a';
await q(`INSERT INTO products (id, user_id, name, price_buy, price_sell, stock_qty)
         VALUES ('${ART_A}', '${PATRON}', 'Article acompte', 4000, 10000, 200)`);

const acompter = async (qty, tel, avance) => {
  const r = await q(`SELECT record_credit_sale(
    '[{"product_id":"${ART_A}","quantity":${qty}}]'::jsonb, 'Avec acompte', '${tel}', null, ${avance}) AS v`);
  const b = r.rows[0].v;
  return typeof b === 'string' ? JSON.parse(b) : b;
};

{
  const v = await acompter(13, '+229 94 00 00 01', 50000);
  check('17a. vente avec acompte enregistrée', !!v?.id);
  check('17b. prix = 130 000', Number(v.total_amount) === 130000, String(v.total_amount));
  check('17c. acompte renvoyé (50 000)', Number(v.amount_advance) === 50000, String(v.amount_advance));
  check('17d. reste dû renvoyé (80 000)', Number(v.amount_due) === 80000, String(v.amount_due));

  const s = (await q(`SELECT amount_received, settled, payment_method
                         FROM sales WHERE id='${v.id}'`)).rows[0];
  check('17e. encaissé = 50 000', Number(s.amount_received) === 50000, String(s.amount_received));
  check('17f. vente non soldée', s.settled === false);

  // Le stock part, même avec acompte : la marchandise est partie.
  const st = (await q(`SELECT stock_qty FROM products WHERE id='${ART_A}'`)).rows[0].stock_qty;
  check('17g. le stock part quand même', Number(st) === 187, `stock = ${st}`);
}

{
  // LE POINT CENTRAL : la caisse et le chiffre d'affaires concordent.
  const prof = (await q(`SELECT * FROM get_product_profitability()`)).rows
    .find((x) => x.name === 'Article acompte');
  check('17h. CA = 50 000 (l\'acompte seulement)', Number(prof.revenue) === 50000, `obtenu ${prof.revenue}`);
  check('17i. coût = 20 000 au prorata (5 000 x 5/13)', Math.abs(Number(prof.cost_of_goods) - 20000) < 1,
    `obtenu ${prof.cost_of_goods}`);
  check('17j. marge = 30 000 au prorata', Math.abs(Number(prof.gross_profit) - 30000) < 1,
    `obtenu ${prof.gross_profit}`);

  // Le taux de marge ne doit PAS être dégradé par l'encaissement partiel : le
  // ratio s'annule, donc c'est le vrai taux du produit.
  check('17k. taux de marge intact (60 %)', Number(prof.margin_pct) === 60, `obtenu ${prof.margin_pct}`);

  // Les unités vendues restent un fait physique : 13 sont sorties.
  check('17l. 13 unités vendues', Number(prof.units_sold) === 13, `obtenu ${prof.units_sold}`);

  // Ce qui reste dû est 80 000, pas 130 000.
  check('17m. crédit restant = 80 000', Math.abs(Number(prof.unsettled_credit) - 80000) < 1,
    `obtenu ${prof.unsettled_credit}`);
}

{
  // Le cash-flow du jour vaut l'acompte, pas le prix.
  const jour = (await q(
    `SELECT (created_at AT TIME ZONE 'Africa/Porto-Novo')::date::text AS d
       FROM sales WHERE client_phone = '22994000001' LIMIT 1`)).rows[0].d;
  const ca = Number((await q(`SELECT * FROM get_cash_flow('${jour}','${jour}')`)).rows[0]?.revenue ?? 0);
  const attendu = Number((await q(
    `SELECT COALESCE(SUM(amount_received),0) AS c FROM sales
      WHERE (created_at AT TIME ZONE 'Africa/Porto-Novo')::date::text = '${jour}'`)).rows[0].c);
  check('17n. résultat net = encaissements du jour', Math.abs(ca - attendu) < 1,
    `cash-flow ${ca} vs encaissé ${attendu}`);
}

{
  // La dette affichée au commerçant est bien de 80 000.
  const dettes = (await q(`SELECT * FROM get_customer_debts()
                            WHERE phone = '22994000001'`)).rows;
  check('17o. dette = 80 000', Number(dettes[0].total_due) === 80000, `obtenu ${dettes[0].total_due}`);
  check('17p. « déjà versé » = 50 000', Number(dettes[0].total_paid) === 50000,
    `obtenu ${dettes[0].total_paid}`);
  check('17q. l\'acompte est dans l\'historique des versements', Number(dettes[0].payments_count) === 1,
    `${dettes[0].payments_count}`);
}

{
  // Un règlement de 30 000 sur la dette de 80 000 : reste 50 000.
  const d = (await q(`SELECT id FROM customer_debts WHERE phone='22994000001'`)).rows[0].id;
  const r = await q(`SELECT pay_customer_debt('${d}', 30000, 'cash', null) AS v`);
  const p = r.rows[0].v;
  check('17r. solde avant = 80 000', Number(p.balance_before) === 80000, String(p.balance_before));
  check('17s. solde après = 50 000', Number(p.balance_after) === 50000, String(p.balance_after));
  check('17t. aucune vente soldée (règlement partiel)', Number(p.sales_settled) === 0,
    String(p.sales_settled));

  // Et la dette est exactement la somme de ce qui manque, sans répartition
  // reconstituée : 130 000 − 80 000 encaissés.
  const s = (await q(`SELECT amount_received FROM sales WHERE client_phone='22994000001'`)).rows[0];
  check('17u. encaissé cumulé = 80 000', Number(s.amount_received) === 80000, String(s.amount_received));
}

{
  // Le dernier versement solde : 130 000 = 50 000 + 30 000 + 50 000.
  const d = (await q(`SELECT id FROM customer_debts WHERE phone='22994000001'`)).rows[0].id;
  const r = await q(`SELECT pay_customer_debt('${d}', 50000, 'momo', 'solde') AS v`);
  const p = r.rows[0].v;
  check('17v. dette soldée', Number(p.balance_after) === 0, String(p.balance_after));
  check('17w. une vente soldée', Number(p.sales_settled) === 1, String(p.sales_settled));

  const s = (await q(`SELECT amount_received, total_amount, settled FROM sales
                       WHERE client_phone='22994000001'`)).rows[0];
  check('17x. encaissé = prix total', Number(s.amount_received) === 130000, String(s.amount_received));
  check('17y. marquée soldée', s.settled === true);

  // Le CA complet n'apparaît qu'ici, une fois l'argent rentré.
  const prof = (await q(`SELECT * FROM get_product_profitability()`)).rows
    .find((x) => x.name === 'Article acompte');
  check('17z. CA complet après encaissement', Number(prof.revenue) === 130000, `obtenu ${prof.revenue}`);
  check('17aa. plus de crédit en cours', Number(prof.unsettled_credit) === 0,
    `obtenu ${prof.unsettled_credit}`);

  // Et la fiche disparaît de l'écran Dettes.
  const dettes = (await q(`SELECT * FROM get_customer_debts() WHERE phone='22994000001'`)).rows;
  check('17ab. dette soldée : plus de débiteur listé', dettes.length === 0, `${dettes.length}`);
}

{
  // Un acompte supérieur au prix, ou négatif : refusé. Un trop-perçu est un
  // autre geste, il se fait sur l'écran Dettes.
  let msg = '';
  try { await acompter(1, '+229 94 00 00 09', 999999); } catch (e) { msg = e.message; }
  check('17ac. acompte supérieur au prix : refusé', /dépasse le prix/.test(msg), msg || 'accepté !');

  msg = '';
  try { await acompter(1, '+229 94 00 00 09', -500); } catch (e) { msg = e.message; }
  check('17ad. acompte négatif : refusé', /n\\'a pas être négative/.test(msg) || /negative|négative/.test(msg),
    msg || 'accepté !');
}

{
  // Un acompte de la totalité : c'est une vente cash qui a traîné. Elle doit
  // être marquée soldée, sinon le client apparaît dans l'écran Dettes avec 0 F
  // dû — un client fantôme.
  const v = await acompter(1, '+229 94 00 00 10', 10000);
  const s = (await q(`SELECT settled, amount_received FROM sales WHERE id='${v.id}'`)).rows[0];
  check('17ae. acompte intégral = vente soldée', s.settled === true, `settled = ${s.settled}`);
  check('17af. encaissé = 10 000', Number(s.amount_received) === 10000, String(s.amount_received));

  const dettes = (await q(`SELECT * FROM get_customer_debts() WHERE phone='22994000010'`)).rows;
  check('17ag. pas de client listé pour une dette nulle', dettes.length === 0, `${dettes.length}`);
}

{
  // Répartition FIFO avec acompte : la dette la plus ancienne est soldée
  // d'abord, même si une vente plus récente a reçu un acompte.
  await acompter(1, '+229 94 00 00 20', 0);   // 10 000 dus, plus ancien
  await acompter(1, '+229 94 00 00 20', 0);   // 10 000 dus, plus récent
  const d = (await q(`SELECT id FROM customer_debts WHERE phone='22994000020'`)).rows[0].id;
  const r = await q(`SELECT pay_customer_debt('${d}', 15000, 'cash', null) AS v`);
  const p = r.rows[0].v;
  check('17ah. FIFO : la plus ancienne vente est soldée', Number(p.sales_settled) === 1,
    String(p.sales_settled));
  check('17ai. reste dû = 5 000', Number(p.balance_after) === 5000, String(p.balance_after));

  const ventes = (await q(`SELECT total_amount, amount_received, settled FROM sales
                            WHERE client_phone='22994000020' ORDER BY created_at ASC`)).rows;
  check('17aj. 1re vente : encaissée et soldée',
    Number(ventes[0].amount_received) === 10000 && ventes[0].settled === true,
    `${ventes[0].amount_received} / ${ventes[0].settled}`);
  check('17ak. 2e vente : 5 000 encaissés, encore ouverte',
    Number(ventes[1].amount_received) === 5000 && ventes[1].settled === false,
    `${ventes[1].amount_received} / ${ventes[1].settled}`);
}

{
  // Le trop-perçu ne devient pas du chiffre d'affaires. C'est de l'argent
  // avancé par le client, pas une vente.
  const d = (await q(`SELECT id FROM customer_debts WHERE phone='22994000020'`)).rows[0].id;
  const r = await q(`SELECT pay_customer_debt('${d}', 20000, 'cash', null) AS v`);
  const p = r.rows[0].v;
  check('17al. trop-perçu : dette soldée', Number(p.balance_after) === 0, String(p.balance_after));
  check('17am. trop-perçu : montant enregistré en totalité', Number(p.amount_paid) === 20000,
    String(p.amount_paid));

  const ventes = (await q(`SELECT SUM(amount_received) AS s FROM sales
                            WHERE client_phone='22994000020'`)).rows[0];
  check('17an. rien au-delà du prix réellement vendu', Number(ventes.s) === 20000,
    `encaissé ${ventes.s}, vendu 20 000`);
}

{
  // Une vente espèces porte bien son prix : c'est ce qui garantit que la caisse
  // et le chiffre d'affaires concordent pour l'essentiel des ventes.
  const r = await q(`SELECT create_sale(
    '[{"product_id":"${ART_A}","quantity":2}]'::jsonb,'cash',null,null) AS v`);
  const b = r.rows[0].v;
  const o = typeof b === 'string' ? JSON.parse(b) : b;
  const s = (await q(`SELECT amount_received, total_amount FROM sales WHERE id='${o.id}'`)).rows[0];
  check('17ao. vente espèces : encaissé = prix', Number(s.amount_received) === Number(s.total_amount),
    `${s.amount_received} / ${s.total_amount}`);
}

{
  // La contrainte d'intégrité : on ne peut pas encaisser plus que le prix.
  const v = await acompter(1, '+229 94 00 00 30', 0);
  let refuse = false;
  try {
    await q(`UPDATE sales SET amount_received = total_amount + 1 WHERE id = '${v.id}'`);
  } catch { refuse = true; }
  check('17ap. encaisser plus que le prix : refusé par la contrainte', refuse);
}
// ═══ 18. Programme bêta ═══════════════════════════════════
// Dix comptes en accès complet, pour tester en conditions réelles. Le mécanisme
// est volontairement un budget de places et non un code : il n'y a rien à
// distribuer, donc rien à trouver, et le onzième compte s'inscrit normalement en
// gratuit.
console.log('\n▸ Programme bêta');

{
  // Le harnais a fermé le programme. On le rouvre avec un budget connu.
  await e(`UPDATE beta_program
              SET open = true, slots_total = 3, slots_used = 0, note = 'test'
            WHERE id = 1`);

  const st0 = (await q(`SELECT * FROM beta_status()`)).rows[0];
  check('18a. programme ouvert, 3 places, 0 prise',
    st0.open === true && st0.slots_total === 3 && st0.slots_used === 0,
    JSON.stringify(st0));
  check('18b. places restantes = 3', Number(st0.remaining) === 3, String(st0.remaining));

  const inscrire = async (n) => {
    // 11 zéros + le chiffre : le dernier groupe d'un UUID fait 12 caractères.
    // Un de moins et PostgreSQL refuse l'identifiant — pour une raison qui n'a
    // rien à voir avec ce qu'on teste.
    const uid = `f1f1f1f1-0000-4000-8000-00000000000${n}`;
    await q(`INSERT INTO auth.users (id, email) VALUES ('${uid}', 'beta${n}@test.ci')`);
    await q(`INSERT INTO organizations (id, name, slug)
             VALUES ('${uid}', 'Boutique Beta ${n}', 'beta-${n}')`);
    // Un article, pour prouver que le compte hors plafond peut vendre. Une boutique
    // sans produit ne prouve rien sur la caisse.
    await q(`INSERT INTO products (id, user_id, name, price_buy, price_sell, stock_qty)
             VALUES ('a1a1a1a1-0000-4000-8000-00000000000${n}', '${uid}',
                     'Article beta', 4000, 10000, 20)`);
    const o = (await q(`SELECT plan FROM organizations WHERE id='${uid}'`)).rows[0];
    return { uid, plan: o.plan };
  };

  // 1. Le point central : une inscription ordinaire devient Pro, sans que
  //    l'application ait eu à le demander ni à le savoir.
  const b1 = await inscrire(1);
  check('18c. le 1er compte bêta passe en Pro', b1.plan === 'pro', b1.plan);

  const acc1 = (await q(`SELECT * FROM beta_access WHERE user_id='${b1.uid}'`)).rows[0];
  check('18d. il est enregistré dans beta_access', !!acc1, '(absent)');
  check('18e. son email est récupéré depuis auth.users', acc1?.email === 'beta1@test.ci',
    String(acc1?.email));

  const b2 = await inscrire(2);
  const b3 = await inscrire(3);
  check('18f. les 2e et 3e comptes passent en Pro', b2.plan === 'pro' && b3.plan === 'pro',
    `${b2.plan} / ${b3.plan}`);

  const st1 = (await q(`SELECT * FROM beta_status()`)).rows[0];
  check('18g. 3 places sur 3 consommées',
    st1.slots_used === 3 && st1.remaining === 0,
    `utilisées ${st1.slots_used}, restantes ${st1.remaining}`);

  // 2. LE PLAFOND. Le 4e compte s'inscrit normalement, en gratuit. C'est la
  //    propriété qui rend le programme sûr : sans elle, le nombre « dix » ne
  //    serait qu'une intention.
  const b4 = await inscrire(4);
  check('18h. le 4e compte est en gratuit (plafond atteint)', b4.plan === 'free', b4.plan);
  const pasAcc = (await q(
    `SELECT count(*)::int c FROM beta_access WHERE user_id='${b4.uid}'`)).rows[0].c;
  check('18i. le 4e n\'est pas enregistré comme bêta', pasAcc === 0, `${pasAcc}`);

  // Le refus ne doit rien casser : la boutique existe et la caisse fonctionne.
  // Vérifié ici parce que le cas du compte juste après le plafond est le plus
  // fréquent — dix potes, puis un onzième qui tombe sur un écran verrouillé.
  await q(`SELECT set_config('request.jwt.claim.sub', '${b4.uid}', false)`);
  const v = await q(`SELECT create_sale(
    '[{"product_id":"a1a1a1a1-0000-4000-8000-000000000004","quantity":1}]'::jsonb,
    'cash', null, null) AS v`);
  check('18j. le compte hors plafond peut quand même vendre', !!v.rows[0].v,
    JSON.stringify(v.rows[0]).slice(0, 110));
  await q(`SELECT set_config('request.jwt.claim.sub', '${PATRON}', false)`);
}

{
  // 3. Fermer le programme : plus aucune attribution, même si le budget
  //    permettrait encore des places. C'est le geste qui rend le programme
  //    vraiment fermé.
  await e(`UPDATE beta_program SET open = false WHERE id = 1`);
  const uid = `f1f1f1f1-0000-4000-8000-000000000009`;
  await q(`INSERT INTO auth.users (id, email) VALUES ('${uid}', 'beta9@test.ci')`);
  await q(`INSERT INTO organizations (id, name, slug)
           VALUES ('${uid}', 'Boutique Fermee', 'beta-fermee')`);
  const o = (await q(`SELECT plan FROM organizations WHERE id='${uid}'`)).rows[0];
  check('18k. programme fermé : inscription en gratuit', o.plan === 'free', o.plan);
}

{
  // 4. Rouvrir avec un budget plus large, pour une deuxième vague.
  await e(`UPDATE beta_program SET open = true, slots_total = 10, slots_used = 0 WHERE id = 1`);
  const st = (await q(`SELECT * FROM beta_status()`)).rows[0];
  check('18l. rouvrir avec 10 places', st.open === true && st.remaining === 10,
    JSON.stringify(st));
}

{
  // 5. Révoquer : tout le monde repasse en gratuit, et les retours sont
  //    conservés. C'est le geste de fermeture réelle.
  const msg = (await q(`SELECT revoke_all_beta() AS m`)).rows[0].m;
  check('18m. révocation : message rendu', typeof msg === 'string' && msg.includes('gratuit'), String(msg));

  const restants = (await q(
    `SELECT count(*)::int c FROM organizations o
       JOIN beta_access b ON b.user_id = o.id
      WHERE o.plan = 'pro'`)).rows[0].c;
  check('18n. plus aucune boutique bêta en Pro', restants === 0, `${restants}`);

  // Les commentaires de retour survivent à la révocation : c'est tout l'intérêt
  // de la table, sinon on jetterait le matériau du debriefing avec l'accès.
  // Trois fiches : les trois comptes qui ont eu une place. Celui créé après le
  // plafond, et celui créé programme fermé, n'en ont pas — c'est le but.
  const notes = (await q(`SELECT count(*)::int c FROM beta_access`)).rows[0].c;
  check('18o. les fiches bêta sont conservées', notes === 3, `${notes}`);

  const st = (await q(`SELECT * FROM beta_status()`)).rows[0];
  check('18p. compteur remis à zéro, programme fermé',
    st.slots_used === 0 && st.open === false, JSON.stringify(st));
}

{
  // 6. Un testeur ne doit pas pouvoir élargir son propre accès. Les tables sont
  //    sans policy et en FORCE ROW LEVEL SECURITY ; seul le trigger, en SECURITY
  //    DEFINER, écrit dedans.
  const policies = (await q(
    `SELECT count(*)::int c FROM pg_policies
      WHERE tablename IN ('beta_program', 'beta_access')`)).rows[0].c;
  check('18q. aucune policy RLS sur les tables bêta', policies === 0, `${policies} policy(s)`);

  const forcee = (await q(
    `SELECT relname, relforcerowsecurity FROM pg_class
      WHERE relname IN ('beta_program', 'beta_access') ORDER BY relname`)).rows;
  check('18r. RLS forcé sur les deux tables',
    forcee.length === 2 && forcee.every((x) => x.relforcerowsecurity === true),
    JSON.stringify(forcee));

  // Un client authentifié ne doit pas pouvoir élargir son propre accès. On vérifie
  // sous le rôle réel, sinon la RLS serait contournée par superuser.
  //
  // ⚠ Un UPDATE refusé par la RLS ne lève PAS d'erreur : la ligne est simplement
  //   filtrée, donc « UPDATE ... WHERE id = 1 » ne modifie aucune ligne et
  //   renvoie un compte de 0. Attendre une exception ferait échouer le test sur
  //   la mauvaise raison et donnerait une fausse impression de sécurité : c'est
  //   le compte de lignes qui prouve le blocage, pas l'absence d'erreur.
  await e(`GRANT EXECUTE ON FUNCTION beta_status() TO authenticated`);
  await e('SET ROLE authenticated');
  let vu = null;
  try {
    vu = (await q(`SELECT * FROM beta_status()`)).rows[0];
  } catch (err) { vu = { erreur: err.message }; }

  let modifiees = -1;
  try {
    const r = await q(`UPDATE beta_program SET slots_total = 9999 WHERE id = 1`);
    modifiees = r.affectedRows ?? r.rows?.length ?? -1;
  } catch { modifiees = -2; }
  await e('RESET ROLE');

  check('18s. un client peut lire l\'état du programme (utile, inoffensif)',
    !!vu && !('erreur' in (vu ?? {})), JSON.stringify(vu)?.slice(0, 80));
  check('18t. un client NE PEUT PAS ajouter de places (RLS : 0 ligne touchée)',
    modifiees === 0, `lignes modifiées = ${modifiees}`);

  // Et la valeur n'a pas bougé, une fois revenu au rôle normal.
  const cap = (await q(`SELECT slots_total FROM beta_program WHERE id = 1`)).rows[0].slots_total;
  check('18u. le budget est intact', Number(cap) === 10, `${cap}`);
}

// Le harnais referme derrière lui : la section bêta est la seule qui ouvre le
// programme, et un test qui suivrait ne doit pas hériter de l'état.
await e(`UPDATE beta_program SET open = false WHERE id = 1`);

// ─── 19. Durcissement sécurité ──────────────────────────────
//
// Le harnais a fait GRANT ALL sur toutes les tables (section 4) pour pouvoir
// tester la RLS. C'est exactement l'état d'une base Supabase vierge : les
// privilèges par défaut sont posés à la création des tables, et
// migration_security.sql ne les restreint qu'ensuite. On rejoue donc la
// migration dans cet état — c'est l'ordre réel du déploiement, et c'est le seul
// moyen d'y tester les privilèges : une assertion posée avant le GRANT ALL
// passerait pour la mauvaise raison.
console.log('\n▸ Durcissement sécurité');

const readSql = (f) =>
  fs.readFileSync(path.join(SQL_DIR, f), 'utf8').replace(/CREATE EXTENSION[^;]*;/gi, '');

try {
  await db.exec(readSql('migration_security.sql'));
  console.log('  ✓ 19a. migration_security.sql se rejoue après les grants par défaut');
} catch (err) {
  failed++;
  console.log(`  ✗ 19a. rejouage — ${err.message}`);
}

const SEC_PATRON = '66666666-6666-4666-8666-666666666666';
const SEC_AUTRE = '77777777-7777-4777-8777-777777777777';
const SEC_SANS_ORG = '42424242-4242-4242-4242-424242424242';

await q(`INSERT INTO auth.users (id, email)
  VALUES ('${SEC_PATRON}', 'sec1@t.ci'), ('${SEC_AUTRE}', 'sec2@t.ci'),
         ('${SEC_SANS_ORG}', 'sec3@t.ci')
  ON CONFLICT DO NOTHING`);
await q(`INSERT INTO organizations (id, name, slug)
  VALUES ('${SEC_PATRON}', 'Securite', 'securite-19') ON CONFLICT DO NOTHING`);
// Le programme bêta est refermé ci-dessus : la boutique naît en gratuit.
const planInitial = (await q(`SELECT plan FROM organizations WHERE id='${SEC_PATRON}'`)).rows[0].plan;
check('19b. la boutique de test démarre en gratuit', planInitial === 'free', planInitial);

// 1. rate_limits : la faille la plus simple du projet.
//    D'abord prouver que la table n'est PAS vide : sans ça, « invisible » et
//    « aucun compteur » se confondraient et le test passerait pour la bonne
//    raison par accident.
await e(`INSERT INTO rate_limits (key, count, reset_at)
         VALUES ('securite:19', 1, now() + interval '1 hour')
         ON CONFLICT (key) DO NOTHING`);
const nbCompteurs = (await q(`SELECT count(*)::int c FROM rate_limits`)).rows[0].c;
check('19c. la table rate_limits contient des compteurs', nbCompteurs >= 1, `${nbCompteurs}`);
await canRead('19d. rate_limits est invisible pour un client',
  `SELECT count(*) FROM rate_limits`, false, SEC_PATRON);
await canWrite('19e. rate_limits ne peut pas être vidée depuis le navigateur',
  `DELETE FROM rate_limits`, false, SEC_PATRON);

// 2. organizations.plan : la faille qui rendait Stripe facultatif.
await canWrite('19f. un client ne peut pas passer sa boutique en pro',
  `UPDATE organizations SET plan = 'pro' WHERE id = '${SEC_PATRON}'`, false, SEC_PATRON);
const planApres = (await q(`SELECT plan FROM organizations WHERE id='${SEC_PATRON}'`)).rows[0].plan;
check('19g. le plan est resté gratuit', planApres === 'free', planApres);

// Le verrou ne doit porter que sur plan : le reste de la fiche reste à jour.
await canWrite('19h. le patron peut toujours renommer sa boutique',
  `UPDATE organizations SET name = 'Securite 19' WHERE id = '${SEC_PATRON}'`, true, SEC_PATRON);
await canWrite('19i. mais pas toucher au numéro de facture',
  `UPDATE organizations SET invoice_counter = 999 WHERE id = '${SEC_PATRON}'`, false, SEC_PATRON);
await canWrite('19j. un client ne peut pas CITER la colonne plan',
  `INSERT INTO organizations (id, name, slug, plan)
     VALUES ('${SEC_AUTRE}', 'Pirate', 'pirate-19', 'pro')`, false, SEC_AUTRE);
await canWrite('19k. il peut en revanche créer sa boutique en gratuit',
  `INSERT INTO organizations (id, name, slug)
     VALUES ('${SEC_AUTRE}', 'Sa boutique', 'sa-boutique-19')`, true, SEC_AUTRE);

// Le service role, lui, doit continuer : c'est le webhook Stripe.
await e(`GRANT USAGE ON SCHEMA public TO service_role;
         GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
         GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;`);
await q(`SELECT set_config('request.jwt.claim.sub', '${SEC_PATRON}', false)`);
await e('SET ROLE service_role');
let svcAffected = -1;
let svcErr = '';
try {
  const r = await q(`UPDATE organizations SET plan = 'starter' WHERE id = '${SEC_PATRON}'`);
  svcAffected = r.affectedRows ?? 0;
} catch (ex) { svcErr = ex.message; }
await e('RESET ROLE');
check('19l. le service role (webhook Stripe) peut toujours changer le plan',
  svcAffected > 0, svcErr || `${svcAffected} ligne(s)`);
await q(`UPDATE organizations SET plan = 'free' WHERE id = '${SEC_PATRON}'`);

// 3. subscriptions : l'upsert du webhook, qui échouait en silence.
const ux = (await q(
  `SELECT count(*)::int c FROM pg_indexes
    WHERE tablename = 'subscriptions' AND indexname = 'ux_subscriptions_org'`
)).rows[0].c;
check('19m. index unique sur subscriptions(org_id)', ux === 1, `${ux}`);

let upsertMsg = '';
try {
  await q(`INSERT INTO subscriptions (org_id, plan, status)
             VALUES ('${SEC_PATRON}', 'free', 'active')
           ON CONFLICT (org_id) DO UPDATE
             SET plan = 'pro', status = 'active', updated_at = now()`);
} catch (ex) { upsertMsg = ex.message; }
check('19n. l\'upsert du webhook (ON CONFLICT org_id) fonctionne enfin',
  upsertMsg === '', upsertMsg || 'refusé');
const nbAb = (await q(
  `SELECT count(*)::int c FROM subscriptions WHERE org_id = '${SEC_PATRON}'`
)).rows[0].c;
check('19o. une seule ligne par boutique', nbAb === 1, `${nbAb}`);

// 4. business_members : le rattachement arbitraire.
await canWrite('19p. un client ne peut pas rattacher un compte à son équipe',
  `INSERT INTO business_members (owner_id, member_id, member_name)
     VALUES ('${SEC_PATRON}', '${SEC_SANS_ORG}', 'Forcé')`, false, SEC_PATRON);

// Isolé du RLS, en superuser : ici seul le déclencheur peut refuser.
let gardeMsg = '';
try {
  await q(`INSERT INTO business_members (owner_id, member_id, member_name)
             VALUES ('${SEC_PATRON}', '${SEC_AUTRE}', 'Patron détourne')`);
} catch (ex) { gardeMsg = ex.message; }
check('19q. rattacher un compte qui possède déjà sa boutique est refusé',
  /possède déjà sa propre boutique/.test(gardeMsg), gardeMsg || 'insertion acceptée');

// Et la garde ne doit pas tout bloquer : un compte sans boutique reste
// rattachable, sinon plus aucune invitation ne passerait.
let normalMsg = '';
try {
  await q(`INSERT INTO business_members (owner_id, member_id, member_name)
             VALUES ('${SEC_PATRON}', '${SEC_SANS_ORG}', 'Caissière')`);
} catch (ex) { normalMsg = ex.message; }
check('19r. un compte sans boutique est toujours rattachable',
  normalMsg === '', normalMsg);

// Le SELECT du patron survit à la suppression de la policy FOR ALL : sans lui,
// l'équipe devient illisible pour celui qui la dirige.
await canRead('19s. le patron lit toujours son équipe',
  `SELECT count(*) FROM business_members WHERE owner_id = '${SEC_PATRON}'`, true, SEC_PATRON);
await canRead('19t. mais pas celle d\'un autre',
  `SELECT count(*) FROM business_members WHERE owner_id = '${PATRON}'`, false, SEC_AUTRE);

// 5. sales / sale_items / stock_logs : créées SANS clause FOR, donc pour les
//    quatre commandes. Leur prédicat `user_id = get_business_owner_id()`
//    renvoie le PATRON pour un employé — celui-ci passait donc dans le USING
//    comme dans le WITH CHECK, et pouvait UPDATE/DELETE les ventes de la
//    boutique depuis le navigateur, avec la seule clé anon.
// On cherche explicitement une vente POURVUE de lignes : un insert direct
// dans `sales` (fixtures de certains tests) n'en crée pas.
const lignePatron = (await q(
  `SELECT si.id FROM sale_items si
     JOIN sales s ON s.id = si.sale_id
    WHERE s.user_id = '${PATRON}' LIMIT 1`)).rows[0]?.id;
const ventePatron = lignePatron
  ? (await q(`SELECT sale_id FROM sale_items WHERE id = '${lignePatron}'`)).rows[0]?.sale_id
  : undefined;
const journalPatron = (await q(
  `SELECT id FROM stock_logs WHERE user_id = '${PATRON}' ORDER BY created_at LIMIT 1`)).rows[0]?.id;
const estMembre = (await q(
  `SELECT count(*)::int c FROM business_members
    WHERE owner_id = '${PATRON}' AND member_id = '${EMPLOYE}'`)).rows[0].c;

check('19u. fixtures : vente, ligne et mouvement de stock du patron',
  !!ventePatron && !!lignePatron && !!journalPatron,
  `vente=${!!ventePatron} ligne=${!!lignePatron} journal=${!!journalPatron}`);
check('19v. fixture : l\'employé est bien dans l\'équipe du patron',
  estMembre >= 1, `${estMembre}`);

if (ventePatron && lignePatron && journalPatron && estMembre >= 1) {
  await canWrite('19w. un employé ne peut pas modifier une vente',
    `UPDATE sales SET total_amount = 1 WHERE id = '${ventePatron}'`, false, EMPLOYE);
  await canWrite('19x. ni la supprimer',
    `DELETE FROM sales WHERE id = '${ventePatron}'`, false, EMPLOYE);
  await canRead('19y. mais il lit toujours les ventes',
    `SELECT count(*) FROM sales WHERE id = '${ventePatron}'`, true, EMPLOYE);
  await canRead('19z. et leurs lignes',
    `SELECT count(*) FROM sale_items WHERE id = '${lignePatron}'`, true, EMPLOYE);
  await canWrite('19aa. il ne peut pas modifier une ligne de vente',
    `UPDATE sale_items SET quantity = 99 WHERE id = '${lignePatron}'`, false, EMPLOYE);
  await canWrite('19bb. ni le journal des stocks',
    `UPDATE stock_logs SET quantity_change = 0 WHERE id = '${journalPatron}'`, false, EMPLOYE);
  await canWrite('19cc. ni le supprimer — le journal est inaltérable',
    `DELETE FROM stock_logs WHERE id = '${journalPatron}'`, false, EMPLOYE);
  await canWrite('19dd. ni y insérer un mouvement (can_manage_products() faux)',
    `INSERT INTO stock_logs (user_id, product_id, product_name, movement_type, quantity_change, stock_before, stock_after)
       VALUES ('${PATRON}', '${P1}', 'Mouvement indu', 'adjustment', 99, 0, 99)`, false, EMPLOYE);

  // Le patron, lui, continue : c'est par ce INSERT que passent le
  // réapprovisionnement et l'inventaire.
  await canWrite('19ee. le patron insère bien un mouvement de stock',
    `INSERT INTO stock_logs (user_id, product_id, product_name, movement_type, quantity_change, stock_before, stock_after)
       VALUES ('${PATRON}', '${P1}', 'Réappro test', 'restock', 5, 10, 15)`, true, PATRON);
}

// ─── 20. Suppression de compte ────────────────────────────────
// Deux pannes de bout en bout relevées dans les logs Auth, qui nommaient les
// causes au mot près :
//   • « converting NULL to string is unsupported » → l'API refusait de lire
//     tout compte dont les colonnes jeton étaient NULL (créé par insertion
//     manuelle) : liste, fiche et suppression devenaient impossibles ;
//   • « delete on table "products" violates foreign key constraint
//     "sale_items_product_id_fkey" » → la cascade partait de products avant
//     sales, donc avant que sale_items ait disparu.
console.log('\n▸ Suppression de compte');

const SUP_JETABLE = '88888888-8888-4888-8888-888888888821';
await q(`INSERT INTO auth.users (id, email, confirmation_token, recovery_token,
         email_change_token_new, email_change)
         VALUES ('${SUP_JETABLE}', 'jetable20@t.ci', NULL, NULL, NULL, NULL)
         ON CONFLICT DO NOTHING`);
const nullAvant = (await q(`SELECT count(*)::int c FROM auth.users
  WHERE id = '${SUP_JETABLE}' AND confirmation_token IS NULL AND recovery_token IS NULL
    AND email_change_token_new IS NULL AND email_change IS NULL`)).rows[0].c;
check('20a. le compte jetable part avec des jetons NULL', nullAvant === 1, `${nullAvant}`);

try {
  await db.exec(readSql('migration_security.sql'));
  const nullApres = (await q(`SELECT count(*)::int c FROM auth.users
    WHERE confirmation_token IS NULL OR recovery_token IS NULL
       OR email_change_token_new IS NULL OR email_change IS NULL`)).rows[0].c;
  check('20b. la section 6 remplit les jetons NULL de auth.users', nullApres === 0, `${nullApres} reste(nt)`);
} catch (err) {
  failures++;
  console.log(`  ✗ 20b. rejouage — ${err.message}`);
}

for (const [libelle, table, nom] of [
  ['20c. sale_items → products vérifie à la fin de la transaction', 'sale_items', 'sale_items_product_id_fkey'],
  ['20d. stock_logs → products vérifie à la fin de la transaction', 'stock_logs', 'stock_logs_product_id_fkey'],
]) {
  const fk = (await q(`SELECT condeferrable d, condeferred f FROM pg_constraint
    WHERE conname = '${nom}' AND conrelid = '${table}'::regclass`)).rows[0];
  check(libelle, fk?.d === true && fk?.f === true, JSON.stringify(fk));
}

// La cascade de bout en bout : le cas exact qui renvoyait 23503. Avant la
// section 6, ce DELETE échouait parce que products partait alors que la ligne
// de vente le référençait encore.
const SUP_U = '88888888-8888-4888-8888-888888888822';
const SUP_P = '88888888-8888-4888-8888-888888888823';
const SUP_V = '88888888-8888-4888-8888-888888888824';
await q(`INSERT INTO auth.users (id, email)
         VALUES ('${SUP_U}', 'cascade20@t.ci') ON CONFLICT DO NOTHING`);
await q(`INSERT INTO products (id, user_id, name)
         VALUES ('${SUP_P}', '${SUP_U}', 'Produit jetable')`);
await q(`INSERT INTO sales (id, user_id, total_amount, payment_method)
         VALUES ('${SUP_V}', '${SUP_U}', 20, 'cash')`);
await q(`INSERT INTO sale_items (sale_id, product_id, product_name, quantity, unit_price, subtotal)
         VALUES ('${SUP_V}', '${SUP_P}', 'Produit jetable', 1, 20, 20)`);
await q(`INSERT INTO stock_logs (user_id, product_id, product_name, movement_type,
                                 quantity_change, stock_before, stock_after)
         VALUES ('${SUP_U}', '${SUP_P}', 'Produit jetable', 'sale', -1, 5, 4)`);

let suppressionOk = true;
let motifSup = '';
try {
  await q(`DELETE FROM auth.users WHERE id = '${SUP_U}'`);
} catch (err) {
  suppressionOk = false;
  motifSup = err.message;
}
check('20e. la suppression d’un compte pourvu de ventes réussit', suppressionOk, motifSup);

const reste = (await q(`
  SELECT (SELECT count(*) FROM products   WHERE user_id  = '${SUP_U}')::int
       + (SELECT count(*) FROM sales      WHERE user_id  = '${SUP_U}')::int
       + (SELECT count(*) FROM sale_items WHERE product_id = '${SUP_P}')::int
       + (SELECT count(*) FROM stock_logs WHERE product_id = '${SUP_P}')::int AS c`)).rows[0].c;
check('20f. la cascade a tout emporté', reste === 0, `${reste} ligne(s) restante(s)`);

// ─── 21. Synthèse des ventes ─────────────────────────────────
// Rapports et Historique additionnaient les ventes côté JavaScript : ils
// téléchargeaient sales + sale_items(*) sur toute la période. La fonction
// remplace ce calcul — elle doit rendre EXACTEMENT le même chiffre, sinon les
// totaux affichés bougent au déploiement sans que personne l'ait demandé.
console.log('\n▸ Synthèse des ventes');

// PGlite rend les colonnes `date` en objets Date JavaScript : interpolés dans
// une requête, ils deviennent « Mon Jun 15 2026 … » et PostgreSQL refuse.
// On force du texte, comme le fait déjà le reste du harnais (::date::text).
const SYN = (await q(`
  SELECT (min(created_at) AT TIME ZONE 'UTC')::date::text AS a,
         (max(created_at) AT TIME ZONE 'UTC')::date::text AS b
    FROM sales`)).rows[0];

const synthese = (await q(
  `SELECT day::text AS day, revenue, cash, momo, tx
     FROM get_sales_summary('${SYN.a}', '${SYN.b}', 'UTC')`)).rows;

// La référence est calculée en SQL de la façon dont le client le faisait en
// JavaScript : SUM(total_amount), puis espèces et Mobile Money à part — les
// crédits (payment_method = 'credit') n'entrent dans aucune des deux.
const refSyn = (await q(`
  SELECT COALESCE(SUM(total_amount), 0) AS revenue,
         COALESCE(SUM(CASE WHEN payment_method = 'cash'
                           THEN total_amount ELSE 0 END), 0) AS cash,
         COALESCE(SUM(CASE WHEN payment_method = 'momo'
                           THEN total_amount ELSE 0 END), 0) AS momo,
         COUNT(*) AS tx
    FROM sales
   WHERE created_at >= ('${SYN.a}'::timestamp AT TIME ZONE 'UTC')
     AND created_at <  (('${SYN.b}'::date + 1)::timestamp AT TIME ZONE 'UTC')`)).rows[0];

const somme = (col) => synthese.reduce((t, r) => t + Number(r[col]), 0);

check('21a. total de période identique à l’ancien calcul client',
  somme('revenue') === Number(refSyn.revenue),
  `fonction ${somme('revenue')} / SQL ${refSyn.revenue}`);
check('21b. part espèces identique',
  somme('cash') === Number(refSyn.cash),
  `fonction ${somme('cash')} / SQL ${refSyn.cash}`);
check('21c. part Mobile Money identique',
  somme('momo') === Number(refSyn.momo),
  `fonction ${somme('momo')} / SQL ${refSyn.momo}`);
check('21d. nombre de transactions identique',
  somme('tx') === Number(refSyn.tx),
  `fonction ${somme('tx')} / SQL ${refSyn.tx}`);

// Le découpage par jour est le nerf du graphique : c'est lui qui place les
// barres. Il doit suivre le fuseau passé en paramètre, et lui seul.
const joursRef = (await q(`
  SELECT (created_at AT TIME ZONE 'UTC')::date::text AS d, COUNT(*) AS n
    FROM sales GROUP BY 1 ORDER BY 1`)).rows;
check('21e. une ligne par jour de vente, même découpage',
  JSON.stringify(synthese.map((r) => `${r.day}:${Number(r.tx)}`)) ===
  JSON.stringify(joursRef.map((r) => `${r.d}:${Number(r.n)}`)),
  `${synthese.length} jour(s)`);

// Top produits : même classement que l'ancien sort().slice(0, 6) du client.
const top = (await q(
  `SELECT * FROM get_top_products('${SYN.a}', '${SYN.b}', 'UTC', 6)`)).rows;
const topRef = (await q(`
  SELECT si.product_name, COALESCE(SUM(si.quantity), 0) AS qty
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
   WHERE s.created_at >= ('${SYN.a}'::timestamp AT TIME ZONE 'UTC')
     AND s.created_at <  (('${SYN.b}'::date + 1)::timestamp AT TIME ZONE 'UTC')
   GROUP BY si.product_name
   ORDER BY COALESCE(SUM(si.quantity), 0) DESC, si.product_name
   LIMIT 6`)).rows;
check('21f. top produits identique',
  JSON.stringify(top.map((r) => `${r.product_name}:${Number(r.qty)}`)) ===
  JSON.stringify(topRef.map((r) => `${r.product_name}:${Number(r.qty)}`)),
  `${top.length} ligne(s)`);

// Bornes de la limite : sans plafond, un appelant repartirait avec la table
// entière — on aurait déplasé le problème au lieu de le régler.
const borne = (await q(`SELECT count(*)::int c FROM get_top_products(
  '${SYN.a}', '${SYN.b}', 'UTC', 999999)`)).rows[0].c;
check('21g. la limite est plafonnée à 100', borne <= 100, `${borne} ligne(s)`);

// Ces fonctions n'additionnent que des lignes que l'appelant peut déjà
// SELECTer sous RLS, mais rien ne sert de les exposer à la clé anon.
const anon = (await q(`
  SELECT has_function_privilege('anon', 'get_sales_summary(date,date,text)', 'EXECUTE')       AS a,
         has_function_privilege('anon', 'get_top_products(date,date,text,int)', 'EXECUTE')    AS b`)).rows[0];
check('21h. la clé anon ne peut pas appeler ces fonctions',
  anon.a === false && anon.b === false, `anon=${anon.a}/${anon.b}`);

// ─── 22. La clé anon ne doit plus rien appeler ────────────────
// Constat qui a motivé la 7ᵉ section de migration_security.sql : Supabase
// accorde EXECUTE à anon, authenticated et service_role au moment de la
// CRÉATION de chaque fonction (ALTER DEFAULT PRIVILEGES). Le grant vient du
// rôle, pas de PUBLIC — donc tous les `REVOKE ... FROM PUBLIC` écrits dans les
// migrations ne lui retiraient rien, et la clé publique du navigateur appelait
// 33 des 35 fonctions, dont 20 en SECURITY DEFINER.
//
// Sans cette section, le harnais restait vert pendant que la base réelle
// laissait la porte ouverte : c'est exactement ce qui s'est passé.
console.log('\n▸ Exposition de la clé anon');

const anonFns = (await q(`
  SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS sig
    FROM pg_proc p
    JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.prokind = 'f'
     AND has_function_privilege('anon', p.oid, 'EXECUTE')
   ORDER BY 1`)).rows.map((r) => r.sig);

// Deux, et deux seulement : celles que les policies RLS appellent. Elles
// s'évaluent sous le rôle de l'appelant, donc les retirer ferait renvoyer
// « permission denied » au lieu de zéro ligne. Pour anon elles renvoient
// NULL / false — aucun accès concédé.
const anonAttendues = ['can_manage_products()', 'get_business_owner_id()'];
check('22a. anon ne garde que les deux helpers des policies RLS',
  JSON.stringify(anonFns) === JSON.stringify(anonAttendues),
  `${anonFns.length} fonction(s) : ${anonFns.join(', ')}`);

// Ce que le navigateur appelle réellement, relevé par grep sur `.rpc(`.
const duNavigateur = [
  'create_sale', 'record_credit_sale', 'archive_product', 'get_customer_debts',
  'pay_customer_debt', 'get_sales_summary', 'get_top_products', 'get_cash_flow',
  'get_product_profitability', 'get_units_sold_since', 'seed_expense_categories',
  'current_org_plan',
];
const privs = (await q(`
  SELECT DISTINCT p.proname
    FROM pg_proc p
    JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.prokind = 'f'
     AND p.proname IN (${duNavigateur.map((f) => `'${f}'`).join(', ')})
     AND has_function_privilege('authenticated', p.oid, 'EXECUTE')`)).rows
  .map((r) => r.proname).sort();
const attendues = [...duNavigateur].sort();
check('22b. authenticated appelle toujours les 12 fonctions du navigateur',
  JSON.stringify(privs) === JSON.stringify(attendues),
  `présentes : ${privs.join(', ')}`);

// Le vrai risque d'un REVOKE trop large : une policy RLS qui ne s'évalue plus.
// On passe en rôle anon, on vide les variables JWT laissées par les sections
// précédentes (sans quoi auth.uid() répond encore et le test ne prouve rien),
// puis on interroge les deux helpers et on vérifie qu'une fonction de garde
// est bien refusée.
let helperOwner, helperRole, gardeBloquee;
try {
  await e(`SET ROLE anon;
           SELECT set_config('request.jwt.claim.sub', '', false);
           SELECT set_config('request.jwt.role', 'anon', false);`);
  helperOwner = (await q(`SELECT get_business_owner_id() IS NULL AS v`)).rows[0].v;
  helperRole = (await q(`SELECT can_manage_products() AS v`)).rows[0].v;
  try {
    await q(`SELECT close_beta_program()`);
    gardeBloquee = false;
  } catch {
    gardeBloquee = true;
  }
} finally {
  await e(`RESET ROLE`);
}
check('22c. en rôle anon, get_business_owner_id() répond NULL (et non une erreur)',
  helperOwner === true, `valeur : ${helperOwner}`);
// `NULL = NULL` vaut NULL, et `NULL OR false` vaut NULL : la fonction répond
// NULL à anon, pas false. Ce qui compte n'est pas le type mais l'effet — il
// faudrait `true` pour ouvrir quoi que ce soit.
check('22d. en rôle anon, can_manage_products() n’accorde rien',
  helperRole !== true, `valeur : ${String(helperRole)}`);
check('22e. en rôle anon, close_beta_program() est refusée',
  gardeBloquee === true, gardeBloquee ? 'permission denied' : 'elle a répondu');

// Et le verrou doit tenir pour les créations futures : une fonction ajoutée
// par la PROCHAINE migration naît déjà fermée, sinon elle rouvrirait la porte
// d'elle-même — exactement ce qui s'est produit sept fois de suite.
await e(`CREATE FUNCTION tmp_porte_fermee() RETURNS int LANGUAGE sql AS 'SELECT 1'`);
const aclFutur = (await q(`
  SELECT coalesce(proacl::text, '(ACL implicite = PUBLIC)') AS a
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'tmp_porte_fermee'`)).rows[0].a;
await e(`DROP FUNCTION tmp_porte_fermee()`);
check('22f. une fonction créée après le verrou naît déjà fermée',
  aclFutur !== '(ACL implicite = PUBLIC)' && !aclFutur.includes('anon'),
  `acl : ${aclFutur}`);

// Les deux helpers ne servent pas qu'aux policies : migration_credit_fns,
// migration_expenses, migration_plan_gate, migration_profitability et
// migration_suppliers les appellent depuis des fonctions SECURITY INVOKER,
// donc SOUS LE RÔLE DE L'APPELANT. Révoquer PUBLIC les couperait aussi pour
// authenticated — et le harnais tourne en postgres, il ne le verrait pas.
const authHelpers = (await q(`
  SELECT p.proname
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.prokind = 'f'
     AND p.proname IN ('get_business_owner_id', 'can_manage_products')
     AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
   ORDER BY p.proname`)).rows.map((r) => r.proname);
check('22g. authenticated appelle toujours les deux helpers des policies',
  JSON.stringify(authHelpers) === JSON.stringify(['can_manage_products', 'get_business_owner_id']),
  `présentes : ${authHelpers.join(', ') || 'aucune'}`);

console.log(`\n${failures === 0 ? '✅' : '❌'} ${failures} échec(s)`);
process.exit(failures ? 1 : 0);
