import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * Référence idempotente d'une vente (client_ref).
 *
 * Elle doit être unique à chaque appel : c'est elle qui empêche un rejeu
 * hors-ligne de créer une seconde vente. On couvre les deux chemins —
 * `crypto.randomUUID()` et le repli.
 */
import { nouvelleRefVente } from '@/lib/offline/ref';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('nouvelleRefVente', () => {
  it('utilise crypto.randomUUID quand il existe', () => {
    const uuid = '11111111-2222-3333-4444-555555555555';
    vi.stubGlobal('crypto', { randomUUID: () => uuid });
    expect(nouvelleRefVente()).toBe(uuid);
  });

  it('produit des références uniques par le repli sans randomUUID', () => {
    vi.stubGlobal('crypto', {});
    const a = nouvelleRefVente();
    const b = nouvelleRefVente();
    expect(a).toMatch(/^ref-[a-z0-9]+-[a-z0-9]+$/);
    expect(a).not.toBe(b);
  });
});
