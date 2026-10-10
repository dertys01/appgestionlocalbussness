import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * Page de paiement Mobile Money (bac à sable).
 *
 * Le montant vient de la BASE (réponse de /api/payments/order), jamais de
 * l'URL — on ne paie pas ce que l'URL prétend. La confirmation n'existe que sur
 * une commande « pending », et passe par le seul point d'activation.
 */

const h = vi.hoisted(() => {
  const state = {
    getSession: { data: { session: { access_token: 'tok' } as null | { access_token: string } } },
    fetch: vi.fn(),
  };
  const supabase = { auth: { getSession: async () => state.getSession } };
  return { state, supabase };
});

vi.mock('@/components/providers/SupabaseProvider', () => ({ useSupabase: () => ({ supabase: h.supabase }) }));
vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));

import PaiementSandboxPage from '@/app/paiement/sandbox/[ref]/page';
import { formatCFA } from '@/lib/utils/currency';

const norm = (s: string) => s.replace(/[\u202f\u00a0]/g, ' ');
const rx = (s: string) => new RegExp(`^${norm(s)}$`);
const json = (body: unknown, ok = true, status = 200) => ({ ok, status, json: async () => body });

const COMMANDE = { reference: 'REF-1', plan: 'pro', period_months: 3, amount: 20000, status: 'pending' };

const rendre = () => render(<PaiementSandboxPage params={Promise.resolve({ ref: 'REF-1' })} />);

beforeEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, writable: true, value: { href: 'http://localhost/paiement' } });
  h.state.getSession = { data: { session: { access_token: 'tok' } } };
  h.state.fetch.mockReset();
  h.state.fetch.mockImplementation(async (url: string) =>
    String(url).includes('/api/payments/order') ? json(COMMANDE) : json({ success: true }));
  vi.stubGlobal('fetch', h.state.fetch);
});

describe('/paiement/sandbox/[ref]', () => {
  it('charge la commande et affiche le montant venu de la base', async () => {
    rendre();

    await waitFor(() => expect(screen.getByText(rx(formatCFA(20000)))).toBeInTheDocument());
    expect(screen.getByText('3 mois')).toBeInTheDocument();
    expect(screen.getByText('En attente de confirmation')).toBeInTheDocument();
  });

  it('confirme le paiement puis revient à l’application', async () => {
    rendre();
    fireEvent.click(await screen.findByRole('button', { name: /Confirmer le paiement/ }));

    await waitFor(() => expect(window.location.href).toBe('/'));
    const [url, opts] = h.state.fetch.mock.calls.find((c) => String(c[0]).includes('callback')) as [string, RequestInit];
    expect(url).toBe('/api/payments/callback/sandbox');
    expect(JSON.parse(opts.body as string)).toEqual({ reference: 'REF-1' });
  });

  it('n’affiche pas le bouton de confirmation sur une commande déjà payée', async () => {
    h.state.fetch.mockImplementation(async (url: string) =>
      String(url).includes('/api/payments/order') ? json({ ...COMMANDE, status: 'paid' }) : json({}));
    rendre();

    await waitFor(() => expect(screen.getByText(/déjà active/)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Confirmer le paiement/ })).toBeNull();
  });

  it('signale une commande expirée', async () => {
    h.state.fetch.mockImplementation(async (url: string) =>
      String(url).includes('/api/payments/order') ? json({ ...COMMANDE, status: 'expired' }) : json({}));
    rendre();

    await waitFor(() => expect(screen.getByText(/n’est plus valable/)).toBeInTheDocument());
  });

  it('affiche l’erreur serveur au lieu d’un écran vide', async () => {
    h.state.fetch.mockImplementation(async (url: string) =>
      String(url).includes('/api/payments/order') ? json({ error: 'Commande introuvable' }, false, 404) : json({}));
    rendre();

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Commande introuvable'));
  });

  it('réseau indisponible : message', async () => {
    h.state.fetch.mockImplementation(async () => { throw new Error('offline'); });
    rendre();

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Réseau indisponible.'));
  });
});
