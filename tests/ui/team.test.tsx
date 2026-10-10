import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * L'écran Équipe — rôles, invitations, journal.
 *
 * Un employé ne doit JAMAIS voir la liste d'équipe (ni déclencher l'appel API
 * correspondant) : il n'a que le journal. Le patron, lui, invite (dans la
 * limite du plan), change les rôles, retire un membre, et journalise.
 */

const h = vi.hoisted(() => {
  const state = {
    isEmployee: false,
    plan: 'starter' as 'free' | 'starter' | 'pro',
    members: [] as Array<Record<string, unknown>>,
    invitations: [] as Array<Record<string, unknown>>,
    logs: [] as Array<Record<string, unknown>>,
    inviteResponse: { url: 'https://app.test/invitation/abc' } as Record<string, unknown>,
    fetch: vi.fn(),
  };
  const builder = () => {
    const b: Record<string, unknown> = {};
    for (const m of ['select', 'order', 'range', 'eq']) b[m] = () => b;
    b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: state.logs, error: null }).then(ok);
    return b;
  };
  const supabase = {
    from: () => builder(),
    auth: { getSession: async () => ({ data: { session: { access_token: 'tok' } } }) },
  };
  return { state, supabase };
});

vi.mock('@/components/providers/SupabaseProvider', () => ({
  useSupabase: () => ({
    supabase: h.supabase,
    user: { id: 'u1', email: 'patron@b.c' },
    isEmployee: h.state.isEmployee,
    plan: h.state.plan,
  }),
}));

import { TeamModule } from '@/components/team/TeamModule';

const MEMBRE = { id: 'm1', member_id: 'u2', member_name: 'Marie', role: 'employee', created_at: '' };
const INVITATION = { id: 'inv1', email: 'awa@b.c', role: 'employee', created_at: '', expires_at: '2099-01-01T00:00:00Z' };
const LOG = { id: 'l1', actor_name: 'Patron', actor_email: 'p@b.c', action: 'sale', description: 'Vente de 1 500 F', created_at: '2026-10-10T09:00:00Z' };

const json = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => body });

beforeEach(() => {
  h.state.isEmployee = false;
  h.state.plan = 'starter';
  h.state.members = [];
  h.state.invitations = [];
  h.state.logs = [];
  h.state.inviteResponse = { url: 'https://app.test/invitation/abc' };
  h.state.fetch.mockReset();
  h.state.fetch.mockImplementation(async (url: string, opts?: RequestInit) => {
    const u = String(url);
    const method = opts?.method ?? 'GET';
    if (u.includes('/api/employees') && method === 'DELETE') return json({ success: true });
    if (u.includes('/api/employees') && method === 'PATCH') return json({ success: true });
    if (u.includes('/api/employees')) return json({ members: h.state.members });
    if (u.includes('/api/invitations') && method === 'DELETE') return json({ success: true });
    if (u.includes('/api/invitations') && method === 'POST') return json(h.state.inviteResponse);
    if (u.includes('/api/invitations')) return json({ invitations: h.state.invitations });
    return json({});
  });
  vi.stubGlobal('fetch', h.state.fetch);
});

describe('TeamModule', () => {
  it('un employé ne voit que le journal et n’appelle pas la liste d’équipe', async () => {
    h.state.isEmployee = true;
    h.state.logs = [LOG];
    render(<TeamModule />);

    await waitFor(() => expect(screen.getByText('Vente de 1 500 F')).toBeInTheDocument());
    // Aucun panneau d'invitation, aucun appel /api/employees.
    expect(screen.queryByText(/Inviter un employé/)).toBeNull();
    const appels = h.state.fetch.mock.calls.map((c) => String(c[0]));
    expect(appels.some((u) => u.includes('/api/employees'))).toBe(false);
  });

  it('le patron voit son équipe et ses invitations en attente', async () => {
    h.state.members = [MEMBRE];
    h.state.invitations = [INVITATION];
    render(<TeamModule />);

    await waitFor(() => expect(screen.getByText('Marie')).toBeInTheDocument());
    expect(screen.getByText(/Invitations en attente \(1\)/)).toBeInTheDocument();
    expect(screen.getByText('awa@b.c')).toBeInTheDocument();
  });

  it('refuse une invitation au-delà du quota du plan', async () => {
    h.state.plan = 'free';
    render(<TeamModule />);

    fireEvent.change(screen.getByLabelText(/Adresse email de l'employé/), { target: { value: 'new@b.c' } });
    fireEvent.click(screen.getByRole('button', { name: /Générer le lien/ }));

    await waitFor(() => expect(screen.getByText(/n'autorise pas d'employé/i)).toBeInTheDocument());
    const posts = h.state.fetch.mock.calls.filter((c) => (c[1] as RequestInit)?.method === 'POST');
    expect(posts).toHaveLength(0);
  });

  it('génère un lien d’invitation exploitable', async () => {
    render(<TeamModule />);

    fireEvent.change(screen.getByLabelText(/Adresse email de l'employé/), { target: { value: 'new@b.c' } });
    fireEvent.click(screen.getByRole('button', { name: /Générer le lien/ }));

    await waitFor(() => expect(screen.getByText('https://app.test/invitation/abc')).toBeInTheDocument());
    expect(screen.getByText(/Lien prêt/)).toBeInTheDocument();
  });

  it('change le rôle d’un membre (PATCH)', async () => {
    h.state.members = [MEMBRE];
    render(<TeamModule />);

    fireEvent.change(await screen.findByLabelText('Rôle de Marie'), { target: { value: 'manager' } });

    await waitFor(() => {
      const patch = h.state.fetch.mock.calls.find((c) => (c[1] as RequestInit)?.method === 'PATCH');
      expect(patch?.[0]).toContain('/api/employees/u2');
    });
  });

  it('retire un membre après confirmation (DELETE)', async () => {
    h.state.members = [MEMBRE];
    render(<TeamModule />);

    fireEvent.click(await screen.findByLabelText("Retirer Marie de l'équipe"));
    // Confirmation inline avant l'écriture.
    expect(screen.getByText(/Retirer Marie de l'équipe|Retirer/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Confirmer' }));

    await waitFor(() => {
      const del = h.state.fetch.mock.calls.find((c) => (c[1] as RequestInit)?.method === 'DELETE');
      expect(del?.[0]).toContain('/api/employees/u2');
    });
  });

  it('le journal charge d’abord 50 lignes et propose la suite', async () => {
    h.state.isEmployee = true;
    h.state.logs = Array.from({ length: 51 }, (_, i) => ({ ...LOG, id: `l${i}` }));
    render(<TeamModule />);

    await waitFor(() => expect(screen.getByText(/50 actions chargées/)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Charger plus/ })).toBeInTheDocument();
  });
});
