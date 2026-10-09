import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * Vente hors-ligne (P7) — régression.
 *
 * Le premier correctif testait la panne réseau sur le message DÉJÀ traduit par
 * readableSaleError() (« Connexion impossible… »), qui ne contient plus
 * « failed to fetch » : la bascule hors-ligne ne se déclenchait jamais, et la
 * caissière voyait « la vente n'a pas été enregistrée ». Ces tests fixent le
 * comportement : panne réseau → mise en file ; refus métier → erreur.
 */
const { products, from, rpc, mettreEnFile, supabase } = vi.hoisted(() => {
  const produits = [
    { id: 'riz', name: 'RIZ', category: 'cereal', price_buy: 1200, price_sell: 1500, stock_qty: 5, min_stock_level: 1 },
  ];
  const from = vi.fn();
  const rpc = vi.fn();
  const mettreEnFile = vi.fn();
  return {
    products: produits,
    from,
    rpc,
    mettreEnFile,
    supabase: { from, rpc, auth: { getUser: vi.fn() } },
  };
});

vi.mock('@/components/providers/SupabaseProvider', () => ({
  useSupabase: () => ({
    supabase,
    canManageProducts: true,
    ownerId: 'org-1',
    actorName: 'Recette',
    user: { id: 'u1', email: 'a@b.c' },
    plan: 'pro',
    org: { name: 'Boutique Test' },
  }),
}));

vi.mock('@/lib/utils/activity', () => ({ logActivity: vi.fn() }));
vi.mock('@/lib/offline/queue', () => ({ mettreEnFile }));

import { POSModule } from '@/components/pos/POSModule';
import type { Product } from '@/types';

function chaine(donnees: unknown[] = []) {
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'gte', 'lte', 'order', 'eq', 'limit']) {
    q[m] = () => q;
  }
  q.then = (ok: unknown, ko: unknown) =>
    Promise.resolve({ data: donnees, error: null }).then(ok as never, ko as never);
  return q;
}

const renderPOS = () =>
  render(<POSModule products={products as unknown as Product[]} />);

/** Ajoute RIZ au panier puis encaisse. */
async function encaisser() {
  fireEvent.click(screen.getByText('RIZ'));
  fireEvent.click(await screen.findByRole('button', { name: /Encaisser/ }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mettreEnFile.mockResolvedValue(true);
  from.mockImplementation(() => chaine([]));
});

describe('POS — vente hors-ligne', () => {
  it('une panne réseau met la vente en file et affiche le reçu hors-ligne', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'TypeError: Failed to fetch' } });
    renderPOS();
    await encaisser();

    await waitFor(() => expect(screen.getByText(/Vente enregistrée hors-ligne/i)).toBeInTheDocument());
    expect(mettreEnFile).toHaveBeenCalledTimes(1);

    // La vente mise en file porte la référence idempotente, et la même que
    // celle envoyée au serveur : c'est elle qui empêche le doublon au rejeu.
    const vente = mettreEnFile.mock.calls[0][0] as { ref: string; payload: { p_client_ref: string } };
    expect(vente.ref).toBeTruthy();
    expect(vente.payload.p_client_ref).toBe(vente.ref);
  });

  it('un refus métier (stock) reste une erreur, jamais une vente en file', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'Stock insuffisant pour « RIZ » (disponible : 0, demandé : 1)' } });
    renderPOS();
    await encaisser();

    await waitFor(() => expect(screen.getByText(/Stock insuffisant/i)).toBeInTheDocument());
    expect(mettreEnFile).not.toHaveBeenCalled();
  });
});
