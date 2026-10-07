// Accueil, Journal du jour et caisse d'un compte existant, à une largeur donnée :
// texte affiché, débordement horizontal, tri de la caisse, erreurs HTTP et JS.
//
// Usage (serveur lancé) :
//   QA_BASE=http://localhost:3001 QA_PASSWORD=<mot de passe> node qa/accueil.mjs <email> <largeur> <étiquette>
// Captures dans qa/shots/{accueil,ventes,caisse}-<étiquette>.png
import { chromium } from 'playwright';
const [email, largeur, tag] = process.argv.slice(2);
const b = await chromium.launch();
const p = await (await b.newContext({ viewport:{ width:Number(largeur), height:812 }, isMobile:Number(largeur)<1024 })).newPage();
const errs=[]; p.on('response', r=>{ if(r.status()>=400) errs.push(r.status()+' '+r.url().replace(/\?.*/,'')); });
p.on('pageerror', e=>errs.push('JS '+e.message));
await p.goto((process.env.QA_BASE ?? 'http://localhost:3001'));
await p.fill('input[type="email"]', email); await p.fill('input[type="password"]',process.env.QA_PASSWORD);
await p.locator('button[type="submit"]').first().click();
await p.getByText(/Encaissé aujourd/).waitFor({timeout:30000});
await p.waitForFunction(() => !document.body.innerText.includes('…'), null, {timeout:15000}).catch(()=>{});
const deborde = async () => p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
console.log(tag, 'accueil :', (await p.locator('main').innerText()).replace(/\s+/g,' ').slice(0,400));
console.log(tag, 'débordement accueil', await deborde());
await p.screenshot({ path:`qa/shots/accueil-${tag}.png`, fullPage:true });
const menu = Number(largeur)<1024;
const aller = async (nom) => { if (menu) await p.getByRole('button',{name:'Ouvrir le menu'}).click(); await p.getByRole('button',{name:nom, exact:true}).first().click(); await p.waitForTimeout(1500); };
await aller('Ventes');
console.log(tag, 'débordement ventes', await deborde(), '| bandeau :', (await p.locator('p.bg-amber-50').allInnerTexts()).join(' / '));
await p.screenshot({ path:`qa/shots/ventes-${tag}.png`, fullPage:true });
await aller('Vente');
console.log(tag, 'débordement caisse', await deborde(), '| tri :', await p.locator('select[aria-label="Tri des produits"] option').first().innerText());
await p.screenshot({ path:`qa/shots/caisse-${tag}.png` });
console.log(tag, 'erreurs :', errs);
await b.close();
