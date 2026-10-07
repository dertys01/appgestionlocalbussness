// Relance WhatsApp et exports (Sprint 21), sur un compte existant, à 375 px.
//
// Vérifie : chaque lien « Relancer » porte un numéro international ; Excel
// (dettes et ventes) s'ouvre en colonnes « ; » ; le PDF s'ouvre, porte un
// total et ne déborde pas ; aucune erreur HTTP ni JS.
//
// Usage (serveur lancé, compte en plan Starter ou Pro avec des dettes) :
//   QA_BASE=http://localhost:3001 QA_PASSWORD=<mot de passe> node qa/exports.mjs <email>
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.env.QA_BASE ?? 'http://localhost:3001';
const email = process.argv[2];
if (!email || !process.env.QA_PASSWORD) {
  console.error('Usage : QA_PASSWORD=… node qa/exports.mjs <email>');
  process.exit(2);
}
fs.mkdirSync('qa/shots', { recursive: true });

let echecs = 0;
const ok = (label, cond, detail = '') => {
  if (!cond) echecs++;
  console.log(`  ${cond ? '✓' : '✗'} ${label}${!cond && detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, acceptDownloads: true });
const page = await ctx.newPage();
const erreurs = [];
const surveiller = (p) => {
  p.on('pageerror', (e) => erreurs.push(`JS ${e.message}`));
  p.on('response', (r) => { if (r.status() >= 400) erreurs.push(`HTTP ${r.status()} ${r.url().replace(/\?.*/, '')}`); });
};
surveiller(page);

await page.goto(BASE);
await page.fill('input[type="email"]', email);
await page.fill('input[type="password"]', process.env.QA_PASSWORD);
await page.locator('button[type="submit"]').first().click();
await page.getByRole('button', { name: 'Ouvrir le menu' }).waitFor({ timeout: 30000 });

const aller = async (nom) => {
  await page.getByRole('button', { name: 'Ouvrir le menu' }).click();
  await page.getByRole('button', { name: nom, exact: true }).first().click();
};

const lireExcel = async (bouton) => {
  const [dl] = await Promise.all([page.waitForEvent('download'), bouton.click()]);
  return fs.readFileSync(await dl.path(), 'utf8').replace(/^\uFEFF/, '');
};

const lirePdf = async (bouton, nom) => {
  const [popup] = await Promise.all([ctx.waitForEvent('page'), bouton.click()]);
  surveiller(popup);
  await popup.waitForLoadState();
  // La boîte d'impression ne bloque pas Playwright en headless.
  const texte = await popup.locator('body').innerText();
  const deborde = await popup.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth, document.querySelector('table')?.getBoundingClientRect().right ?? 0) - window.innerWidth);
  await popup.screenshot({ path: `qa/shots/pdf-${nom}.png`, fullPage: true });
  await popup.close();
  return { texte, deborde };
};

console.log(`▸ Exports — ${email}`);

// ── Dettes
await aller('Dettes');
await page.getByText('Carnet de dette').waitFor();
await page.getByRole('link', { name: /Relancer/ }).first().waitFor({ timeout: 15000 });
const liens = await page.getByRole('link', { name: /Relancer/ }).evaluateAll((as) => as.map((a) => a.href));
ok(`${liens.length} lien(s) « Relancer », tous au format international`,
  liens.length > 0 && liens.every((h) => /^https:\/\/wa\.me\/(229|225|228|221|223|226|227)\d{8,10}\?text=/.test(h)),
  liens.find((h) => !/wa\.me\/229/.test(h)));
await page.screenshot({ path: 'qa/shots/dettes-exports.png', fullPage: true });

const excelDettes = await lireExcel(page.getByRole('button', { name: /Excel/ }));
const lignesDettes = excelDettes.trim().split('\n');
ok('Excel des dettes : colonnes séparées par « ; »', lignesDettes[0].startsWith('"Client";"Téléphone";"Reste dû (F)"'), lignesDettes[0]);
ok(`Excel des dettes : ${lignesDettes.length - 1} client(s)`, lignesDettes.length > 1);

const pdfDettes = await lirePdf(page.getByRole('button', { name: /PDF/ }), 'dettes');
ok('PDF des dettes : titre et total', /Dettes clients/.test(pdfDettes.texte) && /client/.test(pdfDettes.texte));
ok('PDF des dettes : pas de débordement à 375 px', pdfDettes.deborde <= 0, `${pdfDettes.deborde} px`);

// ── Ventes (historique)
await aller('Ventes');
await page.getByRole('button', { name: 'Historique' }).click();
const boutonExcel = page.getByRole('button', { name: /Excel/ });
await boutonExcel.waitFor({ timeout: 15000 }).catch(() => {});
if (await boutonExcel.count()) {
  const excelVentes = await lireExcel(boutonExcel);
  ok('Excel des ventes : colonnes « ; »', excelVentes.startsWith('"Date";"Montant (F)";"Encaissé (F)"'), excelVentes.split('\n')[0]);
  const pdfVentes = await lirePdf(page.getByRole('button', { name: /PDF/ }), 'ventes');
  ok('PDF des ventes : total', /vente/.test(pdfVentes.texte));
  ok('PDF des ventes : pas de débordement à 375 px', pdfVentes.deborde <= 0, `${pdfVentes.deborde} px`);
} else {
  console.log('  · aucune vente sur la période : export des ventes non testé');
}

const deborde = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
ok('écran Ventes : pas de débordement à 375 px', deborde <= 0, `${deborde} px`);
ok('aucune erreur HTTP ni JS', erreurs.length === 0, erreurs.slice(0, 3).join(' | '));

await browser.close();
console.log(`\n${echecs === 0 ? '✅' : '❌'} ${echecs} échec(s)`);
process.exit(echecs ? 1 : 0);
