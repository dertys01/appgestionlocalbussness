import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * Session de caisse (P — fond, clôture, écart).
 *
 * L'attendu et l'écart sont calculés en base ; le composant ne fait que les
 * afficher et déclencher les RPC. On vérifie donc les trois états : aucune
 * caisse, caisse ouverte, et le résumé après clôture.
 */
const h = vi.hoisted(() => {
  const rpc = vi.fn();
  // Objet STABLE : le vrai provider mémoïse `supabase`. Un objet recréé à
  // chaque rendu relancerait l'effet de chargement en boucle.
  const supabase = { from: () => builder(), rpc };
  return { supabase, rpc, etat: { ouverte: null as unknown, hist: [] as unknown[] } };
});

function builder() {
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'is', 'not', 'order', 'limit']) q[m] = () => q;
  q.maybeSingle = () => Promise.resolve({ data: h.etat.ouverte, error: null });
  q.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: h.etat.hist, error: null }).then(ok);
  return q;
}

vi.mock('@/components/providers/SupabaseProvider', () => ({
  useSupabase: () => ({ supabase: h.supabase }),
}));

import { CashSessionCard } from '@/components/cash/CashSessionCard';

const SESSION_OUVERTE = {
  id: 's1', opened_at: '2026-10-10T08:00:00Z', opening_float: 5000,
  closed_at: null, counted_cash: null, expected_cash: null, difference: null, note: null,
};

beforeEach(() => {
  h.etat = { ouverte: null, hist: [] };
  h.rpc.mockReset();
});

describe('CashSessionCard', () => {
  it('propose d’ouvrir quand aucune caisse n’est ouverte', async () => {
    render(<CashSessionCard />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Ouvrir la caisse/i })).toBeInTheDocument());
  });

  it('propose de clôturer quand une caisse est ouverte', async () => {
    h.etat.ouverte = SESSION_OUVERTE;
    render(<CashSessionCard />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Clôturer la caisse/i })).toBeInTheDocument());
    expect(screen.getByText(/Ouverte depuis/i)).toBeInTheDocument();
  });

  it('affiche l’écart renvoyé par la base après clôture', async () => {
    h.etat.ouverte = SESSION_OUVERTE;
    h.rpc.mockResolvedValue({
      data: { ...SESSION_OUVERTE, closed_at: '2026-10-10T18:00:00Z', expected_cash: 7000, counted_cash: 6900, difference: -100 },
      error: null,
    });
    render(<CashSessionCard />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Clôturer la caisse/i })).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Montant compté en caisse'), { target: { value: '6900' } });
    fireEvent.click(screen.getByRole('button', { name: /Clôturer la caisse/i }));

    await waitFor(() => expect(screen.getByText(/Caisse clôturée/i)).toBeInTheDocument());
    expect(h.rpc).toHaveBeenCalledWith('close_cash_session', expect.objectContaining({ p_counted_cash: 6900 }));
    // L'écart est affiché (négatif ici).
    expect(screen.getByText(/Écart/i)).toBeInTheDocument();
  });
});
