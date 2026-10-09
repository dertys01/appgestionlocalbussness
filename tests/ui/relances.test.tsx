import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DebtsModule } from '@/components/debts/DebtsModule';
import { Sidebar } from '@/components/layout/Sidebar';
import type { NavItem } from '@/types';
import { Handshake } from 'lucide-react';

/**
 * P6 — relances automatiques, rappel au commerçant (calcul en direct).
 *
 * L'évaluation §7 tranche : la relance manuelle est sur tous les plans, le
 * rappel programmé est Starter et Pro. Trois choses à tenir :
 *   1. gratuit : pas de section « À relancer », le bouton manuel reste et
 *      journalise quand même (l'historique servira à l'upgrade) ;
 *   2. starter : la section liste les candidats, un tap ouvre WhatsApp AVANT
 *      de journaliser, la carte disparaît ;
 *   3. la pastille de navigation porte le même nombre que la section.
 *
 * window.open est espionné : le test prouve l'ordre (fenêtre ouverte même
 * si le log n'a pas encore répondu), pas seulement l'appel RPC.
 */

let planCourant: 'free' | 'starter' | 'pro' = 'starter';
const rpc = vi.fn();

vi.mock('@/components/providers/SupabaseProvider', () => ({
  useSupabase: () => ({
    supabase: { rpc },
    canManageProducts: true,
    plan: planCourant,
    org: { id: 'o1', name: 'Chez Koffi' },
  }),
}));

const DETTE = {
  debt_id: 'd1',
  phone: '22997000001',
  name: 'Awa',
  total_paid: 0,
  total_due: 5000,
  last_sale_at: '2026-09-20T00:00:00Z',
  sales_count: 1,
  oldest_sale_at: '2026-09-20T00:00:00Z',
  payments_count: 0,
  last_payment_at: null,
};

const CANDIDAT = {
  debt_id: 'd1',
  phone: '22997000001',
  name: 'Awa',
  total_due: 5000,
  total_paid: 0,
  oldest_sale_at: '2026-09-20T00:00:00Z',
  jours: 12,
  last_reminded_at: null,
};

function itemsPastille(n?: number): NavItem[] {
  return [{
    key: 'debts', label: 'Dettes', icon: Handshake, locked: false,
    ...(n !== undefined ? { badge: n } : {}),
  }];
}

const sidebarProps = {
  tab: 'debts' as const,
  email: 'a@b.c',
  loadingProducts: false,
  open: true,
  onClose: () => {},
  onTab: () => {},
  onScan: () => {},
  onRefresh: () => {},
  onSignOut: () => {},
};

beforeEach(() => {
  planCourant = 'starter';
  rpc.mockReset();
  rpc.mockImplementation((fn: string) => {
    if (fn === 'get_customer_debts') return Promise.resolve({ data: [DETTE], error: null });
    if (fn === 'dettes_a_relancer') return Promise.resolve({ data: [CANDIDAT], error: null });
    if (fn === 'marquer_relance') return Promise.resolve({ data: true, error: null });
    return Promise.resolve({ data: null, error: null });
  });
  vi.spyOn(window, 'open').mockReturnValue(null);
});

describe('P6 — section À relancer', () => {
  it('starter : la section liste le candidat avec son âge', async () => {
    render(<DebtsModule />);
    expect(await screen.findByText(/À relancer \(1\)/)).toBeTruthy();
    expect(screen.getByText(/depuis 12 jours/)).toBeTruthy();
    expect(rpc).toHaveBeenCalledWith('dettes_a_relancer');
  });

  it('gratuit : pas de section, pas d’appel de détection — le manuel reste', async () => {
    planCourant = 'free';
    render(<DebtsModule />);
    await screen.findByText('Awa');
    expect(screen.queryByText(/À relancer/)).toBeNull();
    expect(rpc).not.toHaveBeenCalledWith('dettes_a_relancer');
    // Le bouton manuel est toujours là.
    expect(screen.getAllByRole('button', { name: /Relancer/ }).length).toBeGreaterThanOrEqual(1);
  });

  it('tap Relancer : WhatsApp s’ouvre puis le log part, la carte disparaît', async () => {
    const ouvertures: string[][] = [];
    (window.open as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (...args: string[]) => { ouvertures.push(args); return null; },
    );
    // Log lent : prouve que la fenêtre ne l'attend pas.
    let resoudreLog!: (v: unknown) => void;
    rpc.mockImplementation((fn: string) => {
      if (fn === 'get_customer_debts') return Promise.resolve({ data: [DETTE], error: null });
      if (fn === 'dettes_a_relancer') return Promise.resolve({ data: [CANDIDAT], error: null });
      if (fn === 'marquer_relance')
        return new Promise((res) => { resoudreLog = res; });
      return Promise.resolve({ data: null, error: null });
    });
    render(<DebtsModule />);
    // Deux « Relancer » coexistent (carte de rappel + fiche manuelle) :
    // le premier du DOM est celui de la section.
    const boutons = await screen.findAllByRole('button', { name: /Relancer/ });
    fireEvent.click(boutons[0]);
    // Fenêtre ouverte AVANT la résolution du log.
    expect(ouvertures.length).toBe(1);
    expect(decodeURIComponent(ouvertures[0][0])).toContain('wa.me/');
    expect(rpc).toHaveBeenCalledWith('marquer_relance', { p_debt_id: 'd1' });
    resoudreLog({ data: true, error: null });
    await waitFor(() =>
      expect(screen.queryByText(/À relancer \(1\)/)).toBeNull(),
    );
  });

  it('tap manuel en gratuit : le log part aussi (historique pour l’upgrade)', async () => {
    planCourant = 'free';
    render(<DebtsModule />);
    fireEvent.click((await screen.findAllByRole('button', { name: /Relancer/ }))[0]);
    expect(window.open).toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith('marquer_relance', { p_debt_id: 'd1' });
  });
});

describe('P6 — pastille de navigation', () => {
  it('affiche le nombre quand il est non nul, avec un libellé accessible', () => {
    render(<Sidebar {...sidebarProps} items={itemsPastille(3)} />);
    const pastille = screen.getByLabelText(/3 dettes à relancer/);
    expect(pastille.textContent).toBe('3');
  });

  it('absente sans badge, et jamais à zéro', () => {
    const { rerender } = render(<Sidebar {...sidebarProps} items={itemsPastille()} />);
    expect(screen.queryByLabelText(/à relancer/)).toBeNull();
    rerender(<Sidebar {...sidebarProps} items={itemsPastille(0)} />);
    expect(screen.queryByLabelText(/à relancer/)).toBeNull();
  });
});
