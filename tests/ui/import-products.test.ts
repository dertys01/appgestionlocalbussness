import { describe, expect, it } from 'vitest';

import {
  parseMontant,
  parseProductsCsv,
  lignesImportables,
  cleNom,
} from '@/lib/utils/importProducts';

/** L'en-tête produite par l'export du projet, à l'identique. */
const ENTETE = '"Produit","SKU","Catégorie","Prix achat (F)","Prix vente (F)","Stock","Stock min"';

describe('parseMontant — les écritures que les gens font vraiment', () => {
  it('lit « 520.000 » comme cinq cent vingt mille, pas cinq cent vingt', () => {
    // L'erreur la plus coûteuse du lot : inverser ce point divise un prix par mille.
    expect(parseMontant('520.000')).toBe(520000);
    expect(parseMontant('1.349.400')).toBe(1349400);
  });

  it('traite « 110k » et « 123K » comme des milliers', () => {
    expect(parseMontant('110k')).toBe(110000);
    expect(parseMontant('123K')).toBe(123000);
    expect(parseMontant('1.5k')).toBe(1500);
  });

  it('ne confond pas une décimale avec un milliers', () => {
    expect(parseMontant('1200.5')).toBe(1200.5);
    expect(parseMontant('15000.00')).toBe(15000);
    expect(parseMontant('1500.75')).toBe(1500.75);
  });

  it('lit les espaces de milliers et la virgule décimale', () => {
    expect(parseMontant('15 000')).toBe(15000);
    expect(parseMontant('1 349 400')).toBe(1349400);
    expect(parseMontant('1200,50')).toBe(1200.5);
    expect(parseMontant('1.200,50')).toBe(1200.5);
    expect(parseMontant('1 200,50')).toBe(1200.5);
  });

  it('accepte les autres钞symbols et renvoie 0 pour une cellule vide', () => {
    expect(parseMontant('520 000 F')).toBe(520000);
    expect(parseMontant('')).toBe(0);
    expect(parseMontant('   ')).toBe(0);
    expect(parseMontant('nulle')).toBeNull();
  });
});

describe('parseProductsCsv — le fichier de l\'utilisateur', () => {
  const LIGNES = [
    'HP 15 FD0127DX / CORE I7 / 512SSD / WIN 11,"","laptop","520000","580000","0","0"',
    'HP Probook 440G10 / 14" / DOS,"","laptop","515000","575000","0","0"',
    'HP 137fnw Printer,"","imprimante","165000","190000","0","0"',
    'A7 pro 64/4,"","smartphones","52000","67000","0","0"',
    'A17 256/8,"","smartphones","123000","148000","0","0"',
  ];
  const fichier = [ENTETE, ...LIGNES].join('\r\n');

  it('lit les 5 lignes sans en perdre une', () => {
    const r = parseProductsCsv(fichier);
    expect(r.erreur).toBeNull();
    expect(r.rows).toHaveLength(5);
    expect(lignesImportables(r)).toHaveLength(5);
  });

  it('reconnaît l\'en-tête de l\'export du projet', () => {
    const r = parseProductsCsv(fichier);
    expect(r.colonnes).toEqual([
      'Produit', 'SKU', 'Catégorie', 'Prix achat (F)', 'Prix vente (F)', 'Stock', 'Stock min',
    ]);
    expect(r.rows[0].price_buy).toBe(520000);
    expect(r.rows[0].price_sell).toBe(580000);
  });

  it('échappe les guillemets internes du nom', () => {
    const r = parseProductsCsv(fichier);
    expect(r.rows[1].name).toContain('14"');
    expect(r.rows[1].name).toContain('DOS');
  });

  it('accepte aussi les noms de colonnes de la base', () => {
    const csv = 'name,category,price_buy,price_sell\nRIZ,cereal,1200,1500';
    const r = parseProductsCsv(csv);
    expect(r.erreur).toBeNull();
    expect(lignesImportables(r)).toHaveLength(1);
    expect(r.rows[0].category).toBe('cereal');
  });

  it('accepte le point-virgule d\'un Excel français', () => {
    const csv = 'Produit;Prix vente (F)\nRIZ;1500';
    const r = parseProductsCsv(csv);
    expect(r.erreur).toBeNull();
    expect(r.rows[0].name).toBe('RIZ');
    expect(r.rows[0].price_sell).toBe(1500);
  });

  it('retire le BOM d\'Excel, sinon la première colonne devient illisible', () => {
    const r = parseProductsCsv('﻿' + fichier);
    expect(r.erreur).toBeNull();
    expect(r.rows[0].name).toBe('HP 15 FD0127DX / CORE I7 / 512SSD / WIN 11');
  });
});

describe('parseProductsCsv — ce que l\'écran doit savoir refuser', () => {
  it('refuse un fichier sans les colonnes obligatoires', () => {
    const r = parseProductsCsv('foo,bar\n1,2');
    expect(r.erreur).toContain('obligatoires');
  });

  it('refuse un fichier vide', () => {
    expect(parseProductsCsv('').erreur).toBe('Le fichier est vide.');
    expect(parseProductsCsv(ENTETE).erreur).toContain('au moins une ligne');
  });

  it('marque une ligne sans nom', () => {
    const r = parseProductsCsv(`${ENTETE}\n,"","smartphones","1000","1500","0","0"`);
    expect(r.rows[0].status).toBe('erreur');
    expect(r.rows[0].problem).toBe('Nom manquant.');
  });

  it('refuse une vente à perte, plutôt que de la créer en silence', () => {
    const r = parseProductsCsv(`${ENTETE}\nPerte,"","x","5000","3000","0","0"`);
    expect(r.rows[0].status).toBe('erreur');
    expect(r.rows[0].problem).toContain('inférieur au prix');
  });

  it('n\'importe qu\'une fois un nom répété dans le même fichier', () => {
    const r = parseProductsCsv(
      `${ENTETE}\nRIZ,"","cereal","1200","1500","0","0"\nriz,"","cereal","1300","1600","0","0"`
    );
    expect(r.rows[0].status).toBe('ok');
    expect(r.rows[1].status).toBe('doublon_fichier');
    expect(lignesImportables(r)).toHaveLength(1);
  });

  it('ignore un produit déjà en boutique, et ne touche pas à ses prix', () => {
    const r = parseProductsCsv(
      `${ENTETE}\nRIZ,"","cereal","1200","9999","0","0"`,
      ['riz']
    );
    expect(r.rows[0].status).toBe('deja_present');
    expect(r.rows[0].problem).toContain('ses prix ne bougent pas');
    expect(lignesImportables(r)).toHaveLength(0);
  });

  it('nettoie l\'espace parasite en fin de catégorie', () => {
    // « smartphones » + une espace : c'est exactement ce qui existe en boutique.
    const r = parseProductsCsv(`${ENTETE}\nRIZ,"","smartphones ","1200","1500","0","0"`);
    expect(r.rows[0].category).toBe('smartphones');
  });

  it('retient le numéro de ligne, pour que l\'erreur soit trouvable', () => {
    const r = parseProductsCsv(
      [ENTETE, 'OK,"","cereal","1200","1500","0","0"', ',"","cereal","1200","1500","0","0"'].join('\n')
    );
    expect(r.rows[0].ligne).toBe(2);
    expect(r.rows[1].ligne).toBe(3);
  });

  it('ignore les lignes totalement vides du fichier', () => {
    const r = parseProductsCsv([ENTETE, 'RIZ,"","cereal","1200","1500","0","0"', '', ',,,,,'].join('\n'));
    expect(r.rows).toHaveLength(1);
  });
});

describe('cleNom — la casse et les espaces ne font pas le produit', () => {
  it('ramène deux écritures au même produit', () => {
    expect(cleNom('RIZ')).toBe(cleNom('riz'));
    expect(cleNom('HP 15  fd')).toBe(cleNom('hp 15 fd'));
  });

  it('ignore les accents', () => {
    expect(cleNom('Café')).toBe(cleNom('cafe'));
  });
});
