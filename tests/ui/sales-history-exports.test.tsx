import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * Historique des ventes — export et pagination.
 *
 * L'export part de TOUTE la période, pas des 20 lignes affichées : exporter la
 * page en la présentant comme la période serait un export tronqué en silence.
 * Et une fenêtre PDF bloquée doit le dire, pas disparaître.
 */

const h = vi.hoisted(() => {
  const state = {
    rows: [] as unknown[],
    count: 0,
    plan: 'pro' as 'free' | 'starter' | 'pro',
    toCSV: vi.fn((rows: unknown[]) => `csv:${rows.length}`),
    downloadCSV: vi.fn(),
    imprimerRapport: vi.fn(() => true),
    rpcData: { get_sales_summary: [] as unknown[] },
  };
  const supabase = {
    rpc: (fn: string) => Promise.resolve({ data: state.rpcData[fn as 'get_sales_summary'] ?? [], error: null }),
    from: () => {
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'gte', 'lte', 'order', 'range', 'eq']) b[m] = () => b;
      b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: state.rows, count: state.count, error: null }).then(ok);
      return b;
    },
  };
  return { state, supabase };
});

vi.mock('@/components/providers/SupabaseProvider', () => ({ useSupabase: () => ({ supabase: h.supabase, plan: h.state.plan, org: { name: 'Ma boutique' } }) }));
vi.mock('@/components/sales/ReturnSaleModal', () => ({ ReturnSaleModal: () => null }));
vi.mock('@/lib/utils/export', () => ({ toCSV: h.state.toCSV, downloadCSV: h.state.downloadCSV }));
vi.mock('@/lib/utils/rapport', () => ({ imprimerRapport: h.state.imprimerRapport }));

import { SalesHistory } from '@/components/sales/SalesHistory';

const vente = (over: Record<string, unknown> = {}) => ({
  id: 's1', created_at: '2026-10-10T09:30:00.000Z', total_amount: 1500, amount_received: 1500,
  payment_method: 'cash', client_name: null, settled: false,
  sale_items: [{ id: 'i1', quantity: 2, product_name: 'Riz blanc', subtotal: 1500 }],
  ...over,
});

beforeEach(() => {
  h.state.rows = [vente()];
  h.state.count = 1;
  h.state.plan = 'pro';
  h.state.rpcData.get_sales_summary = [{ revenue: 1500 }];
  h.state.toCSV.mockClear();
  h.state.downloadCSV.mockClear();
  h.state.imprimerRapport.mockReset();
  h.state.imprimerRapport.mockReturnValue(true);
});

describe('SalesHistory — export', () => {
  it('exporte la période ENTIÈRE en Excel (pas seulement la page)', async () => {
    // 25 ventes sur la période, 20 affichées : l'export doit partir des 25.
    h.state.count = 25;
    h.state.rows = Array.from({ length: 25 }, (_, i) => vente({ id: `s${i}` }));
    render(<SalesHistory />);

    fireEvent.click(await screen.findByRole('button', { name: /Excel/ }));

    await waitFor(() => expect(h.state.downloadCSV).toHaveBeenCalledTimes(1));
    expect(h.state.toCSV.mock.calls[0][0]).toHaveLength(25);
    expect(h.state.downloadCSV.mock.calls[0][1]).toMatch(/^ventes-.*\.csv$/);
  });

  it('exporte un PDF et n’affiche pas d’erreur quand la fenêtre s’ouvre', async () => {
    render(<SalesHistory />);
    fireEvent.click(await screen.findByRole('button', { name: /PDF/ }));

    await waitFor(() => expect(h.state.imprimerRapport).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/a bloqué la fenêtre/)).toBeNull();
  });

  it('signale une fenêtre PDF bloquée', async () => {
    h.state.imprimerRapport.mockReturnValue(false);
    render(<SalesHistory />);
    fireEvent.click(await screen.findByRole('button', { name: /PDF/ }));

    await waitFor(() => expect(screen.getByText(/a bloqué la fenêtre/)).toBeInTheDocument());
  });
});

describe('SalesHistory — pagination', () => {
  it('pagine au-delà de vingt ventes', async () => {
    h.state.count = 25;
    h.state.rows = Array.from({ length: 20 }, (_, i) => vente({ id: `s${i}` }));
    render(<SalesHistory />);

    expect(await screen.findByText('1 / 2')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Page suivante'));
    await waitFor(() => expect(screen.getByText('2 / 2')).toBeInTheDocument());
  });
});
