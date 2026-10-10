import { describe, it, expect } from 'vitest';
import { lireMontant, lireEntier } from '@/lib/utils/nombres';

/**
 * Lecture des montants — le cœur de la saisie prix/quantité.
 *
 * Deux bugs historiques sont nés d'une lecture approximative : « 520.000 » lu
 * comme 520, et « 1.200,50 » lu comme 1,2005. Ces cas sont donc figés ici.
 */
describe('lireMontant', () => {
  it('lit les milliers écrits au point ou à l’espace', () => {
    expect(lireMontant('520.000')).toBe(520000);
    expect(lireMontant('1 349 400')).toBe(1349400);
    expect(lireMontant('15000')).toBe(15000);
  });

  it('lit la virgule décimale, seule ou après des milliers', () => {
    expect(lireMontant('1200,50')).toBe(1200.5);
    expect(lireMontant('1.200,50')).toBe(1200.5);
    expect(lireMontant('1200.5')).toBe(1200.5);
    expect(lireMontant('15000.00')).toBe(15000);
  });

  it('comprend les suffixes k et m', () => {
    expect(lireMontant('110k')).toBe(110000);
    expect(lireMontant('2m')).toBe(2000000);
  });

  it('vide → 0, illisible → null (zéro ≠ « rien lu »)', () => {
    expect(lireMontant('')).toBe(0);
    expect(lireMontant('abc')).toBeNull();
    expect(lireMontant('-')).toBeNull();
  });
});

describe('lireEntier', () => {
  it('accepte les trois écritures de milliers', () => {
    expect(lireEntier('150000')).toBe(150000);
    expect(lireEntier('150 000')).toBe(150000);
    expect(lireEntier('150.000')).toBe(150000);
  });

  it('refuse ce qui n’est pas un entier de prix', () => {
    expect(lireEntier('1200.5')).toBeNull();
    expect(lireEntier('a17')).toBeNull();
    expect(lireEntier('')).toBeNull();
  });
});
