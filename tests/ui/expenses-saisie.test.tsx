import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

/**
 * Saisie des charges — le volet « écriture » du module de dépenses.
 *
 * Complète `expenses.test.tsx` (qui verrouille le résultat net) : ici, on tient
 * la saisie et la suppression. Un refus de plan sur la synthèse ne doit PAS
 * empêcher d'enregistrer une charge, et « 50.000 » doit valoir 50 000 (et non 50).
 */

const h = vi.hoisted(() => {
  const state = {
    flow: [] as unknown[],
    flowError: null as null | { message: string },
    expenses: [] as unknown[],
    expensesError: null as null | { message: string },
    categories: [] as unknown[],
    insertError: null as null | { message: string },
    deleteError: null as null | { message: string },
    inserts: [] as Array<Record<string, unknown>>,
    deletes: [] as string[],
    canEdit: true,
  };
  const builder = (table: string) => {
    const ctx = { op: '' };
    const b: Record<string, unknown> = {};
    for (const m of ['select', 'gte', 'lte', 'order', 'limit']) b[m] = () => b;
    b.eq = (col: string, val: unknown) => { if (ctx.op === 'delete' && col === 'id') state.deletes.push(String(val)); return b; };
    b.insert = (p: Record<string, unknown>) => { state.inserts.push(p); return Promise.resolve({ error: state.insertError }); };
    b.delete = () => { ctx.op = 'delete'; return b; };
    b.then = (ok: (v: unknown) => unknown) => {
      if (ctx.op === 'delete') return Promise.resolve({ error: state.deleteError }).then(ok);
      if (table === 'expenses') return Promise.resolve({ data: state.expenses, error: state.expensesError }).then(ok);
      if (table === 'expense_categories') return Promise.resolve({ data: state.categories, error: null }).then(ok);
      return Promise.resolve({ data: null, error: null }).then(ok);
    };
    return b;
  };
  const supabase = {
    from: (t: string) => builder(t),
    rpc: (fn: string) => Promise.resolve(
      fn === 'get_cash_flow' ? { data: state.flowError ? null : state.flow, error: state.flowError } : { data: null, error: null },
    ),
  };
  return { state, supabase };
});

vi.mock('@/components/providers/SupabaseProvider', () => ({
  useSupabase: () => ({
    supabase: h.supabase, canManageProducts: h.state.canEdit, ownerId: 'org-1',
    actorName: 'Patron', user: { id: 'u1', email: 'p@b.c' }, plan: 'pro',
  }),
}));
vi.mock('@/lib/utils/activity', () => ({ logActivity: vi.fn(async () => {}) }));

import { ExpensesModule } from '@/components/reports/ExpensesModule';

const JOUR = { day: '2026-10-01', revenue: 100000, cogs: 40000, expenses: 10000, net: 50000, transactions: 5 };
const DEPENSE = { id: 'e1', category: 'Loyer', label: 'Loyer juin', amount: 10000, day: '2026-10-01', note: null };
const CATEGORIES = [{ id: 'c1', name: 'Loyer', sort_order: 0 }, { id: 'c2', name: 'Transport', sort_order: 1 }];

beforeEach(() => {
  h.state.flow = [JOUR];
  h.state.flowError = null;
  h.state.expenses = [DEPENSE];
  h.state.expensesError = null;
  h.state.categories = CATEGORIES;
  h.state.insertError = null;
  h.state.deleteError = null;
  h.state.inserts = [];
  h.state.deletes = [];
  h.state.canEdit = true;
});

const ouvrirFormulaire = async () =>
  fireEvent.click(await screen.findByRole('button', { name: /Enregistrer une dépense/ }));

describe('ExpensesModule — saisie', () => {
  it('un refus de plan sur la synthèse n’éteint pas la saisie', async () => {
    h.state.flowError = { message: 'La fonctionnalité « rapports » nécessite le plan starter (plan actuel : free).' };
    render(<ExpensesModule />);

    await waitFor(() => expect(screen.getByText(/Synthèse indisponible/)).toBeInTheDocument());
    expect(screen.getByText('Loyer juin')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Enregistrer une dépense/ })).toBeInTheDocument();
  });

  it('avertit quand aucune charge n’est saisie', async () => {
    h.state.expenses = [];
    render(<ExpensesModule />);
    await waitFor(() => expect(screen.getByText(/Aucune charge enregistrée sur la période/)).toBeInTheDocument());
  });

  it('enregistre une dépense — « 50.000 » vaut 50 000, pas 50', async () => {
    render(<ExpensesModule />);
    await ouvrirFormulaire();

    fireEvent.change(screen.getByLabelText('Description'), { target: { value: '  Loyer juillet  ' } });
    fireEvent.change(screen.getByLabelText('Montant (FCFA)'), { target: { value: '50.000' } });
    fireEvent.click(screen.getByRole('button', { name: /Enregistrer la dépense/ }));

    await waitFor(() => expect(h.state.inserts).toHaveLength(1));
    expect(h.state.inserts[0]).toMatchObject({
      user_id: 'org-1', category: 'Loyer', label: 'Loyer juillet', amount: 50000,
    });
  });

  it('refuse un montant nul', async () => {
    render(<ExpensesModule />);
    await ouvrirFormulaire();

    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Loyer' } });
    fireEvent.change(screen.getByLabelText('Montant (FCFA)'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: /Enregistrer la dépense/ }));

    await waitFor(() => expect(screen.getByText('Montant invalide.')).toBeInTheDocument());
    expect(h.state.inserts).toHaveLength(0);
  });

  it('supprime une dépense après confirmation', async () => {
    render(<ExpensesModule />);
    fireEvent.click(await screen.findByTitle('Supprimer'));

    const dialogue = await screen.findByRole('dialog');
    fireEvent.click(within(dialogue).getByRole('button', { name: 'Supprimer' }));

    await waitFor(() => expect(h.state.deletes).toContain('e1'));
  });

  it('un caissier ne peut ni saisir ni supprimer', async () => {
    h.state.canEdit = false;
    render(<ExpensesModule />);

    await waitFor(() => expect(screen.getByText('Loyer juin')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Enregistrer une dépense/ })).toBeNull();
    expect(screen.queryByTitle('Supprimer')).toBeNull();
  });

  it('pagine la liste au-delà de 50 lignes', async () => {
    h.state.expenses = Array.from({ length: 51 }, (_, i) => ({ ...DEPENSE, id: `e${i}`, label: `Charge ${i}` }));
    render(<ExpensesModule />);

    const plus = await screen.findByRole('button', { name: /Afficher plus \(1 restante/ });
    fireEvent.click(plus);
    expect(await screen.findByText('Charge 50')).toBeInTheDocument();
  });
});
