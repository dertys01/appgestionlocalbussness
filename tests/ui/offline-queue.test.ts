import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  mettreEnFile,
  lireFile,
  retirerDeFile,
  compterFile,
  fileDisponible,
} from '@/lib/offline/queue';
import { nouvelleRefVente } from '@/lib/offline/ref';

/**
 * File d'attente hors-ligne (P7).
 *
 * `fake-indexeddb` fournit un IndexedDB en mémoire : on exerce le vrai code de
 * la file (ouverture, tri, remplacement), pas seulement le repli « pas de
 * stockage ».
 */
describe('file hors-ligne', () => {
  beforeEach(async () => {
    for (const v of await lireFile()) await retirerDeFile(v.ref);
  });

  it('IndexedDB est disponible sous fake-indexeddb', () => {
    expect(fileDisponible()).toBe(true);
  });

  it('ajoute, compte, lit puis retire une vente', async () => {
    const ref = nouvelleRefVente();
    expect(await mettreEnFile({ ref, cree: Date.now(), payload: { p_items: [] } })).toBe(true);
    expect(await compterFile()).toBe(1);
    expect((await lireFile())[0].ref).toBe(ref);
    await retirerDeFile(ref);
    expect(await compterFile()).toBe(0);
  });

  it('rend les ventes de la plus ancienne à la plus récente', async () => {
    await mettreEnFile({ ref: 'b', cree: 2, payload: {} });
    await mettreEnFile({ ref: 'a', cree: 1, payload: {} });
    expect((await lireFile()).map((v) => v.ref)).toEqual(['a', 'b']);
  });

  it('remplace une vente de même référence (pas de doublon local)', async () => {
    await mettreEnFile({ ref: 'x', cree: 1, payload: { n: 1 } });
    await mettreEnFile({ ref: 'x', cree: 2, payload: { n: 2 } });
    const file = await lireFile();
    expect(file.filter((v) => v.ref === 'x')).toHaveLength(1);
    expect((file[0].payload as { n: number }).n).toBe(2);
  });
});

describe('nouvelleRefVente', () => {
  it('génère des références uniques', () => {
    const refs = new Set(Array.from({ length: 50 }, () => nouvelleRefVente()));
    expect(refs.size).toBe(50);
  });

  it('produit une chaîne non vide', () => {
    expect(nouvelleRefVente().length).toBeGreaterThan(8);
  });
});
