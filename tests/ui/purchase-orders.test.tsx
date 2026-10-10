import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * Bons de commande fournisseur.
 *
 * On vérifie surtout que la CRÉATION passe par la RPC (jamais un INSERT client
 * — la table est révoquée) et que la RÉCEPTION est proposée sur une commande
 * en attente.
 */
const h = vi.hoisted(() => {
  const rpc = vi.fn();
  const tables: Record<string, unknown[]> = { purchase_orders: [], suppliers: [], purchase_order_items: [] };
  const supabase = {
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      for (const m of ['select', 'order', 'limit', 'in']) q[m] = () => q;
      q.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: tables[table] ?? [], error: null }).then(ok);
      return q;
    },
    rpc,
  };
  return { supabase, rpc, tables };
});

vi.mock('@/components/providers/SupabaseProvider', () => ({
  useSupabase: () => ({ supabase: h.supabase, canManageProducts: true }),
}));

import { PurchaseOrdersModule } from '@/components/purchases/PurchaseOrdersModule';
import type { Product } from '@/types';

const PRODUIT = { id: 'p1', name: 'Riz 5kg', price_sell: 7000, stock_qty: 3, is_active: true } as unknown as Product;

beforeEach(() => {
  h.rpc.mockReset();
  h.tables.purchase_orders = [];
  h.tables.suppliers = [];
  h.tables.purchase_order_items = [];
});

describe('PurchaseOrdersModule', () => {
  it('affiche l’état vide sans commande', async () => {
    render(<PurchaseOrdersModule products={[PRODUIT]} />);
    await waitFor(() => expect(screen.getByText(/Aucune commande/i)).toBeInTheDocument());
  });

  it('crée une commande via la RPC (jamais un INSERT client)', async () => {
    h.rpc.mockResolvedValue({ data: 'o1', error: null });
    render(<PurchaseOrdersModule products={[PRODUIT]} />);
    await waitFor(() => expect(screen.getByText(/Aucune commande/i)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Nouvelle commande/i }));
    fireEvent.change(screen.getByLabelText('Produit ligne 1'), { target: { value: 'p1' } });
    fireEvent.change(screen.getByLabelText('Quantité ligne 1'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Coût unitaire ligne 1'), { target: { value: '80' } });
    fireEvent.click(screen.getByRole('button', { name: /Créer la commande/i }));

    await waitFor(() => expect(h.rpc).toHaveBeenCalledWith('create_purchase_order', expect.objectContaining({
      p_items: [{ product_id: 'p1', quantity: 10, unit_cost: 80 }],
    })));
  });

  it('propose de réceptionner une commande en attente', async () => {
    h.tables.purchase_orders = [{
      id: 'o1', supplier_name: 'Grossiste', status: 'ordered', note: null,
      created_at: '2026-10-10T08:00:00Z', received_at: null,
    }];
    h.tables.purchase_order_items = [{ order_id: 'o1', product_id: 'p1', product_name: 'Riz 5kg', quantity: 10, unit_cost: 80 }];
    h.rpc.mockResolvedValue({ data: true, error: null });

    render(<PurchaseOrdersModule products={[PRODUIT]} />);
    const recevoir = await screen.findByRole('button', { name: /Réceptionner/i });
    fireEvent.click(recevoir);

    await waitFor(() => expect(h.rpc).toHaveBeenCalledWith('receive_purchase_order', { p_order_id: 'o1' }));
  });
});
