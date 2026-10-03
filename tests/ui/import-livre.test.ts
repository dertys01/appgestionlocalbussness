import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseProductsCsv, lignesImportables } from '@/lib/utils/importProducts';

/**
 * Le fichier réellement livré au mainteneur, lu depuis le disque.
 *
 * Les autres tests partent d'un CSV écrit à la main dans le test : ils
 * prouvent que l'analyseur tolère tel format, pas que le fichier qu'on livre
 * passe. Ce test là ferme l'écart : si quelqu'un régénère le CSV avec un
 * séparateur, une colonne renommée ou une catégorie mal orthographiée, la
 * suite tombe ici.
 */
const CSV = readFileSync(resolve(process.cwd(), 'import-local/produits-import.csv'), 'utf8');

/** Les 9 produits déjà en boutique dans Test1, qui ne doivent pas être réimportés. */
const EXISTANTS = [
  'Chargeurs Samsung 45w', 'Nokia 105 Duos', 'POwerbank Oraimo 25000 mah',
  'Pochette S26 ultra', 'RIZ', 'Samsung A17', 'Tete chargeur Iphone 25w',
  'hp 15 core i7 8/256', 'redmi 15c 8/256',
];

describe('le fichier livré passe bien par l\'analyseur', () => {
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
      expect(p.category).not.toMatch(/[\s  ]$/);
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
