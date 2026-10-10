import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * L'historique des ventes.
 *
 * On verrouille ce qui trompe un commerçant : une vente à crédit ne doit
 * JAMAIS s'afficher « Espèces » ; une période vide ne doit pas masquer une
 * erreur de réseau ; le retour d'article est proposé hors crédit seulement ;
 * et l'export suit le plan.
 */

const h = vi.hoisted(() => {
  const rpcData: Record<string, unknown> = {};
  const rows: { sales: unknown[] } = { sales: [] };
  const state = { count: 0, salesError: '', plan: 'pro' as 'free' | 'starter' | 'pro' };

  const supabase = {
    rpc: (fn: string) => Promise.resolve({ data: rpcData[fn] ?? [], error: null }),
    from: () => {
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'gte', 'lte', 'order', 'range', 'eq']) b[m] = () => b;
      b.then = (ok: (v: unknown) => unknown) =>
        Promise.resolve({
          data: rows.sales,
          count: state.count,
          error: state.salesError ? { message: state.salesError } : null,
        }).then(ok);
      return b;
    },
  };
  return { rpcData, rows, state, supabase };
});

vi.mock('@/components/providers/SupabaseProvider', () => ({
  useSupabase: () => ({ supabase: h.supabase, plan: h.state.plan, org: { name: 'Ma boutique' } }),
}));
vi.mock('@/components/sales/ReturnSaleModal', () => ({ ReturnSaleModal: () => null }));

import { SalesHistory } from '@/components/sales/SalesHistory';
import { formatCFA } from '@/lib/utils/currency';

const norm = (s: string) => s.replace(/[\u202f\u00a0]/g, ' ');
const rx = (s: string) => new RegExp(`^${norm(s)}$`);

const vente = (over: Record<string, unknown> = {}) => ({
  id: 's1', created_at: '2026-10-10T09:30:00.000Z', total_amount: 1500, amount_received: 1500,
  payment_method: 'cash', client_name: null, settled: false,
  sale_items: [{ id: 'i1', quantity: 2, product_name: 'Riz blanc', subtotal: 1500 }],
  ...over,
});

beforeEach(() => {
  for (const k of Object.keys(h.rpcData)) delete h.rpcData[k];
  h.rows.sales = [];
  h.state.count = 0;
  h.state.salesError = '';
  h.state.plan = 'pro';
});

describe('SalesHistory', () => {
  it('affiche le total de la période et le nombre de transactions', async () => {
    h.rpcData.get_sales_summary = [{ revenue: 15000 }, { revenue: 5000 }];
    h.state.count = 2;
    h.rows.sales = [vente()];
    render(<SalesHistory />);

    await waitFor(() => expect(screen.getByText(rx(formatCFA(20000)))).toBeInTheDocument());
    expect(screen.getByText('2')).toBeInTheDocument(); // transactions
  });

  it('une vente à crédit affiche « Crédit », jamais « Espèces »', async () => {
    h.state.count = 1;
    h.rows.sales = [vente({ payment_method: 'credit', settled: false })];
    render(<SalesHistory />);

    await waitFor(() => expect(screen.getByText('Crédit')).toBeInTheDocument());
    expect(screen.queryByText('Espèces')).toBeNull();
  });

  it('propose le retour d’article sur une vente au comptant', async () => {
    h.state.count = 1;
    h.rows.sales = [vente()];
    render(<SalesHistory />);

    fireEvent.click(await screen.findByRole('button', { name: /Espèces/ }));
    expect(screen.getByRole('button', { name: /Retourner un article/i })).toBeInTheDocument();
  });

  it('ne propose pas de retour sur une vente à crédit', async () => {
    h.state.count = 1;
    h.rows.sales = [vente({ payment_method: 'credit' })];
    render(<SalesHistory />);

    fireEvent.click(await screen.findByRole('button', { name: /Crédit/ }));
    expect(screen.queryByRole('button', { name: /Retourner un article/i })).toBeNull();
  });

  it('affiche l’erreur plutôt que « Aucune vente »', async () => {
    h.state.salesError = 'boom';
    render(<SalesHistory />);

    await waitFor(() => expect(screen.getByText(/Impossible de charger les ventes : boom/)).toBeInTheDocument());
    expect(screen.queryByText(/Aucune vente sur cette période/i)).toBeNull();
  });

  it('réserve l’export au plan qui le permet', async () => {
    h.state.plan = 'free';
    h.state.count = 1;
    h.rows.sales = [vente()];
    render(<SalesHistory />);

    await waitFor(() => expect(screen.getByText(/Export Excel et PDF : plan Starter/)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Excel/i })).toBeNull();
  });
});
