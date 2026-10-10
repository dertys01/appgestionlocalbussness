import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * Paramètres — branches non couvertes ailleurs (l'essai et l'IFU ont leurs
 * tests) : bascule de domaine et de mode, facturation (Stripe, Mobile Money,
 * portail), et sauvegarde des données.
 */

const h = vi.hoisted(() => {
  const state = {
    org: { id: 'o1', name: 'Chez Koffi', address: null, ifu: null, domain: 'retail', ui_mode: 'full', plan: 'free', trial_started_at: null, trial_ends_at: null, plan_valid_until: null } as Record<string, unknown> | null,
    plan: 'free' as 'free' | 'starter' | 'pro',
    isEmployee: false,
    updates: [] as Array<Record<string, unknown>>,
    updateError: null as null | { message: string },
    refreshOrg: vi.fn(async () => {}),
    fetch: vi.fn(),
    construire: vi.fn(async () => ({ ok: true })),
    telecharger: vi.fn(),
  };
  const supabase = {
    from: () => ({ update: (p: Record<string, unknown>) => { state.updates.push(p); return { eq: () => Promise.resolve({ error: state.updateError }) }; } }),
    rpc: vi.fn(async () => ({ data: null, error: null })),
    auth: { getSession: async () => ({ data: { session: { access_token: 'tok' } } }) },
  };
  return { state, supabase };
});

vi.mock('@/components/providers/SupabaseProvider', () => ({
  useSupabase: () => ({ supabase: h.supabase, org: h.state.org, plan: h.state.plan, refreshOrg: h.state.refreshOrg, user: { email: 'p@b.c' }, isEmployee: h.state.isEmployee }),
}));
vi.mock('@/lib/hooks/useLiaisonMecef', () => ({ useLiaisonMecef: () => false }));
vi.mock('@/lib/utils/sauvegarde', () => ({ construireSauvegarde: h.state.construire, telechargerSauvegarde: h.state.telecharger }));

import { SettingsModule } from '@/components/settings/SettingsModule';

const json = (body: unknown, ok = true, status = 200) => ({ ok, status, json: async () => body });

beforeEach(() => {
  h.state.org = { id: 'o1', name: 'Chez Koffi', address: null, ifu: null, domain: 'retail', ui_mode: 'full', plan: 'free', trial_started_at: null, trial_ends_at: null, plan_valid_until: null };
  h.state.plan = 'free';
  h.state.isEmployee = false;
  h.state.updates = [];
  h.state.updateError = null;
  h.state.refreshOrg.mockClear();
  h.state.construire.mockClear();
  h.state.telecharger.mockClear();
  h.state.fetch.mockReset();
  h.state.fetch.mockImplementation(async () => json({ url: 'https://stripe/x', redirectUrl: 'https://pay/x' }));
  vi.stubGlobal('fetch', h.state.fetch);
  Object.defineProperty(window, 'location', { configurable: true, writable: true, value: { href: 'http://localhost/' } });
});

describe('SettingsModule — domaine et mode', () => {
  it('bascule le domaine vers restaurant et relit la boutique', async () => {
    render(<SettingsModule />);
    fireEvent.click(screen.getByRole('button', { name: /Restaurant \/ Maquis/ }));

    await waitFor(() => expect(h.state.refreshOrg).toHaveBeenCalled());
    expect(h.state.updates).toContainEqual({ domain: 'restaurant' });
  });

  it('ne réécrit rien si on reclique le domaine courant', () => {
    render(<SettingsModule />);
    fireEvent.click(screen.getByRole('button', { name: /Commerce \/ Boutique/ }));
    expect(h.state.updates).toHaveLength(0);
  });

  it('bascule le mode d’affichage', async () => {
    render(<SettingsModule />);
    fireEvent.click(screen.getByRole('button', { name: /Revenir au mode simple/ }));

    await waitFor(() => expect(h.state.refreshOrg).toHaveBeenCalled());
    expect(h.state.updates).toContainEqual({ ui_mode: 'beginner' });
  });

  it('signale une erreur d’écriture de domaine', async () => {
    h.state.updateError = { message: 'RLS refuse' };
    render(<SettingsModule />);
    fireEvent.click(screen.getByRole('button', { name: /Restaurant \/ Maquis/ }));
    await waitFor(() => expect(screen.getByText('RLS refuse')).toBeInTheDocument());
  });
});

describe('SettingsModule — sauvegarde', () => {
  it('télécharge la sauvegarde complète', async () => {
    render(<SettingsModule />);
    fireEvent.click(screen.getByRole('button', { name: /Télécharger la sauvegarde/ }));

    await waitFor(() => expect(h.state.telecharger).toHaveBeenCalledWith({ ok: true }));
    expect(h.state.construire).toHaveBeenCalled();
  });

  it('un employé ne voit pas la sauvegarde', () => {
    h.state.isEmployee = true;
    render(<SettingsModule />);
    expect(screen.queryByRole('button', { name: /Télécharger la sauvegarde/ })).toBeNull();
  });

  it('affiche l’erreur de sauvegarde', async () => {
    h.state.construire.mockRejectedValueOnce(new Error('lecture impossible'));
    render(<SettingsModule />);
    fireEvent.click(screen.getByRole('button', { name: /Télécharger la sauvegarde/ }));
    await waitFor(() => expect(screen.getByText('lecture impossible')).toBeInTheDocument());
  });
});

describe('SettingsModule — facturation', () => {
  it('ouvre Stripe Checkout pour passer au plan supérieur', async () => {
    h.state.plan = 'starter';
    render(<SettingsModule />);
    fireEvent.click(screen.getByRole('tab', { name: /Abonnement/ }));

    fireEvent.click(await screen.findByRole('button', { name: /Passer/ }));
    await waitFor(() => expect(window.location.href).toBe('https://stripe/x'));
    expect(h.state.fetch).toHaveBeenCalledWith('/api/stripe/checkout', expect.objectContaining({ method: 'POST' }));
  });

  it('signale une erreur de facturation au lieu de bloquer', async () => {
    h.state.plan = 'starter';
    h.state.fetch.mockImplementation(async () => json({ error: 'Stripe indisponible' }, false, 500));
    render(<SettingsModule />);
    fireEvent.click(screen.getByRole('tab', { name: /Abonnement/ }));

    fireEvent.click(await screen.findByRole('button', { name: /Passer/ }));
    await waitFor(() => expect(screen.getByText('Stripe indisponible')).toBeInTheDocument());
  });

  it('ouvre le portail Stripe quand un plan est payant', async () => {
    h.state.plan = 'pro';
    render(<SettingsModule />);
    fireEvent.click(screen.getByRole('tab', { name: /Abonnement/ }));

    fireEvent.click(await screen.findByRole('button', { name: /Gérer/ }));
    await waitFor(() => expect(h.state.fetch).toHaveBeenCalledWith('/api/stripe/portal', expect.objectContaining({ method: 'POST' })));
  });

  it('ouvre une page de paiement Mobile Money', async () => {
    render(<SettingsModule />);
    fireEvent.click(screen.getByRole('tab', { name: /Abonnement/ }));

    fireEvent.click(await screen.findByRole('button', { name: /^Starter/ }));
    await waitFor(() => expect(window.location.href).toBe('https://pay/x'));
    const [, opts] = h.state.fetch.mock.calls.find((c) => String(c[0]).includes('/api/payments/order')) as [string, RequestInit];
    expect(JSON.parse(opts.body as string)).toEqual({ plan: 'starter', mois: 1 });
  });
});
