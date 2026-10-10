import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

/**
 * useProducts : le catalogue, et son repli hors-ligne.
 *
 * Le point sensible : quand le réseau est coupé, on sert le DERNIER catalogue
 * connu au lieu d'une caisse vide — sans quoi rouvrir l'app hors-ligne ne
 * permettrait plus de vendre, alors même que la file de rejeu existe.
 *
 * useToday : les chiffres de l'accueil, lus aux mêmes sources que le journal.
 */

const h = vi.hoisted(() => {
  const state = {
    data: [] as unknown[],
    error: null as { message: string } | null,
    network: false,
    cache: null as unknown[] | null,
    user: { id: 'u1' } as { id: string } | null,
    rpc: vi.fn(async (fn: string): Promise<{ data: unknown; error: { message: string } | null }> => { void fn; return { data: [], error: null }; }),
    ecrireCatalogue: vi.fn(async (ownerId: string, data: unknown) => { void ownerId; void data; }),
    lireCatalogue: vi.fn(async () => state.cache),
    fromCalled: 0,
  };
  const builder = () => {
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.order = () => b;
    b.then = (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) => {
      state.fromCalled += 1;
      const p = state.network
        ? Promise.reject(new Error('Failed to fetch'))
        : Promise.resolve({ data: state.data, error: state.error });
      return p.then(ok, err);
    };
    return b;
  };
  const supabase = { from: () => builder(), rpc: state.rpc };
  return { state, supabase };
});

vi.mock('@/components/providers/SupabaseProvider', () => ({
  useSupabase: () => ({ supabase: h.supabase, user: h.state.user, ownerId: 'org-1' }),
}));
vi.mock('@/lib/hooks/useRealtimeRefresh', () => ({ useRealtimeRefresh: () => {} }));
vi.mock('@/lib/offline/catalogue', () => ({
  ecrireCatalogue: (ownerId: string, data: unknown) => h.state.ecrireCatalogue(ownerId, data),
  lireCatalogue: () => h.state.lireCatalogue(),
}));

import { useProducts } from '@/lib/hooks/useProducts';
import { useToday } from '@/lib/hooks/useToday';

const produit = (over: Record<string, unknown> = {}) => ({ id: 'p1', name: 'Riz', ...over });

beforeEach(() => {
  h.state.data = [];
  h.state.error = null;
  h.state.network = false;
  h.state.cache = null;
  h.state.user = { id: 'u1' };
  h.state.fromCalled = 0;
  h.state.rpc.mockReset();
  h.state.rpc.mockImplementation(async () => ({ data: [], error: null }));
  h.state.ecrireCatalogue.mockClear();
  h.state.lireCatalogue.mockClear();
});

describe('useProducts', () => {
  it('charge le catalogue et met le cache local à jour', async () => {
    h.state.data = [produit(), produit({ id: 'p2', name: 'Huile' })];
    const { result } = renderHook(() => useProducts());

    await waitFor(() => expect(result.current.loadingProducts).toBe(false));
    expect(result.current.products).toHaveLength(2);
    expect(h.state.ecrireCatalogue).toHaveBeenCalledWith('org-1', h.state.data);
  });

  it('hors-ligne : sert le dernier catalogue connu au lieu d’une caisse vide', async () => {
    h.state.network = true;
    h.state.cache = [produit({ id: 'cache', name: 'Riz (cache)' })];
    const { result } = renderHook(() => useProducts());

    await waitFor(() => expect(result.current.loadingProducts).toBe(false));
    expect(result.current.products).toEqual(h.state.cache);
    expect(result.current.productsError).toBe('');
  });

  it('sans utilisateur : ne charge rien et garde l’état « en chargement »', async () => {
    h.state.user = null;
    const { result } = renderHook(() => useProducts());

    // Laisse le microtask passer.
    await Promise.resolve();
    expect(h.state.fromCalled).toBe(0);
    expect(result.current.loadingProducts).toBe(true);
  });
});

describe('useToday', () => {
  it('agrège CA, parts, ventes et carnet de dettes', async () => {
    h.state.rpc.mockImplementation(async (fn: string) => {
      if (fn === 'get_sales_summary') {
        return { data: [{ revenue: 15000, cash: 10000, momo: 4000, tx: 3 }], error: null };
      }
      if (fn === 'get_customer_debts') {
        return { data: [{ total_due: 5000 }, { total_due: 3000 }], error: null };
      }
      return { data: [], error: null };
    });

    const { result } = renderHook(() => useToday(true));

    await waitFor(() => expect(result.current.today).not.toBeNull());
    expect(result.current.today).toMatchObject({
      revenue: 15000, cash: 10000, momo: 4000, sales: 3,
      debtTotal: 8000, debtClients: 2,
    });
  });

  it('inactif : ne lit rien', async () => {
    const { result } = renderHook(() => useToday(false));
    await Promise.resolve();
    expect(h.state.rpc).not.toHaveBeenCalled();
    expect(result.current.today).toBeNull();
  });
});
