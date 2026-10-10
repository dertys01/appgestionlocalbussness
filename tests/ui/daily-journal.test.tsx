import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * Le journal du jour — la page ouverte chaque soir.
 *
 * Trois sources, dont une refusable selon le plan (`get_cash_flow`). On
 * verrouille surtout : l'écran ne s'éteint pas quand la marge est verrouillée,
 * il n'appelle même pas la fonction interdite ; la navigation change bien le
 * jour ; une vente à crédit partiellement réglée montre le reste dû.
 */

const h = vi.hoisted(() => {
  const rpcCalls: Array<{ fn: string; args: unknown }> = [];
  const rpcData: Record<string, unknown> = {};
  const rpcError: Record<string, string> = {};
  const rows: Record<string, unknown[]> = { sales: [], expenses: [] };
  const fromError: Record<string, string> = {};
  const session: { plan: 'free' | 'starter' | 'pro' } = { plan: 'pro' };

  const supabase = {
    rpc: (fn: string, args: unknown) => {
      rpcCalls.push({ fn, args });
      if (rpcError[fn]) return Promise.resolve({ data: null, error: { message: rpcError[fn] } });
      return Promise.resolve({ data: rpcData[fn] ?? [], error: null });
    },
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'gte', 'lte', 'eq', 'order']) b[m] = () => b;
      b.then = (ok: (v: unknown) => unknown) =>
        Promise.resolve({
          data: rows[table] ?? [],
          error: fromError[table] ? { message: fromError[table] } : null,
        }).then(ok);
      return b;
    },
  };
  return { rpcCalls, rpcData, rpcError, rows, fromError, session, supabase };
});

vi.mock('@/components/providers/SupabaseProvider', () => ({
  useSupabase: () => ({ supabase: h.supabase, plan: h.session.plan }),
}));

import { DailyJournal } from '@/components/sales/DailyJournal';
import { formatCFA } from '@/lib/utils/currency';

// formatCFA groupe les milliers avec une espace fine insécable (U+202F) ;
// le normaliseur de Testing Library la ramène à une espace ordinaire. On
// construit donc les motifs sur la version normalisée.
const norm = (s: string) => s.replace(/[\u202f\u00a0]/g, ' ');
/** Correspondance EXACTE (une valeur seule dans sa cellule). */
const rx = (s: string) => new RegExp(`^${norm(s)}$`);
/** Présence en sous-chaîne (ligne composite « Reçu … reste … »). */
const contient = (s: string) => new RegExp(norm(s));

const vente = (over: Record<string, unknown> = {}) => ({
  id: 's1', total_amount: 1500, amount_received: 1500, payment_method: 'cash',
  client_name: null, settled: false, created_at: '2026-10-10T09:30:00.000Z',
  sale_items: [{ id: 'i1', quantity: 2, product_name: 'Riz blanc', subtotal: 1000 }],
  ...over,
});

beforeEach(() => {
  h.rpcCalls.length = 0;
  // Vider SANS réassigner : les closures du mock lisent ces objets capturés.
  for (const k of Object.keys(h.rpcData)) delete h.rpcData[k];
  for (const k of Object.keys(h.rpcError)) delete h.rpcError[k];
  for (const k of Object.keys(h.fromError)) delete h.fromError[k];
  h.rows.sales = [];
  h.rows.expenses = [];
  h.session.plan = 'pro';
});

describe('DailyJournal', () => {
  it('affiche le CA, la ventilation et la marge (plan Pro)', async () => {
    h.rpcData.get_sales_summary = [{ day: 'x', revenue: 15000, cash: 10000, momo: 5000, tx: 3 }];
    h.rpcData.get_cash_flow = [{ day: 'x', revenue: 15000, cogs: 6000, expenses: 2000, net: 7000, transactions: 3 }];
    render(<DailyJournal />);

    await waitFor(() => expect(screen.getByText(rx(formatCFA(15000)))).toBeInTheDocument());
    // Espèces et MoMo sont sur la même ligne.
    expect(screen.getByText(
      (c) => c === `Espèces ${norm(formatCFA(10000))} · MoMo ${norm(formatCFA(5000))}`,
    )).toBeInTheDocument();
    expect(screen.getByText('Marge brute')).toBeInTheDocument();
    expect(screen.getByText(rx(formatCFA(9000)))).toBeInTheDocument(); // 15 000 − 6 000
    expect(screen.getByText('Résultat net')).toBeInTheDocument();
    expect(screen.getByText(rx(formatCFA(7000)))).toBeInTheDocument();
    expect(screen.getByText(/60 % du CA/)).toBeInTheDocument();
  });

  it('plan Gratuit : pas de marge, et la base n’est pas interrogée pour le cash-flow', async () => {
    h.session.plan = 'free';
    h.rpcData.get_sales_summary = [{ day: 'x', revenue: 15000, cash: 10000, momo: 5000, tx: 3 }];
    render(<DailyJournal />);

    await waitFor(() => expect(screen.getByText('Ventes')).toBeInTheDocument());
    expect(screen.queryByText('Marge brute')).toBeNull();
    expect(screen.queryByText('Résultat net')).toBeNull();
    // On ne demande pas une fonction que le plan refuse.
    expect(h.rpcCalls.some((c) => c.fn === 'get_cash_flow')).toBe(false);
    expect(screen.getByText(/inclus à partir du plan Starter/i)).toBeInTheDocument();
  });

  it('un refus de cash-flow n’éteint pas le journal', async () => {
    h.rpcData.get_sales_summary = [{ day: 'x', revenue: 15000, cash: 10000, momo: 5000, tx: 3 }];
    h.rpcError.get_cash_flow = 'La fonctionnalité « rapports » nécessite le plan starter (plan actuel : free).';
    render(<DailyJournal />);

    // Le CA reste affiché…
    await waitFor(() => expect(screen.getByText(rx(formatCFA(15000)))).toBeInTheDocument());
    // …la marge est un tiret, avec la raison.
    expect(screen.getByText(/nécessite le plan Starter/i)).toBeInTheDocument();
  });

  it('signale une erreur de chargement des ventes', async () => {
    h.fromError.sales = 'boom';
    h.rpcData.get_sales_summary = [];
    render(<DailyJournal />);

    await waitFor(() => expect(screen.getByText(/Impossible de charger le journal : boom/)).toBeInTheDocument());
  });

  it('déplie une vente et montre ses articles', async () => {
    h.rows.sales = [vente()];
    render(<DailyJournal />);

    const ligne = await screen.findByRole('button', { name: /1 article/ });
    // La ligne repliée ne montre pas l'article.
    expect(screen.queryByText(/2 × Riz blanc/)).toBeNull();
    fireEvent.click(ligne);
    expect(screen.getByText(/2 × Riz blanc/)).toBeInTheDocument();
  });

  it('affiche le reste dû d’une vente à crédit', async () => {
    h.rows.sales = [vente({ payment_method: 'credit', total_amount: 130000, amount_received: 50000 })];
    render(<DailyJournal />);

    fireEvent.click(await screen.findByRole('button', { name: /Crédit/ }));
    expect(screen.getByText(/reste/)).toBeInTheDocument();
    expect(screen.getByText(contient(formatCFA(80000)))).toBeInTheDocument();
  });

  it('navigue vers le jour précédent', async () => {
    h.rpcData.get_sales_summary = [];
    render(<DailyJournal />);

    // Aujourd'hui : pas de bouton « Aujourd'hui », et « Jour suivant » bloqué.
    await waitFor(() => expect(screen.getByLabelText('Jour suivant')).toBeDisabled());
    expect(screen.queryByRole('button', { name: /Aujourd/ })).toBeNull();

    fireEvent.click(screen.getByLabelText('Jour précédent'));

    await waitFor(() => expect(screen.getByRole('button', { name: /Aujourd/ })).toBeInTheDocument());
    expect(screen.getByLabelText('Jour suivant')).not.toBeDisabled();
    // Un nouveau chargement est déclenché (nouvelle date).
    expect(h.rpcCalls.filter((c) => c.fn === 'get_sales_summary').length).toBeGreaterThan(1);
  });
});
