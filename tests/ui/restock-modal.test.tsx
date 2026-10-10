import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * Réapprovisionnement d'un produit.
 *
 * On verrouille le verrou optimiste : on relit le stock réel, on incrémente
 * dessus, et si quelqu'un a modifié entre-temps (0 ligne touchée), on N'ÉCRIT
 * PAS de stock_logs et on ne dit pas « succès ». « 1,5 » doit être accepté
 * (stock NUMERIC(12,3)).
 */

const h = vi.hoisted(() => {
  const state = {
    fresh: 10,
    conflit: false,
    logs: [] as Array<Record<string, unknown>>,
    updates: [] as Array<{ payload: Record<string, unknown>; garde: unknown }>,
    onSaved: vi.fn(),
    onClose: vi.fn(),
  };
  const builder = (table: string) => {
    const ctx = { op: '', payload: undefined as unknown, eqs: [] as [string, unknown][] };
    const b: Record<string, unknown> = {};
    b.select = () => {
      if (ctx.op === 'update') {
        const garde = ctx.eqs.find((e) => e[0] === 'stock_qty')?.[1];
        state.updates.push({ payload: ctx.payload as Record<string, unknown>, garde });
        return Promise.resolve({ data: state.conflit ? [] : [{ id: 'p1' }], error: null });
      }
      ctx.op = 'select';
      return b;
    };
    b.eq = (c: string, v: unknown) => { ctx.eqs.push([c, v]); return b; };
    b.update = (p: Record<string, unknown>) => { ctx.op = 'update'; ctx.payload = p; return b; };
    b.insert = (p: Record<string, unknown>) => { if (table === 'stock_logs') state.logs.push(p); return Promise.resolve({ error: null }); };
    b.single = () => Promise.resolve({ data: { stock_qty: state.fresh }, error: null });
    b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: { stock_qty: state.fresh }, error: null }).then(ok);
    return b;
  };
  const supabase = {
    from: (t: string) => builder(t),
    auth: { getUser: async () => ({ data: { user: { id: 'u1', email: 'p@b.c' } }, error: null }) },
  };
  return { state, supabase };
});

vi.mock('@/components/providers/SupabaseProvider', () => ({
  useSupabase: () => ({ supabase: h.supabase, ownerId: 'org-1', actorName: 'Patron' }),
}));
vi.mock('@/lib/utils/activity', () => ({ logActivity: vi.fn(async () => {}) }));

import { RestockModal } from '@/components/products/RestockModal';
import type { Product } from '@/types';

const produit = (over: Partial<Product> = {}): Product => ({
  id: 'p1', user_id: 'org-1', name: 'Riz blanc', sku: 'RIZ-1', price_buy: 400,
  price_sell: 500, stock_qty: 10, min_stock_level: 3, category: 'Céréales',
  unit: 'kg', is_active: true, archived_at: null, supplier_id: null,
  menu_days: null, created_at: '', updated_at: '', ...over,
});

const rendu = (over: Partial<Product> = {}, initialQty?: number) =>
  render(<RestockModal product={produit(over)} initialQty={initialQty} onClose={h.state.onClose} onSaved={h.state.onSaved} />);

beforeEach(() => {
  h.state.fresh = 10;
  h.state.conflit = false;
  h.state.logs = [];
  h.state.updates = [];
  h.state.onSaved.mockClear();
  h.state.onClose.mockClear();
});

describe('RestockModal', () => {
  it('affiche le stock actuel et l’aperçu du nouveau stock', () => {
    rendu();
    expect(screen.getByText(/Stock actuel/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Quantité à ajouter/), { target: { value: '5' } });
    expect(screen.getByText(/Nouveau stock : 15 kg/)).toBeInTheDocument();
  });

  it('pré-remplit la quantité (prévisions)', () => {
    rendu({}, 3);
    expect((screen.getByLabelText(/Quantité à ajouter/) as HTMLInputElement).value).toBe('3');
    expect(screen.getByText(/Nouveau stock : 13 kg/)).toBeInTheDocument();
  });

  it('refuse une quantité nulle', () => {
    rendu();
    fireEvent.change(screen.getByLabelText(/Quantité à ajouter/), { target: { value: '0' } });
    // « 0 » viole min=0.001 : la validation HTML bloque le clic, on soumet
    // directement pour exercer le contrôle applicatif.
    fireEvent.submit(screen.getByLabelText(/Quantité à ajouter/).closest('form') as HTMLFormElement);

    expect(screen.getByText('Quantité invalide.')).toBeInTheDocument();
    expect(h.state.updates).toHaveLength(0);
  });

  it('incrémente le stock frais, trace le mouvement et ferme', async () => {
    rendu();
    fireEvent.change(screen.getByLabelText(/Quantité à ajouter/), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: /Ajouter au stock/ }));

    await waitFor(() => expect(h.state.onSaved).toHaveBeenCalled());
    expect(h.state.updates[0]).toEqual({ payload: { stock_qty: 15 }, garde: 10 });
    expect(h.state.logs[0]).toMatchObject({
      movement_type: 'restock', quantity_change: 5, stock_before: 10, stock_after: 15,
    });
    expect(h.state.onClose).toHaveBeenCalled();
  });

  it('accepte une quantité décimale (1,5 kg)', async () => {
    rendu();
    // Le champ est de type number : « 1,5 » y est refusé, on saisit « 1.5 ».
    fireEvent.change(screen.getByLabelText(/Quantité à ajouter/), { target: { value: '1.5' } });
    fireEvent.click(screen.getByRole('button', { name: /Ajouter au stock/ }));

    await waitFor(() => expect(h.state.onSaved).toHaveBeenCalled());
    expect(h.state.updates[0].payload).toEqual({ stock_qty: 11.5 });
  });

  it('concurrence : n’écrit aucun log et ne dit pas succès', async () => {
    h.state.conflit = true;
    rendu();
    fireEvent.change(screen.getByLabelText(/Quantité à ajouter/), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: /Ajouter au stock/ }));

    await waitFor(() => expect(screen.getByText(/stock a changé pendant la saisie/i)).toBeInTheDocument());
    expect(h.state.logs).toHaveLength(0);
    expect(h.state.onSaved).not.toHaveBeenCalled();
  });
});
