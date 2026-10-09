import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseProductsCsv, lignesImportables } from '@/lib/utils/importProducts';

/**
 * Deux fichiers, deux rôles.
 *
 * 1. Le fichier RÉELLEMENT livré au mainteneur (`import-local/`, gitignoré car
 *    il porte les prix d'achat) : présent en local, absent en CI. Ses
 *    assertions sont spécifiques (35 produits, un prix précis) — d'où le
 *    `skipIf`.
 *
 * 2. Un fichier d'EXEMPLE synthétique, COMMITÉ (`tests/fixtures/`) : mêmes
 *    tours d'écriture que le vrai (séparateur `;`, en-têtes français, notation
 *    `k`, catégorie avec espace parasite, nom entre guillemets avec `""`,
 *    doublon, vente à perte), mais des données inventées. Il tourne donc en CI
 *    et ferme le trou « aucun fichier livré n'est analysé en intégration ».
 */

// ── 1. Le fichier réel (local seulement) ────────────────────
const CSV_PATH = resolve(process.cwd(), 'import-local/produits-import.csv');
const CSV = existsSync(CSV_PATH) ? readFileSync(CSV_PATH, 'utf8') : '';

/** Les 9 produits déjà en boutique dans Test1, qui ne doivent pas être réimportés. */
const EXISTANTS = [
  'Chargeurs Samsung 45w', 'Nokia 105 Duos', 'POwerbank Oraimo 25000 mah',
  'Pochette S26 ultra', 'RIZ', 'Samsung A17', 'Tete chargeur Iphone 25w',
  'hp 15 core i7 8/256', 'redmi 15c 8/256',
];

describe.skipIf(!existsSync(CSV_PATH))('le fichier livré passe bien par l\'analyseur', () => {
  const r = parseProductsCsv(CSV, EXISTANTS);
  const ok = lignesImportables(r);

  it('s\'analyse sans erreur bloquante', () => {
    expect(r.erreur).toBeNull();
  });

  it('donne 35 produits importables', () => {
    expect(ok).toHaveLength(35);
  });

  it('ne contient aucune ligne refusée', () => {
    // Une vente à perte ou un montant illisible ferait échouer l'import
    // entier dans l'écran : c'est ici qu'on le verrait avant l'utilisateur.
    expect(r.rows.filter((x) => x.status === 'erreur')).toEqual([]);
  });

  it('n\'est pas en collision avec les produits déjà en boutique', () => {
    expect(r.rows.filter((x) => x.status === 'deja_present')).toEqual([]);
  });

  it('regroupe les deux familles de téléphones sous « smartphones »', () => {
    const telephones = ok.filter((x) => x.category === 'smartphones');
    expect(telephones).toHaveLength(18); // 9 Redmi + 9 Samsung
  });

  it('n\'a aucune catégorie porteuse d\'une espace parasite', () => {
    for (const p of ok) {
      expect(p.category).not.toMatch(/[\s ]$/);
      expect(p.category).toBe(p.category?.trim() ?? null);
    }
  });

  it('ne vend jamais sous le prix d\'achat', () => {
    for (const p of ok) expect(p.price_sell).toBeGreaterThan(p.price_buy);
  });

  it('conserve les prix calculés : 520 000 d\'achat donne 580 000 de vente', () => {
    const hp = ok.find((x) => x.name.startsWith('HP 15 FD0127DX'));
    expect(hp?.price_buy).toBe(520000);
    expect(hp?.price_sell).toBe(580000);
  });

  it('lit « 110k » comme 110 000', () => {
    const note = ok.find((x) => x.name === 'Note 15 256/8');
    expect(note?.price_buy).toBe(110000);
    expect(note?.price_sell).toBe(135000); // tranche ≤ 200 000 → +25 000
  });

  it('n\'a aucun stock déclaré, donc aucune alerte de réapprovisionnement', () => {
    for (const p of ok) {
      expect(p.stock_qty).toBe(0);
      expect(p.min_stock_level).toBe(0);
    }
  });
});

// ── 2. Le fichier d'exemple (CI) ────────────────────────────
describe('un fichier au format livré s\'analyse (exemple commité)', () => {
  const EXEMPLE = readFileSync(resolve(process.cwd(), 'tests/fixtures/import-produits.exemple.csv'), 'utf8');
  const r = parseProductsCsv(EXEMPLE, ['Câble']);
  const ok = lignesImportables(r);
  const statut = (nom: string) => r.rows.find((x) => x.name === nom)?.status;

  it('s\'analyse sans erreur bloquante', () => {
    expect(r.erreur).toBeNull();
  });

  it('détecte le séparateur « ; » et les en-têtes français', () => {
    expect(r.colonnes).toContain('Prix vente (F)');
  });

  it('lit « 110k » comme 110 000 et garde le prix de vente', () => {
    const ecran = ok.find((x) => x.name.startsWith('Écran'));
    expect(ecran?.price_buy).toBe(110000);
    expect(ecran?.price_sell).toBe(135000);
  });

  it('conserve un nom entre guillemets avec guillemet échappé', () => {
    expect(ok.some((x) => x.name.includes('14"'))).toBe(true);
  });

  it('nettoie une catégorie suivie d\'une espace parasite', () => {
    const ecran = ok.find((x) => x.name.startsWith('Écran'));
    expect(ecran?.category).toBe('Informatique');
  });

  it('refuse une vente sous le prix d\'achat', () => {
    expect(statut('Clavier')).toBe('erreur');
  });

  it('signale un doublon dans le fichier (seule la première ligne compte)', () => {
    expect(r.rows.filter((x) => x.name === 'Souris' && x.status === 'doublon_fichier')).toHaveLength(1);
  });

  it('écarte un produit déjà en boutique', () => {
    expect(statut('Câble')).toBe('deja_present');
  });

  it('ne garde que les lignes importables', () => {
    expect(ok.map((x) => x.name)).toEqual(['Écran 14"', 'Souris']);
  });
});
