import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

/**
 * Rejeu des ventes hors-ligne (P7).
 *
 * Deux invariants : une vente rejouée avec succès QUITTE la file (et déclenche
 * le rafraîchissement) ; une vente REFUSÉE y RESTE — jamais avalée en silence.
 * Le rejeu part au retour du réseau (`online`).
 */

const h = vi.hoisted(() => {
  const rpcImpl = async (
    fn: string,
    payload: unknown,
  ): Promise<{ data: unknown; error: { message: string } | null }> => {
    void fn; void payload;
    return { data: null, error: null };
  };
  const state = {
    file: [] as Array<{ ref: string; fn?: string; payload: Record<string, unknown> }>,
    compteur: 0,
    retires: [] as string[],
    rpc: vi.fn(rpcImpl),
    compter: vi.fn(async () => state.compteur),
    retirer: vi.fn(async (ref: string) => { state.retires.push(ref); }),
  };
  return state;
});

vi.mock('@/components/providers/SupabaseProvider', () => ({
  useSupabase: () => ({ supabase: { rpc: h.rpc }, ownerId: 'org-1' }),
}));
vi.mock('@/lib/offline/queue', () => ({
  EVENEMENT_FILE_HORS_LIGNE: 'file-hors-ligne-test',
  compterFile: () => h.compter(),
  lireFile: async () => h.file,
  retirerDeFile: (ref: string) => h.retirer(ref),
}));

import { useOfflineSync } from '@/lib/hooks/useOfflineSync';

beforeEach(() => {
  h.file = [];
  h.compteur = 0;
  h.retires = [];
  h.compter.mockClear();
  h.retirer.mockClear();
  h.rpc.mockReset();
  h.rpc.mockImplementation(async () => ({ data: null, error: null }));
});

afterEach(() => {
  // Rien à nettoyer entre fichiers : les écouteurs sont retirés au démontage.
});

describe('useOfflineSync', () => {
  it('compte la file au montage', async () => {
    h.compteur = 3;
    const { result } = renderHook(() => useOfflineSync());
    await waitFor(() => expect(result.current.enAttente).toBe(3));
  });

  it('rejoue les ventes au retour du réseau et retire celles qui passent', async () => {
    h.compteur = 2;
    h.file = [
      { ref: 'r1', payload: { client_ref: 'r1' } },
      { ref: 'r2', fn: 'record_credit_sale', payload: { client_ref: 'r2' } },
    ];
    const onRejoue = vi.fn();
    const { result } = renderHook(() => useOfflineSync(onRejoue));
    await waitFor(() => expect(result.current.enAttente).toBe(2));

    // Les deux rejouent : create_sale par défaut, record_credit_sale si précisé.
    h.compteur = 0;
    await act(async () => { window.dispatchEvent(new Event('online')); });

    await waitFor(() => expect(h.retirer).toHaveBeenCalledTimes(2));
    expect(h.rpc).toHaveBeenCalledWith('create_sale', { client_ref: 'r1' });
    expect(h.rpc).toHaveBeenCalledWith('record_credit_sale', { client_ref: 'r2' });
    expect(h.retires).toEqual(['r1', 'r2']);
    expect(onRejoue).toHaveBeenCalledTimes(1);
  });

  it('laisse en file une vente refusée (jamais avalée)', async () => {
    h.compteur = 2;
    h.file = [
      { ref: 'ok', payload: {} },
      { ref: 'refus', payload: {} },
    ];
    h.rpc.mockImplementation(async (fn: string, payload: unknown) => {
      void fn;
      return (payload as { refus?: boolean }).refus
        ? { data: null, error: { message: 'stock insuffisant' } }
        : { data: null, error: null };
    });
    // On marque le second pour qu'il échoue.
    h.file[1].payload = { refus: true };

    const onRejoue = vi.fn();
    const { result } = renderHook(() => useOfflineSync(onRejoue));
    await waitFor(() => expect(result.current.enAttente).toBe(2));

    h.compteur = 1; // reste 1 en file
    await act(async () => { window.dispatchEvent(new Event('online')); });

    await waitFor(() => expect(h.retirer).toHaveBeenCalledTimes(1));
    expect(h.retires).toEqual(['ok']); // 'refus' reste dans la file
    expect(onRejoue).toHaveBeenCalledTimes(1); // au moins une a été rejouée
  });

  it('ne rejoue rien quand la file est vide', async () => {
    const onRejoue = vi.fn();
    renderHook(() => useOfflineSync(onRejoue));
    await waitFor(() => expect(h.compter).toHaveBeenCalled());

    await act(async () => { window.dispatchEvent(new Event('online')); });
    expect(h.rpc).not.toHaveBeenCalled();
    expect(onRejoue).not.toHaveBeenCalled();
  });
});
