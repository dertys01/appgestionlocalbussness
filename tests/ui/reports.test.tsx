import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

/**
 * Les rapports (graphiques).
 *
 * Les agrégats viennent de la base (get_sales_summary / get_top_products). On
 * verrouille : les parts Espèces/MoMo ne comptent PAS les crédits, l'écart non
 * ventilé est annoncé, une erreur réseau se voit, le pluriel des unités est
 * juste, et le panier moyen suit le CA et le nombre de transactions.
 */

// recharts (ResponsiveContainer) s'appuie sur ResizeObserver, absent de jsdom.
class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver ??= ResizeObserverStub;

const h = vi.hoisted(() => {
  const state = {
    summary: [] as unknown[],
    top: [] as unknown[],
    error: '',
    plan: 'pro' as 'free' | 'starter' | 'pro',
  };
  const supabase = {
    rpc: (fn: string) => {
      if (state.error) return Promise.resolve({ data: null, error: { message: state.error } });
      if (fn === 'get_sales_summary') return Promise.resolve({ data: state.summary, error: null });
      if (fn === 'get_top_products') return Promise.resolve({ data: state.top, error: null });
      return Promise.resolve({ data: null, error: null });
    },
  };
  return { state, supabase };
});

vi.mock('@/components/providers/SupabaseProvider', () => ({
  useSupabase: () => ({ supabase: h.supabase, plan: h.state.plan }),
}));

import { ReportsModule } from '@/components/reports/ReportsModule';
import { formatCFA } from '@/lib/utils/currency';

const norm = (s: string) => s.replace(/[\u202f\u00a0]/g, ' ');
const rx = (s: string) => new RegExp(`^${norm(s)}$`);
const contient = (s: string) => new RegExp(norm(s));

beforeEach(() => {
  h.state.summary = [];
  h.state.top = [];
  h.state.error = '';
  h.state.plan = 'pro';
});

describe('ReportsModule', () => {
  it('affiche le CA, les transactions et la ventilation, et n’attribue pas les crédits aux parts', async () => {
    // 15 000 de CA dont 10 000 espèces + 4 000 MoMo : 1 000 viennent d'un
    // règlement de dette ancien, non ventilé. S'ils étaient comptés dans une
    // part, le total des deux dépasserait le CA.
    h.state.summary = [{ day: '2026-10-10', revenue: 15000, cash: 10000, momo: 4000, tx: 3 }];
    render(<ReportsModule />);

    await waitFor(() => expect(screen.getByText(rx(formatCFA(15000)))).toBeInTheDocument());
    expect(screen.getByText(rx(formatCFA(10000)))).toBeInTheDocument();
    expect(screen.getByText(rx(formatCFA(4000)))).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    // Panier moyen : 15 000 / 3 = 5 000.
    expect(screen.getByText(rx(formatCFA(5000)))).toBeInTheDocument();
    // L'écart non ventilé est expliqué, pas masqué.
    expect(screen.getByText(contient(formatCFA(1000)))).toBeInTheDocument();
  });

  it('affiche l’état vide quand la période ne contient rien', async () => {
    h.state.summary = [];
    render(<ReportsModule />);

    await waitFor(() => expect(screen.getByText(/Aucune vente sur cette période/)).toBeInTheDocument());
  });

  it('affiche l’erreur plutôt que des rapports vides', async () => {
    h.state.error = 'boom';
    render(<ReportsModule />);

    await waitFor(() => expect(screen.getByText(/Impossible de charger les rapports : boom/)).toBeInTheDocument());
  });

  it('liste les produits les plus vendus avec le bon pluriel', async () => {
    h.state.top = [{ product_name: 'Riz', qty: 3 }, { product_name: 'Huile', qty: 1 }];
    render(<ReportsModule />);

    await waitFor(() => expect(screen.getByText('Riz')).toBeInTheDocument());
    expect(screen.getByText('3 unités')).toBeInTheDocument();
    expect(screen.getByText('1 unité')).toBeInTheDocument();
  });
});
