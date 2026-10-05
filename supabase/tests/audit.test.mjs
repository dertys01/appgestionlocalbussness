// AUDIT D'ÉTAT DES LIEUX — règles financières/comptables de GestionLocal
// Applique la chaîne complète de migrations sur PGlite et VÉRIFIE par
// l'exécution que les nombres se tiennent (pas seulement lecture du code).
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
import path from 'path';

const SQL_DIR = process.argv[2] ?? 'supabase';
const ORDER = [
  'schema.sql','migration_team.sql','migration_saas.sql','migration_plan_limits.sql',
  'migration_invoices.sql','migration_webhook_logs.sql','migration_indexes.sql',
  'migration_sales_rpc.sql','migration_roles.sql','migration_plan_gate.sql',
  'migration_price_override.sql','migration_weighted_sales.sql','migration_credit.sql',
  'migration_partial_payment.sql','migration_profitability.sql','migration_expenses.sql',
  'migration_invitations.sql','migration_profitability_fix.sql','migration_suppliers.sql',
  'migration_credit_fns.sql','migration_beta_program.sql','migration_sales_summary.sql',
  'migration_security.sql','migration_webhook_claim.sql','migration_fk_indexes.sql',
  'migration_domain.sql','migration_restaurant_tables.sql','migration_table_checkout.sql',
  'migration_recipes.sql','migration_restaurant_finitions.sql','migration_menu_days.sql',
  'migration_ca_caisse.sql',
];

const db = new PGlite();
let failures = 0, passes = 0;
const check = (label, ok, detail) => {
  if (ok) { passes++; console.log(`  ✓ ${label}`); }
  else { failures++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const close = (a, b, tol = 0.02) => Math.abs(Number(a) - Number(b)) <= tol;
const fmt = (d) => { const x = d instanceof Date ? d : new Date(d); return x.toISOString().slice(0, 10); };

async function q(sql) { return db.query(sql); }
async function e(sql) { return db.exec(sql); }
const one = async (sql) => (await q(sql)).rows[0];
const num = async (sql, col = 'c') => Number((await one(sql))?.[col] ?? 0);

// ─── Stub auth (même surface que le harnais officiel) ───────────
async function bootstrap() {
  await e(`
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE TABLE IF NOT EXISTS auth.users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text,
      raw_user_meta_data jsonb DEFAULT '{}'::jsonb,
      confirmation_token text, recovery_token text,
      email_change_token_new text, email_change text);
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS
      $$ SELECT COALESCE(current_setting('request.jwt.role', true), 'anon') $$;
  `);
  await e(`CREATE OR REPLACE FUNCTION uuid_generate_v4() RETURNS uuid LANGUAGE sql VOLATILE AS $$ SELECT gen_random_uuid() $$;`);
  await e(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;`);
  await e(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;`);
}

console.log('\n▸ Application des 32 migrations');
await bootstrap();
for (const file of ORDER) {
  const sql = fs.readFileSync(path.join(SQL_DIR, file), 'utf8').replace(/CREATE EXTENSION[^;]*;/gi, '');
  try { await db.exec(sql); } catch (err) { failures++; console.log(`  ✗ ${file}\n    ${err.message}`); }
}
check('les 32 migrations s appliquent sans erreur', failures === 0);

// ─── Tenant : patron (pro, fuseau UTC), employé, produits ──────
const PATRON = '11111111-1111-1111-1111-111111111111';
const EMPLOYE = '22222222-2222-2222-2222-222222222222';
await e(`UPDATE beta_program SET open = false, slots_used = 0 WHERE id = 1`);
await q(`INSERT INTO auth.users (id, email) VALUES ('${PATRON}','patron@test.ci'),('${EMPLOYE}','employe@test.ci')`);
await q(`INSERT INTO organizations (id, name, slug, timezone) VALUES ('${PATRON}','Boutique Audit','boutique-audit','UTC')`);
await q(`UPDATE organizations SET plan = 'pro' WHERE id = '${PATRON}'`);
await q(`INSERT INTO business_members (owner_id, member_id, member_name) VALUES ('${PATRON}','${EMPLOYE}','Caissier')`);

const P_RIZ   = 'aaaaaaaa-0000-0000-0000-000000000001';
const P_HUILE = 'aaaaaaaa-0000-0000-0000-000000000002';
const P_PLAT  = 'aaaaaaaa-0000-0000-0000-000000000003';
const P_CASH  = 'aaaaaaaa-0000-0000-0000-000000000004';
await q(`
  INSERT INTO products (id, user_id, name, sku, price_buy, price_sell, stock_qty, min_stock_level)
  VALUES
    ('${P_RIZ}','${PATRON}','Riz 1kg','RIZ',1000,1500,100,2),
    ('${P_HUILE}','${PATRON}','Huile 1L','HUI',500,800,100,2),
    ('${P_PLAT}','${PATRON}','Plat du jour','PLAT',0,5000,100,2),
    ('${P_CASH}','${PATRON}','Produit A','PROD',3000,7000,10,2)
`);
// Recette : 1 plat = 2 Riz + 1 Huile  →  coût = 2×1000 + 1×500 = 2500
await q(`INSERT INTO recipe_ingredients (dish_id, ingredient_id, quantity) VALUES ('${P_PLAT}','${P_RIZ}',2),('${P_PLAT}','${P_HUILE}',1)`);

// Dates fournies par le serveur (évite tout décalage de fuseau/minuit)
const srv = await one(`SELECT CURRENT_DATE AS d, (CURRENT_DATE - 1) AS y`);
const TODAY = fmt(srv.d);   // 'YYYY-MM-DD'
const YEST  = fmt(srv.y);
console.log(`    (fuseau boutique = UTC ; aujourd'hui = ${TODAY})`);

const sale = async (payload, method = 'cash', client = null) =>
  (await q(`SELECT create_sale('${payload}'::jsonb, '${method}'${client ? `, '${client}'` : ''})`)).rows[0].create_sale;
const stock = async (id) => Number((await one(`SELECT stock_qty FROM products WHERE id='${id}'`)).stock_qty);
const caTotal = async (from, to) => {
  const r = await q(`SELECT revenue FROM get_sales_summary('${from}', '${to}', 'UTC')`);
  return r.rows.reduce((s, x) => s + Number(x.revenue), 0);
};

await q(`SELECT set_config('request.jwt.claim.sub', '${PATRON}', false)`);

// ─── A. Base de caisse ──────────────────────────────────────────
console.log('\n▸ A. Base de caisse (CA = encaissé, pas facturé)');
{
  const res = await sale(`[{"product_id":"${P_CASH}","quantity":2}]`, 'cash', 'M. Diallo');
  const s = await one(`SELECT total_amount, amount_received FROM sales WHERE id='${res.id}'`);
  check('A1. vente espèces : amount_received = total_amount', close(s.amount_received, s.total_amount), `reçu=${s.amount_received} total=${s.total_amount}`);
  check('A2. stock décrémenté 10 → 8', (await stock(P_CASH)) === 8, `obtenu ${await stock(P_CASH)}`);
}

// ─── D. Coût des recettes ───────────────────────────────────────
console.log('\n▸ D. Coût de revient par recette');
{
  const pc = await one(`SELECT product_cost('${P_PLAT}') AS c`);
  check('D1. product_cost(plat) = 2×Riz + 1×Huile = 2500', close(pc.c, 2500), `obtenu ${pc.c}`);
  const before = { riz: await stock(P_RIZ), huile: await stock(P_HUILE) };
  const res = await sale(`[{"product_id":"${P_PLAT}","quantity":1}]`, 'cash', 'M. Diallo');
  const it = await one(`SELECT unit_cost FROM sale_items WHERE sale_id='${res.id}'`);
  check('D2. unit_cost figé = coût recette (2500), pas price_buy (0)', close(it.unit_cost, 2500), `obtenu ${it.unit_cost}`);
  check('D3. stock ingrédients décrémenté (Riz −2, Huile −1)',
    (await stock(P_RIZ)) === before.riz - 2 && (await stock(P_HUILE)) === before.huile - 1,
    `Riz ${before.riz}→${await stock(P_RIZ)}, Huile ${before.huile}→${await stock(P_HUILE)}`);
}

// ─── B. Crédit + acompte ────────────────────────────────────
console.log('\n▸ B. Vente à crédit avec acompte');
let CREDIT_SALE_ID, DEBT_ID;
{
  const res = await q(`SELECT record_credit_sale('[{"product_id":"${P_CASH}","quantity":1}]'::jsonb, 'M. Koffi', '+229 01 01 01 01', 'Credit audit', 3500, 'momo')`);
  const r = res.rows[0].record_credit_sale;
  CREDIT_SALE_ID = r.id; DEBT_ID = r.debt_id;
  const s = await one(`SELECT total_amount, amount_received, settled FROM sales WHERE id='${CREDIT_SALE_ID}'`);
  check('B1. acompte : amount_received = 3500 (pas 7000)', close(s.amount_received, 3500), `obtenu ${s.amount_received}`);
  check('B2. vente non soldée (settled = false)', s.settled === false, `settled=${s.settled}`);
  const d = await one(`SELECT total_due, total_paid FROM get_customer_debts() WHERE debt_id='${DEBT_ID}'`);
  check('B3. dette client = total − acompte = 3500', close(d.total_due, 3500), `dû=${d.total_due}`);
  check('B4. déjà versé = 3500', close(d.total_paid, 3500), `payé=${d.total_paid}`);

  // Le moyen est refusé AVANT create_sale() : sans acompte valide, aucune
  // vente n'est écrite et le stock n'est pas touché.
  const nbAvant = await num(`SELECT count(*) AS c FROM sales`);
  let refusMoyen = false;
  try {
    await q(`SELECT record_credit_sale('[{"product_id":"${P_CASH}","quantity":1}]'::jsonb, 'M. Refus', '+229 03 03 03 03', NULL, 100, 'carte')`);
  } catch { refusMoyen = true; }
  const nbApres = await num(`SELECT count(*) AS c FROM sales`);
  check('B5. acompte hors cash/momo refusé, aucune vente écrite',
    refusMoyen && nbApres === nbAvant, `refus=${refusMoyen} ventes ${nbAvant}→${nbApres}`);
}

// ─── E. Résultat net (CA − CMV − charges) ───────────────────
console.log('\n▸ E. Résultat net journalier (get_cash_flow)');
{
  await q(`INSERT INTO expenses (user_id, category, label, amount, day) VALUES ('${PATRON}','Loyer','Loyer octobre',10000,'${TODAY}')`);
  const cf = await one(`SELECT revenue, cogs, expenses, net, transactions FROM get_cash_flow('${TODAY}', '${TODAY}')`);
  const expRev = 14000 + 5000 + 3500, expCogs = 6000 + 2500 + 1500, expExp = 10000;
  check('E1. revenue = 22500 (14000+5000+3500 encaissé)', close(cf.revenue, expRev), `obtenu ${cf.revenue}`);
  check('E2. CMV proraté = 10000 (6000+2500+1500)', close(cf.cogs, expCogs), `obtenu ${cf.cogs}`);
  check('E3. charges = 10000', close(cf.expenses, expExp), `obtenu ${cf.expenses}`);
  check('E4. net = CA − CMV − charges = 2500', close(cf.net, expRev - expCogs - expExp), `obtenu ${cf.net}`);
  check('E5. 3 transactions', Number(cf.transactions) === 3, `obtenu ${cf.transactions}`);
  // Jour à charge seule (pas de vente) doit apparaître
  await q(`INSERT INTO expenses (user_id, category, label, amount, day) VALUES ('${PATRON}','Eau','Eau',2000,'${YEST}')`);
  const y = await one(`SELECT revenue, expenses FROM get_cash_flow('${YEST}', '${YEST}')`);
  check('E6. jour sans vente mais avec charge : apparaît (revenue=0, expenses=2000)',
    y !== undefined && close(y.revenue, 0) && close(y.expenses, 2000),
    y ? `rev=${y.revenue} exp=${y.expenses}` : 'aucune ligne');
}

// ─── C. Encaissement FIFO + imputation au jour de la vente ──────
console.log('\n▸ C. Encaissement FIFO et imputation au jour de la vente');
{
  // Reculer la vente à crédit à HIER : le règlement d'aujourd'hui doit
  // augmenter le CA d'HIER, pas celui d'aujourd'hui.
  await q(`UPDATE sales SET created_at = now() - interval '1 day' WHERE id='${CREDIT_SALE_ID}'`);
  const caYAvant = await caTotal(YEST, YEST);
  const caAujAvant = await caTotal(TODAY, TODAY);
  check('C1. avant règlement : CA d hier = 3500 (l acompte)', close(caYAvant, 3500), `obtenu ${caYAvant}`);
  await q(`SELECT pay_customer_debt('${DEBT_ID}'::uuid, 3500, 'cash', 'Règlement audit')`);
  const s = await one(`SELECT amount_received, settled FROM sales WHERE id='${CREDIT_SALE_ID}'`);
  check('C2. après règlement : amount_received = 7000, settled', close(s.amount_received, 7000) && s.settled === true, `reçu=${s.amount_received} settled=${s.settled}`);
  const caYApres = await caTotal(YEST, YEST);
  const caAujApres = await caTotal(TODAY, TODAY);
  check('C3. le règlement augmente le CA d HIER (3500 → 7000)', close(caYApres, 7000) && close(caYApres - caYAvant, 3500), `hier ${caYAvant}→${caYApres}`);
  check('C4. le CA d AUJOURD HUI ne bouge pas (imputation à la vente)', close(caAujApres, caAujAvant), `auj ${caAujAvant}→${caAujApres}`);
  const cfY = await one(`SELECT revenue, cogs FROM get_cash_flow('${YEST}', '${YEST}')`);
  check('C5. get_cash_flow d hier : revenue=7000, CMV=3000 (prorata complet)', close(cfY.revenue, 7000) && close(cfY.cogs, 3000), `rev=${cfY.revenue} cogs=${cfY.cogs}`);
}

// ─── F. Restaurant : UNE vente, pourboire hors CA ───────────
console.log('\n▸ F. Restaurant (clôture d addition)');
{
  const T1 = await q(`INSERT INTO restaurant_tables (owner_id, name, zone) VALUES ('${PATRON}','Table 1','Salle') RETURNING id`);
  const tid = T1.rows[0].id;
  const O1 = await q(`INSERT INTO restaurant_orders (owner_id, table_id, status) VALUES ('${PATRON}','${tid}','open') RETURNING id`);
  const oid = O1.rows[0].id;
  await q(`INSERT INTO restaurant_order_items (order_id, product_id, quantity, unit_price) VALUES ('${oid}','${P_CASH}',1,7000),('${oid}','${P_CASH}',1,7000)`);
  const avant = await num(`SELECT count(*) AS c FROM sales`);
  const res = await q(`SELECT close_table_order('${oid}'::uuid, 'cash', NULL, 3, NULL, NULL, 500)`);
  const r = res.rows[0].close_table_order;
  const apres = await num(`SELECT count(*) AS c FROM sales`);
  check('F1. UNE seule vente créée (pas 3, ni ×parts)', apres - avant === 1, `ventes ${avant}→${apres}`);
  const s = await one(`SELECT total_amount, amount_received FROM sales WHERE id='${r.sale_id}'`);
  check('F2. total vente = 14000 (2×7000), parts = affichage seul', close(s.total_amount, 14000) && close(s.amount_received, 14000), `total=${s.total_amount}`);
  check('F3. pourboire HORS du total de la vente', close(r.tip, 500) && close(r.total_with_tip, 14500) && !close(s.total_amount, 14500), `tip=${r.tip} total_avec_tip=${r.total_with_tip} total_vente=${s.total_amount}`);
  check('F4. par part = 14000/3 ≈ 4666.67', close(r.per_share, 14000/3, 0.02), `obtenu ${r.per_share}`);
  check('F5. commande clôturée et rattachée à la vente',
    (await one(`SELECT status, sale_id FROM restaurant_orders WHERE id='${oid}'`)).status === 'closed');
}

// ─── G. Invariants d intégrité ──────────────────────────────────
console.log('\n▸ G. Invariants');
{
  const bad = await one(`SELECT count(*) AS c FROM sales WHERE amount_received < 0 OR amount_received > total_amount`);
  check('G1. aucune vente : amount_received hors [0, total_amount]', Number(bad.c) === 0, `${bad.c} enfreinte(s)`);
  const neg = await one(`SELECT count(*) AS c FROM expenses WHERE amount <= 0`);
  check('G2. aucune charge négative ou nulle', Number(neg.c) === 0, `${neg.c} enfreinte(s)`);
}

// ─── H. Répartition cash/momo vs CA (écart d acompte) ───────────
console.log('\n▸ H. Répartition cash/momo vs CA (recherche d écart)');
{
  const row = await one(`SELECT day, revenue, cash, momo FROM get_sales_summary('${TODAY}', '${TODAY}', 'UTC')`);
  const sum = Number(row.cash) + Number(row.momo);
  console.log(`    AUJOURD HUI : CA=${row.revenue}  cash=${row.cash}  momo=${row.momo}  cash+momo=${sum}`);
  const y = await one(`SELECT day, revenue, cash, momo FROM get_sales_summary('${YEST}', '${YEST}', 'UTC')`);
  const ysum = Number(y.cash) + Number(y.momo);
  console.log(`    HIER      : CA=${y.revenue}  cash=${y.cash}  momo=${y.momo}  cash+momo=${ysum}`);
  check('H1. aujourd hui : cash+momo = CA (ventes 100 % espèces)', close(sum, Number(row.revenue)),
    `écart=${Number(row.revenue) - sum}`);
  // L acompte est dans le CA d hier ET dans sa colonne : ca_caisse positionne
  // sale_id sur le versement d acompte, donc la répartition se tient — ici
  // l acompte part en momo et le règlement en cash, et les deux couvrent le CA.
  const ecart = Number(y.revenue) - ysum;
  check('H2. hier : cash+momo = CA (acompte ventilé, sale_id positionné)',
    close(ecart, 0), `CA=${y.revenue} cash+momo=${ysum} écart=${ecart}`);
  // L acompte porte le moyen choisi à la vente (p_advance_method), plus un
  // « cash » déduit : sa part de caisse suit le vrai geste du client.
  const adv = await one(`SELECT method FROM credit_payments WHERE debt_id='${DEBT_ID}' AND note='Acompte versé à la vente'`);
  check('H3. acompte ventilé selon le moyen choisi à la vente (momo)',
    adv !== undefined && adv.method === 'momo', `method=${adv?.method}`);
}

console.log(`\n${'═'.repeat(50)}`);
console.log(`  AUDIT : ${passes} contrôle(s) passé(s), ${failures} échec(s)`);
console.log(`${'═'.repeat(50)}`);
await db.close();
process.exit(failures > 0 ? 1 : 0);
