import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';

/**
 * SupabaseProvider — la source du tenant, du rôle et du plan.
 *
 * Trois décisions qu'on ne peut pas se permettre de casser :
 *   1. l'identité : patron vs employé (owner_id, isEmployee, canManageProducts) ;
 *   2. hors-ligne : un getUser() en échec RÉSEAU ne déconnecte pas — sinon la
 *      caisse devient inutilisable alors même que le mode hors-ligne existe ;
 *   3. lecture d'org : un échec RÉSEAU sert le cache ; un AUTRE échec est
 *      signalé (orgError) sans jamais prétendre que la boutique n'existe pas.
 */

const h = vi.hoisted(() => {
  const state = {
    getUser: { data: { user: null as null | { id: string; email?: string } }, error: null as null | { message: string; status?: number; name?: string } },
    getSession: { data: { session: null as null | { user: { id: string; email?: string } } }, error: null },
    orgRead: { data: null as null | Record<string, unknown>, error: null as null | { message: string } },
    memberRead: { data: null as null | Record<string, unknown>, error: null as null | { message: string } },
    cacheBoutique: null as null | Record<string, unknown>,
    cacheMembre: null as null | Record<string, unknown>,
    orgUpdates: [] as Array<Record<string, unknown>>,
    logs: [] as Array<Record<string, unknown>>,
    authCb: null as null | ((event: string, session: { user?: { id: string; email?: string } } | null) => void),
    signOut: vi.fn(async () => ({})),
    unsubscribe: vi.fn(),
  };
  const builder = (table: string) => {
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = () => b;
    b.maybeSingle = () => {
      if (table === 'organizations') return Promise.resolve(state.orgRead);
      if (table === 'business_members') return Promise.resolve(state.memberRead);
      return Promise.resolve({ data: null, error: null });
    };
    b.insert = (p: Record<string, unknown>) => { if (table === 'activity_logs') state.logs.push(p); return Promise.resolve({ error: null }); };
    b.update = (p: Record<string, unknown>) => { if (table === 'organizations') state.orgUpdates.push(p); return b; };
    b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(ok);
    return b;
  };
  const client = {
    auth: {
      getUser: () => Promise.resolve(state.getUser),
      getSession: () => Promise.resolve(state.getSession),
      onAuthStateChange: (cb: (event: string, session: { user?: { id: string; email?: string } } | null) => void) => {
        state.authCb = cb;
        return { data: { subscription: { unsubscribe: state.unsubscribe } } };
      },
      signOut: () => state.signOut(),
    },
    from: (t: string) => builder(t),
  };
  return { state, client };
});

vi.mock('@/lib/supabase/client', () => ({ createClient: () => h.client }));
vi.mock('@/lib/pwa/installation', () => ({ modeOuverture: () => 'tab' }));
vi.mock('@/lib/offline/catalogue', () => ({
  ecrireBoutique: vi.fn(async () => {}),
  lireBoutique: async () => h.state.cacheBoutique,
  ecrireMembre: vi.fn(async () => {}),
  lireMembre: async () => h.state.cacheMembre,
}));

import { SupabaseProvider, useSupabase } from '@/components/providers/SupabaseProvider';

function Sonde() {
  const c = useSupabase();
  return (
    <div>
      <span data-testid="user">{c.user?.id ?? 'null'}</span>
      <span data-testid="owner">{c.ownerId ?? 'null'}</span>
      <span data-testid="employee">{String(c.isEmployee)}</span>
      <span data-testid="manage">{String(c.canManageProducts)}</span>
      <span data-testid="org">{c.org?.name ?? 'null'}</span>
      <span data-testid="plan">{c.plan}</span>
      <span data-testid="orgError">{c.orgError ?? 'null'}</span>
      <span data-testid="loading">{String(c.loading)}</span>
    </div>
  );
}

const rendu = () => render(<SupabaseProvider><Sonde /></SupabaseProvider>);
const lire = (id: string) => screen.getByTestId(id).textContent;

const prets = () => waitFor(() => expect(lire('loading')).toBe('false'));

function org(over: Record<string, unknown> = {}) {
  return { id: 'u1', name: 'Chez Koffi', plan: 'pro', trial_ends_at: null, plan_valid_until: null, ...over };
}

beforeEach(() => {
  h.state.getUser = { data: { user: { id: 'u1', email: 'p@b.c' } }, error: null };
  h.state.getSession = { data: { session: null }, error: null };
  h.state.orgRead = { data: org(), error: null };
  h.state.memberRead = { data: null, error: null };
  h.state.cacheBoutique = null;
  h.state.cacheMembre = null;
  h.state.orgUpdates = [];
  h.state.logs = [];
  h.state.authCb = null;
  h.state.signOut.mockClear();
  h.state.unsubscribe.mockClear();
});

describe('SupabaseProvider', () => {
  it('patron connecté : propriétaire, plan de l’org, gestion du catalogue', async () => {
    rendu();
    await prets();
    expect(lire('user')).toBe('u1');
    expect(lire('owner')).toBe('u1');
    expect(lire('employee')).toBe('false');
    expect(lire('manage')).toBe('true');
    expect(lire('org')).toBe('Chez Koffi');
    expect(lire('plan')).toBe('pro');
    expect(lire('orgError')).toBe('null');
  });

  it('essai actif : le plan brut « free » devient « starter »', async () => {
    h.state.orgRead = { data: org({ plan: 'free', trial_ends_at: '2099-01-01T00:00:00Z' }), error: null };
    rendu();
    await prets();
    expect(lire('plan')).toBe('starter');
  });

  it('manager : rattaché au patron, peut gérer le catalogue', async () => {
    h.state.memberRead = { data: { owner_id: 'owner-9', member_name: 'Marie', role: 'manager' }, error: null };
    h.state.orgRead = { data: org({ id: 'owner-9' }), error: null };
    rendu();
    await prets();
    expect(lire('owner')).toBe('owner-9');
    expect(lire('employee')).toBe('true');
    expect(lire('manage')).toBe('true');
  });

  it('caissier : rattaché mais SANS droit d’écriture catalogue', async () => {
    h.state.memberRead = { data: { owner_id: 'owner-9', member_name: 'Awa', role: 'employee' }, error: null };
    h.state.orgRead = { data: org({ id: 'owner-9' }), error: null };
    rendu();
    await prets();
    expect(lire('owner')).toBe('owner-9');
    expect(lire('employee')).toBe('true');
    expect(lire('manage')).toBe('false');
  });

  it('getUser en échec RÉSEAU : ne déconnecte pas, reprend la session locale', async () => {
    h.state.getUser = { data: { user: null }, error: { message: 'fetch failed', status: 0, name: 'AuthRetryableFetchError' } };
    h.state.getSession = { data: { session: { user: { id: 'u1', email: 'p@b.c' } } }, error: null };
    rendu();
    await prets();
    expect(lire('user')).toBe('u1');
    expect(lire('owner')).toBe('u1');
    expect(h.state.signOut).not.toHaveBeenCalled();
  });

  it('session invalide (jeton révoqué) : purge et déconnexion propre', async () => {
    h.state.getUser = { data: { user: null }, error: { message: 'invalid JWT', status: 401 } };
    rendu();
    await prets();
    expect(lire('user')).toBe('null');
    expect(lire('owner')).toBe('null');
    expect(h.state.signOut).toHaveBeenCalledTimes(1);
  });

  it('org en échec RÉSEAU : sert la boutique en cache', async () => {
    h.state.orgRead = { data: null, error: { message: 'Failed to fetch' } };
    h.state.cacheBoutique = org({ name: 'Chez Koffi (cache)', plan: 'starter' });
    rendu();
    await prets();
    expect(lire('org')).toBe('Chez Koffi (cache)');
    expect(lire('orgError')).toBe('null');
  });

  it('org en échec hors réseau : signalé, sans prétendre que la boutique n’existe pas', async () => {
    h.state.orgRead = { data: null, error: { message: 'permission denied' } };
    rendu();
    await prets();
    expect(lire('org')).toBe('null');
    expect(lire('orgError')).toBe('permission denied');
  });

  it('SIGNED_OUT : vide la session', async () => {
    rendu();
    await prets();
    expect(lire('user')).toBe('u1');

    act(() => { h.state.authCb?.('SIGNED_OUT', null); });
    await waitFor(() => expect(lire('user')).toBe('null'));
    expect(lire('owner')).toBe('null');
    expect(lire('manage')).toBe('false');
  });

  it('useSupabase hors du provider lève', () => {
    expect(() => render(<Sonde />)).toThrow(/doit être utilisé dans/);
  });
});
