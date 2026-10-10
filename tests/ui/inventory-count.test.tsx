import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * Le comptage d'inventaire — l'écran qui écrit vraiment le stock.
 *
 * Trois propriétés tiennent l'argent du commerce :
 *  1. on n'ajuste QUE ce qui a été compté (une ligne laissée vide ne bouge pas) ;
 *  2. on relit le stock réel juste avant d'écrire et on verrouille dessus —
 *     une vente pendant le comptage ne doit pas être écrasée en silence ;
 *  3. chaque ajustement laisse un `stock_logs` avec un écart vrai.
 *
 * Aucun test n'existait : le chemin le plus coûteux à se tromper était le moins
 * couvert.
 */

type Rep = { data: unknown; error: { message: string } | null };

const h = vi.hoisted(() => {
  const state = {
    /** stock renvoyé par la relecture, par id produit */
    fresh: {} as Record<string, number>,
    /** ids dont l'UPDATE ne touche aucune ligne (concurrence) */
    conflits: new Set<string>(),
    /** ids dont l'insertion du stock_log échoue */
    logEnEchec: new Set<string>(),
    updates: [] as Array<{ id: string; payload: Record<string, unknown>; garde: unknown }>,
    logs: [] as Array<Record<string, unknown>>,
  };

  const builder = (table: string) => {
    const ctx = { op: '', payload: undefined as unknown, eqs: [] as [string, unknown][] };

    const id = () => ctx.eqs.find((e) => e[0] === 'id')?.[1] as string;
    const resolveRead = (): Rep =>
      table === 'products'
        ? { data: { stock_qty: state.fresh[id()] ?? 0 }, error: null }
        : { data: null, error: null };
    const resolveUpdate = (): Rep => {
      const p = id();
      state.updates.push({ id: p, payload: ctx.payload as Record<string, unknown>, garde: ctx.eqs.find((e) => e[0] === 'stock_qty')?.[1] });
      return state.conflits.has(p) ? { data: [], error: null } : { data: [{ id: p }], error: null };
    };
    const resolveInsert = (): Rep => {
      if (table === 'stock_logs') {
        state.logs.push(ctx.payload as Record<string, unknown>);
        const p = (ctx.payload as { product_id?: string })?.product_id ?? '';
        return { data: null, error: state.logEnEchec.has(p) ? { message: 'insertion refusée' } : null };
      }
      return { data: null, error: null };
    };

    const b: Record<string, unknown> = {};
    b.select = (cols?: string) => {
      if (ctx.op === 'update') return Promise.resolve(resolveUpdate());
      ctx.op = 'select'; void cols; return b;
    };
    b.update = (payload: unknown) => { ctx.op = 'update'; ctx.payload = payload; return b; };
    b.insert = (payload: unknown) => { ctx.op = 'insert'; ctx.payload = payload; return Promise.resolve(resolveInsert()); };
    b.eq = (col: string, val: unknown) => { ctx.eqs.push([col, val]); return b; };
    b.single = () => Promise.resolve(resolveRead());
    b.then = (ok: (v: Rep) => unknown) => Promise.resolve(resolveRead()).then(ok);
    return b;
  };

  const supabase = {
    from: (table: string) => builder(table),
    auth: { getUser: async () => ({ data: { user: { id: 'u1', email: 'a@b.c' } }, error: null }) },
  };

  return { state, supabase };
});

vi.mock('@/components/providers/SupabaseProvider', () => ({
  useSupabase: () => ({ supabase: h.supabase, ownerId: 'org-1', actorName: 'Compteur' }),
}));
vi.mock('@/lib/utils/activity', () => ({ logActivity: vi.fn(async () => {}) }));
vi.mock('@/components/scanner/BarcodeScanner', () => ({ BarcodeScanner: () => null }));

import { InventoryCount } from '@/components/inventory/InventoryCount';
import type { Product } from '@/types';

function produit(over: Partial<Product> = {}): Product {
  return {
    id: 'p1', user_id: 'org-1', name: 'Riz blanc', sku: 'RIZ-1', price_buy: 400,
    price_sell: 500, stock_qty: 10, min_stock_level: 3, category: 'Céréales',
    unit: 'kg', is_active: true, archived_at: null, supplier_id: null,
    menu_days: null, created_at: '', updated_at: '', ...over,
  };
}

beforeEach(() => {
  h.state.fresh = {};
  h.state.conflits = new Set();
  h.state.logEnEchec = new Set();
  h.state.updates = [];
  h.state.logs = [];
});

const compter = (nom: string, valeur: string) =>
  fireEvent.change(screen.getByLabelText(`Quantité comptée pour ${nom}`), { target: { value: valeur } });

describe('InventoryCount', () => {
  it("n'annonce des différences que si un écart existe", async () => {
    render(<InventoryCount products={[produit()]} onComplete={vi.fn()} />);

    // Compté = stock système : rien à ajuster.
    compter('Riz blanc', '10');
    expect(screen.queryByRole('button', { name: /Confirmer/i })).toBeNull();

    // Compté ≠ stock : la barre de confirmation apparaît.
    compter('Riz blanc', '7');
    expect(screen.getByRole('button', { name: /Confirmer/i })).toBeInTheDocument();
  });

  it('ajuste le stock, trace le mouvement et confirme', async () => {
    h.state.fresh.p1 = 10;
    const onComplete = vi.fn();
    render(<InventoryCount products={[produit()]} onComplete={onComplete} />);

    compter('Riz blanc', '7');
    fireEvent.click(screen.getByRole('button', { name: /Confirmer/i }));
    fireEvent.click(screen.getByRole('button', { name: /Enregistrer/i }));

    await waitFor(() => expect(screen.getByText(/Inventaire enregistré/i)).toBeInTheDocument());

    expect(h.state.updates).toEqual([{ id: 'p1', payload: { stock_qty: 7 }, garde: 10 }]);
    expect(h.state.logs).toEqual([
      expect.objectContaining({
        product_id: 'p1', movement_type: 'adjustment',
        quantity_change: -3, stock_before: 10, stock_after: 7,
      }),
    ]);
  });

  it('relit le stock réel et verrouille dessus, pas sur la valeur affichée', async () => {
    // Une vente a fait passer le stock de 10 (affiché) à 8 (réel) entre le
    // rendu et l'enregistrement. Écrire sur 10 écraserait la vente.
    h.state.fresh.p1 = 8;
    render(<InventoryCount products={[produit()]} onComplete={vi.fn()} />);

    compter('Riz blanc', '7');
    fireEvent.click(screen.getByRole('button', { name: /Confirmer/i }));
    fireEvent.click(screen.getByRole('button', { name: /Enregistrer/i }));

    await waitFor(() => expect(screen.getByText(/Inventaire enregistré/i)).toBeInTheDocument());

    expect(h.state.updates[0].garde).toBe(8);
    expect(h.state.logs[0]).toMatchObject({ stock_before: 8, stock_after: 7, quantity_change: -1 });
  });

  it("n'écrit aucun log et signale la concurrence si le stock a bougé", async () => {
    h.state.fresh.p1 = 10;
    h.state.conflits.add('p1');
    render(<InventoryCount products={[produit()]} onComplete={vi.fn()} />);

    compter('Riz blanc', '7');
    fireEvent.click(screen.getByRole('button', { name: /Confirmer/i }));
    fireEvent.click(screen.getByRole('button', { name: /Enregistrer/i }));

    await waitFor(() => expect(screen.getAllByText(/stock a changé pendant la saisie/i).length).toBeGreaterThan(0));
    expect(h.state.logs).toHaveLength(0);
    expect(screen.queryByText(/Inventaire enregistré/i)).toBeNull();
  });

  it('signale un échec partiel sans annoncer un succès complet', async () => {
    h.state.fresh.p1 = 10;
    h.state.fresh.p2 = 5;
    h.state.logEnEchec.add('p2');
    const p1 = produit();
    const p2 = produit({ id: 'p2', name: 'Huile', sku: 'HUI-1', stock_qty: 5 });
    render(<InventoryCount products={[p1, p2]} onComplete={vi.fn()} />);

    compter('Riz blanc', '7');
    compter('Huile', '2');
    fireEvent.click(screen.getByRole('button', { name: /Confirmer/i }));
    fireEvent.click(screen.getByRole('button', { name: /Enregistrer/i }));

    await waitFor(() => expect(screen.getAllByText(/n'a pas pu être ajusté/i).length).toBeGreaterThan(0));
    expect(screen.queryByText(/Inventaire enregistré/i)).toBeNull();
  });

  it('réinitialise les quantités saisies', async () => {
    render(<InventoryCount products={[produit()]} onComplete={vi.fn()} />);
    compter('Riz blanc', '7');

    fireEvent.click(screen.getByRole('button', { name: /Réinitialiser/i }));

    expect((screen.getByLabelText('Quantité comptée pour Riz blanc') as HTMLInputElement).value).toBe('');
  });
});
