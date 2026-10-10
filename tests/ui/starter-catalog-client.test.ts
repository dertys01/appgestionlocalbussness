import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Catalogue d'exemple : chargement et retrait.
 *
 * Il ÉCRIT des produits réels dans la boutique. On verrouille : un catalogue
 * déjà présent ne se réécrit pas (sinon doublons), l'ordre de retrait (recettes
 * et options AVANT les produits — clé étrangère), et le repli « archiver » quand
 * un produit a déjà été vendu.
 */

const h = vi.hoisted(() => {
  const state = {
    catalogue: [] as unknown[],
    productSelect: { data: [] as unknown[], error: null as null | { message: string } } as Record<string, unknown>,
    insertProducts: { data: [] as unknown[], error: null as null | { message: string } } as Record<string, unknown>,
    insertModifiers: { error: null as null | { message: string } } as Record<string, unknown>,
    deleteProducts: { data: [] as unknown[], error: null as null | { message: string } } as Record<string, unknown>,
    recipeError: null as null | { message: string },
    archiveError: null as null | { message: string },
  };
  const builder = (table: string) => {
    const ctx = { op: '' };
    const b: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'like', 'neq', 'order', 'limit']) b[m] = () => b;
    b.insert = () => { ctx.op = 'insert'; return b; };
    b.delete = () => { ctx.op = 'delete'; return b; };
    b.in = () => b;
    b.then = (ok: (v: unknown) => unknown) => {
      if (ctx.op === 'insert') {
        return Promise.resolve(table === 'products' ? state.insertProducts : state.insertModifiers).then(ok);
      }
      if (ctx.op === 'delete') {
        return Promise.resolve(table === 'products' ? state.deleteProducts : { error: null }).then(ok);
      }
      return Promise.resolve(table === 'products' ? state.productSelect : { data: null, error: null }).then(ok);
    };
    return b;
  };
  const supabase = {
    from: (t: string) => builder(t),
    rpc: (fn: string) => Promise.resolve(
      fn === 'add_recipe_ingredient' ? { error: state.recipeError } : { error: state.archiveError },
    ),
  };
  return { state, supabase };
});

vi.mock('@/lib/starterCatalog', () => ({
  DEMO_PREFIX: 'DEMO-',
  isDemoSku: (s: unknown) => typeof s === 'string' && s.startsWith('DEMO-'),
  starterSku: (i: number) => `DEMO-${String(i + 1).padStart(2, '0')}`,
  starterCatalog: () => h.state.catalogue,
}));

import { loadStarterCatalog, removeStarterCatalog, hasStarterCatalog } from '@/lib/starterCatalog.client';
import type { SupabaseClient } from '@supabase/supabase-js';

const sb = h.supabase as unknown as SupabaseClient;

beforeEach(() => {
  h.state.catalogue = [];
  h.state.productSelect = { data: [], error: null };
  h.state.insertProducts = { data: [], error: null };
  h.state.insertModifiers = { error: null };
  h.state.deleteProducts = { data: [], error: null };
  h.state.recipeError = null;
  h.state.archiveError = null;
});

describe('loadStarterCatalog', () => {
  it('ne réécrit pas un catalogue déjà présent', async () => {
    h.state.productSelect = { data: [{ id: 'x' }], error: null };
    expect(await loadStarterCatalog(sb, 'o1', 'retail')).toEqual({ charges: 0, recettes: 0, options: 0 });
  });

  it('remonte l’erreur de lecture', async () => {
    h.state.productSelect = { data: null, error: { message: 'boom' } };
    expect(await loadStarterCatalog(sb, 'o1', 'retail')).toEqual({ erreur: 'boom' });
  });

  it('écrit le catalogue, ses recettes et ses options', async () => {
    h.state.catalogue = [
      { name: 'Riz', category: 'Plats', unit: 'portion', priceBuy: 0, priceSell: 2000, stock: 0, minStock: 0,
        recipe: [{ ingredient: 'Huile', quantity: 0.1 }], options: [{ name: 'Double', extra: 1500 }] },
      { name: 'Huile', category: 'Ingrédients', unit: 'L', priceBuy: 900, priceSell: 1200, stock: 5, minStock: 2 },
    ];
    h.state.insertProducts = {
      data: [{ id: 'p1', name: 'Riz', sku: 'DEMO-01' }, { id: 'p2', name: 'Huile', sku: 'DEMO-02' }],
      error: null,
    };
    expect(await loadStarterCatalog(sb, 'o1', 'restaurant')).toEqual({ charges: 2, recettes: 1, options: 1 });
  });

  it('un ingrédient refusé ne fait pas échouer le catalogue', async () => {
    h.state.catalogue = [
      { name: 'Riz', category: 'Plats', unit: 'portion', priceBuy: 0, priceSell: 2000, stock: 0, minStock: 0,
        recipe: [{ ingredient: 'Huile', quantity: 0.1 }] },
      { name: 'Huile', category: 'Ingrédients', unit: 'L', priceBuy: 900, priceSell: 1200, stock: 5, minStock: 2 },
    ];
    h.state.insertProducts = {
      data: [{ id: 'p1', name: 'Riz', sku: 'DEMO-01' }, { id: 'p2', name: 'Huile', sku: 'DEMO-02' }],
      error: null,
    };
    h.state.recipeError = { message: 'cycle' };
    expect(await loadStarterCatalog(sb, 'o1', 'restaurant')).toEqual({ charges: 2, recettes: 0, options: 0 });
  });
});

describe('removeStarterCatalog', () => {
  it('rien à retirer', async () => {
    h.state.productSelect = { data: [], error: null };
    expect(await removeStarterCatalog(sb, 'o1')).toEqual({ supprimes: 0, archives: 0 });
  });

  it('supprime les produits quand c’est possible', async () => {
    h.state.productSelect = { data: [{ id: 'p1' }, { id: 'p2' }], error: null };
    h.state.deleteProducts = { data: [{ id: 'p1' }, { id: 'p2' }], error: null };
    expect(await removeStarterCatalog(sb, 'o1')).toEqual({ supprimes: 2, archives: 0 });
  });

  it('archive (au lieu de supprimer) les produits déjà vendus', async () => {
    h.state.productSelect = { data: [{ id: 'p1' }, { id: 'p2' }], error: null };
    h.state.deleteProducts = { data: null, error: { message: 'foreign key' } };
    expect(await removeStarterCatalog(sb, 'o1')).toEqual({ supprimes: 0, archives: 2 });
  });

  it('remonte l’erreur de lecture', async () => {
    h.state.productSelect = { data: null, error: { message: 'boom' } };
    expect(await removeStarterCatalog(sb, 'o1')).toEqual({ erreur: 'boom' });
  });
});

describe('hasStarterCatalog', () => {
  it('renvoie le compte, 0 sur erreur', async () => {
    h.state.productSelect = { data: null, error: null, count: 3 };
    expect(await hasStarterCatalog(sb, 'o1')).toBe(3);
    h.state.productSelect = { data: null, error: { message: 'x' } };
    expect(await hasStarterCatalog(sb, 'o1')).toBe(0);
  });
});
