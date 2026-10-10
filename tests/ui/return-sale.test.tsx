import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * Retour d'une vente comptoir.
 *
 * On vérifie que le retour passe par la RPC (la table est révoquée au client),
 * avec les bonnes lignes, et que le montant rendu est affiché.
 */
const h = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock('@/components/providers/SupabaseProvider', () => ({
  useSupabase: () => ({ supabase: { rpc: h.rpc } }),
}));

import { ReturnSaleModal } from '@/components/sales/ReturnSaleModal';

const VENTE = {
  id: 'v1',
  payment_method: 'cash',
  sale_items: [
    { id: 'l1', product_id: 'p1', product_name: 'Riz 5kg', quantity: 2, unit_price: 1000 },
  ],
};

beforeEach(() => h.rpc.mockReset());

describe('ReturnSaleModal', () => {
  it('envoie le retour via la RPC et affiche le montant rendu', async () => {
    h.rpc.mockResolvedValue({ data: { return_id: 'r1', amount: 1000 }, error: null });
    render(<ReturnSaleModal vente={VENTE} onClose={vi.fn()} onDone={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Quantité retournée Riz 5kg'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: /Valider le retour/i }));

    await waitFor(() => expect(h.rpc).toHaveBeenCalledWith('return_sale', {
      p_sale_id: 'v1',
      p_items: [{ product_id: 'p1', quantity: 1 }],
      p_note: null,
    }));
    await waitFor(() => expect(screen.getByText(/Montant rendu/i)).toBeInTheDocument());
  });

  it('refuse une quantité supérieure au vendu sans appeler la RPC', async () => {
    render(<ReturnSaleModal vente={VENTE} onClose={vi.fn()} onDone={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Quantité retournée Riz 5kg'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: /Valider le retour/i }));

    await waitFor(() => expect(screen.getByText(/Trop pour/i)).toBeInTheDocument());
    expect(h.rpc).not.toHaveBeenCalled();
  });
});
