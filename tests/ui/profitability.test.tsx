import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * La rentabilité par produit.
 *
 * On verrouille la lecture qui décide des réapprovisionnements : total et taux
 * de marge calculés sur le coût RÉEL, tri par marge brute décroissante, alerte
 * « sans prix d'achat » (marge comptée 100 % sinon, donc fausse), capital
 * immobilisé, et produit vendu à perte signalé.
 */

const h = vi.hoisted(() => {
  const state = { rows: [] as unknown[], error: '', plan: 'pro' as 'free' | 'starter' | 'pro' };
  const exportMod = { toCSV: vi.fn((rows: unknown[]) => `csv:${rows.length}`), downloadCSV: vi.fn() };
  const supabase = {
    rpc: () => Promise.resolve({ data: state.rows, error: state.error ? { message: state.error } : null }),
  };
  return { state, exportMod, supabase };
});

vi.mock('@/components/providers/SupabaseProvider', () => ({
  useSupabase: () => ({ supabase: h.supabase, plan: h.state.plan }),
}));
vi.mock('@/lib/utils/export', () => h.exportMod);

import { ProfitabilityModule } from '@/components/reports/ProfitabilityModule';
import { formatCFA } from '@/lib/utils/currency';

const norm = (s: string) => s.replace(/[\u202f\u00a0]/g, ' ');
const rx = (s: string) => new RegExp(`^${norm(s)}$`);
const contient = (s: string) => new RegExp(norm(s));

const ligne = (over: Record<string, unknown> = {}) => ({
  id: 'p', name: 'Produit', category: null, unit_cost: 0, unit_price: 0, stock_qty: 0,
  units_sold: 0, revenue: 0, cost_of_goods: 0, gross_profit: 0, margin_pct: null,
  avg_sold_price: null, discount_given: null, units_sold_at_loss: null, ...over,
});

const ROWS = [
  ligne({ id: 'p1', name: 'Riz', unit_cost: 400, unit_price: 500, stock_qty: 10, units_sold: 5, revenue: 2400, cost_of_goods: 2000, gross_profit: 400, margin_pct: 16.7, avg_sold_price: 500 }),
  ligne({ id: 'p2', name: 'Huile', unit_cost: 0, unit_price: 1000, stock_qty: 3, units_sold: 2, revenue: 2000, cost_of_goods: 0, gross_profit: 2000, margin_pct: 100, avg_sold_price: 900, discount_given: 100, units_sold_at_loss: 1 }),
  ligne({ id: 'p3', name: 'Sucre', unit_cost: 300, unit_price: 400, stock_qty: 4, units_sold: 0, revenue: 0, cost_of_goods: 0, gross_profit: 0, margin_pct: null }),
  ligne({ id: 'p4', name: 'Pain', unit_cost: 100, unit_price: 100, stock_qty: 5, units_sold: 3, revenue: 300, cost_of_goods: 288, gross_profit: 12, margin_pct: 4 }),
];

beforeEach(() => {
  h.state.rows = ROWS;
  h.state.error = '';
  h.state.plan = 'pro';
  h.exportMod.toCSV.mockClear();
  h.exportMod.downloadCSV.mockClear();
});

describe('ProfitabilityModule', () => {
  it('affiche la synthèse et trie par marge brute décroissante', async () => {
    render(<ProfitabilityModule />);

    // CA 4 700 · CMV 2 288 · marge 2 412 · taux 51,3 %.
    await waitFor(() => expect(screen.getByText(rx(formatCFA(4700)))).toBeInTheDocument());
    expect(screen.getByText(rx(formatCFA(2288)))).toBeInTheDocument();
    expect(screen.getByText(rx(formatCFA(2412)))).toBeInTheDocument();
    expect(screen.getByText('51.3 %')).toBeInTheDocument();

    // La première ligne du tableau est le produit le plus rentable (Huile).
    const lignes = screen.getAllByRole('row');
    expect(lignes[1].textContent).toContain('Huile');
  });

  it('alerte sur les produits sans prix d’achat (marge faussée)', async () => {
    render(<ProfitabilityModule />);

    await waitFor(() => expect(screen.getByText(/1 produit sans prix d'achat/)).toBeInTheDocument());
    expect(screen.getAllByText(/Huile/).length).toBeGreaterThan(0);
  });

  it('signale le capital immobilisé des produits jamais vendus', async () => {
    render(<ProfitabilityModule />);

    await waitFor(() => expect(screen.getByText(/1 produit jamais vendu/)).toBeInTheDocument());
    // Sucre : 300 × 4 = 1 200 F immobilisés (dans une phrase, pas une cellule).
    expect(screen.getByText(contient(formatCFA(1200)))).toBeInTheDocument();
  });

  it('marque un produit vendu à perte (marge < 10 %)', async () => {
    render(<ProfitabilityModule />);

    await waitFor(() => expect(screen.getByText('Pain')).toBeInTheDocument());
    expect(screen.getByText('4%')).toBeInTheDocument();
    // Prix moyen encaissé différent du catalogue : le marchandage se voit.
    expect(screen.getByText(rx(`moyen ${formatCFA(900)}`))).toBeInTheDocument();
  });

  it('affiche un module indisponible plutôt qu’un écran vide si la fonction manque', async () => {
    h.state.error = 'function get_product_profitability() does not exist';
    render(<ProfitabilityModule />);

    await waitFor(() => expect(screen.getByText(/Module de rentabilité indisponible/)).toBeInTheDocument());
  });

  it('réserve l’export CSV au plan qui le permet', async () => {
    h.state.plan = 'free';
    render(<ProfitabilityModule />);

    await waitFor(() => expect(screen.getByText('Riz')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'CSV' })).toBeNull();
  });

  it('exporte tout le détail en CSV', async () => {
    render(<ProfitabilityModule />);

    fireEvent.click(await screen.findByRole('button', { name: 'CSV' }));

    const lignes = h.exportMod.toCSV.mock.calls[0][0] as unknown[];
    expect(lignes).toHaveLength(4);
    expect(h.exportMod.downloadCSV).toHaveBeenCalledTimes(1);
  });
});
