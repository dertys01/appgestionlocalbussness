import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * Les deux replis d'accueil : boutique absente (on la crée) et boutique
 * illisible (on ne la recrée surtout pas). Le second point est le vrai piège :
 * un échec de lecture ne doit jamais inviter à créer un second établissement.
 */

const h = vi.hoisted(() => {
  const state = {
    inserts: [] as Array<Record<string, unknown>>,
    insertError: null as { message: string } | null,
    refreshOrg: vi.fn(async () => {}),
    signOut: vi.fn(async () => {}),
  };
  const builder = () => ({
    insert: (p: Record<string, unknown>) => { state.inserts.push(p); return Promise.resolve({ error: state.insertError }); },
  });
  const supabase = { from: () => builder(), auth: { signOut: () => state.signOut() } };
  return { state, supabase };
});

vi.mock('@/components/providers/SupabaseProvider', () => ({
  useSupabase: () => ({ supabase: h.supabase, user: { id: 'u1' }, refreshOrg: h.state.refreshOrg }),
}));

import { OrgSetupRequired } from '@/components/onboarding/OrgSetupRequired';
import { OrgLoadFailed } from '@/components/onboarding/OrgLoadFailed';

beforeEach(() => {
  h.state.inserts = [];
  h.state.insertError = null;
  h.state.refreshOrg.mockClear();
  h.state.signOut.mockClear();
});

describe('OrgSetupRequired', () => {
  it('crée la boutique avec un slug et rafraîchit le contexte', async () => {
    render(<OrgSetupRequired />);

    fireEvent.change(screen.getByLabelText('Nom de la boutique'), { target: { value: 'Ma Boutique' } });
    fireEvent.click(screen.getByRole('button', { name: /Créer ma boutique/ }));

    await waitFor(() => expect(h.state.refreshOrg).toHaveBeenCalledTimes(1));
    const payload = h.state.inserts[0];
    expect(payload).toMatchObject({ id: 'u1', name: 'Ma Boutique', onboarding_done: false });
    expect(String(payload.slug)).toMatch(/^ma-boutique-[a-z0-9]{4}$/);
  });

  it('affiche l’erreur de création et ne rafraîchit pas', async () => {
    h.state.insertError = { message: 'duplicate key' };
    render(<OrgSetupRequired />);

    fireEvent.change(screen.getByLabelText('Nom de la boutique'), { target: { value: 'Ma Boutique' } });
    fireEvent.click(screen.getByRole('button', { name: /Créer ma boutique/ }));

    await waitFor(() => expect(screen.getByText('duplicate key')).toBeInTheDocument());
    expect(h.state.refreshOrg).not.toHaveBeenCalled();
  });

  it('permet de se déconnecter', () => {
    render(<OrgSetupRequired />);
    fireEvent.click(screen.getByRole('button', { name: /Se déconnecter/ }));
    expect(h.state.signOut).toHaveBeenCalledTimes(1);
  });
});

describe('OrgLoadFailed', () => {
  it('affiche l’erreur, propose Réessayer et NE propose PAS de recréer', async () => {
    render(<OrgLoadFailed error="réseau indisponible" />);

    expect(screen.getByText('réseau indisponible')).toBeInTheDocument();
    // Le panneau ne crée jamais de boutique : elle existe déjà.
    expect(screen.queryByRole('button', { name: /Créer/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Réessayer/ }));
    await waitFor(() => expect(h.state.refreshOrg).toHaveBeenCalledTimes(1));
  });

  it('permet de se déconnecter', () => {
    render(<OrgLoadFailed error="x" />);
    fireEvent.click(screen.getByRole('button', { name: /Se déconnecter/ }));
    expect(h.state.signOut).toHaveBeenCalledTimes(1);
  });
});
