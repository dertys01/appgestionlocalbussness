import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * /invitation/[token] — l'employé qui rejoint la boutique.
 *
 * On verrouille la validation avant l'appel réseau (nom, longueur, confirmation),
 * l'acceptation qui connecte immédiatement et redirige, et l'erreur serveur
 * affichée telle quelle.
 */

const h = vi.hoisted(() => {
  const state = {
    fetch: vi.fn(),
    signIn: { error: null as null | { message: string } },
  };
  const createClient = () => ({ auth: { signInWithPassword: async () => state.signIn } });
  return { state, createClient };
});

vi.mock('@/lib/supabase/client', () => ({ createClient: () => h.createClient() }));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

import InvitationPage from '@/app/invitation/[token]/page';

const json = (body: unknown, ok = true, status = 200) => ({ ok, status, json: async () => body });

function rendre() {
  return render(<InvitationPage params={Promise.resolve({ token: 'jeton-abc' })} />);
}

beforeEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, writable: true, value: { href: 'http://localhost/' } });
  h.state.signIn = { error: null };
  h.state.fetch.mockReset();
  h.state.fetch.mockImplementation(async () => json({ email: 'm@b.c' }));
  vi.stubGlobal('fetch', h.state.fetch);
});

async function remplir(valeurs: { nom?: string; mdp?: string; confirm?: string }) {
  if (valeurs.nom !== undefined) fireEvent.change(screen.getByLabelText('Votre nom'), { target: { value: valeurs.nom } });
  if (valeurs.mdp !== undefined) fireEvent.change(screen.getByLabelText('Mot de passe'), { target: { value: valeurs.mdp } });
  if (valeurs.confirm !== undefined) fireEvent.change(screen.getByLabelText('Confirmer'), { target: { value: valeurs.confirm } });
}

describe('/invitation/[token]', () => {
  it('affiche le chargement puis le formulaire (token résolu)', async () => {
    rendre();
    expect(screen.getByText(/Chargement du lien/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Votre nom')).toBeInTheDocument());
  });

  it('exige un nom', async () => {
    rendre();
    await screen.findByLabelText('Votre nom');
    fireEvent.click(screen.getByRole('button', { name: /Rejoindre la boutique/ }));
    expect(screen.getByText('Indiquez votre nom.')).toBeInTheDocument();
    expect(h.state.fetch).not.toHaveBeenCalled();
  });

  it('exige un mot de passe d’au moins 6 caractères', async () => {
    rendre();
    await screen.findByLabelText('Votre nom');
    await remplir({ nom: 'Marie', mdp: '123', confirm: '123' });
    fireEvent.click(screen.getByRole('button', { name: /Rejoindre la boutique/ }));
    expect(screen.getByText(/au moins 6 caractères/)).toBeInTheDocument();
    expect(h.state.fetch).not.toHaveBeenCalled();
  });

  it('exige deux mots de passe identiques', async () => {
    rendre();
    await screen.findByLabelText('Votre nom');
    await remplir({ nom: 'Marie', mdp: 'secret1', confirm: 'secret2' });
    fireEvent.click(screen.getByRole('button', { name: /Rejoindre la boutique/ }));
    expect(screen.getByText(/ne correspondent pas/)).toBeInTheDocument();
    expect(h.state.fetch).not.toHaveBeenCalled();
  });

  it('accepte l’invitation, connecte et redirige', async () => {
    rendre();
    await screen.findByLabelText('Votre nom');
    await remplir({ nom: 'Marie', mdp: 'secret1', confirm: 'secret1' });
    fireEvent.click(screen.getByRole('button', { name: /Rejoindre la boutique/ }));

    await waitFor(() => expect(window.location.href).toBe('/'));
    // Le POST porte bien le jeton et le nom nettoyé.
    const [url, opts] = h.state.fetch.mock.calls[0];
    expect(url).toBe('/api/invitations/accept');
    expect(JSON.parse((opts as RequestInit).body as string)).toEqual({ token: 'jeton-abc', name: 'Marie', password: 'secret1' });
  });

  it('affiche l’erreur renvoyée par le serveur et ne redirige pas', async () => {
    h.state.fetch.mockImplementation(async () => json({ error: 'Jeton expiré' }, false, 410));
    rendre();
    await screen.findByLabelText('Votre nom');
    await remplir({ nom: 'Marie', mdp: 'secret1', confirm: 'secret1' });
    fireEvent.click(screen.getByRole('button', { name: /Rejoindre la boutique/ }));

    await waitFor(() => expect(screen.getByText('Jeton expiré')).toBeInTheDocument());
    expect(window.location.href).toBe('http://localhost/');
  });

  it('bascule l’affichage du mot de passe', async () => {
    rendre();
    await screen.findByLabelText('Mot de passe');
    const champ = screen.getByLabelText('Mot de passe') as HTMLInputElement;
    expect(champ.type).toBe('password');
    fireEvent.click(screen.getByRole('button', { name: 'Afficher le mot de passe' }));
    expect((screen.getByLabelText('Mot de passe') as HTMLInputElement).type).toBe('text');
  });
});
