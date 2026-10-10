import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

/**
 * /reset-password — nouveau mot de passe après un lien de récupération.
 *
 * Point sensible : on n'ouvre le formulaire QUE sur preuve de récupération
 * (événement PASSWORD_RECOVERY, ou session + fragment type=recovery). Une
 * session ordinaire ne doit pas suffire, sinon n'importe quelle session active
 * changerait le mot de passe sans le jeton.
 */

const h = vi.hoisted(() => {
  const state = {
    getSession: { data: { session: null as null | Record<string, unknown> } },
    update: { error: null as null | { message: string } },
    authCb: null as null | ((event: string) => void),
    push: vi.fn(),
    unsubscribe: vi.fn(),
  };
  const client = {
    auth: {
      onAuthStateChange: (cb: (event: string) => void) => {
        state.authCb = cb;
        return { data: { subscription: { unsubscribe: state.unsubscribe } } };
      },
      getSession: async () => state.getSession,
      updateUser: async () => state.update,
    },
  };
  return { state, client };
});

vi.mock('@/lib/supabase/client', () => ({ createClient: () => h.client }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: h.state.push, replace: vi.fn(), prefetch: vi.fn() }) }));

import ResetPasswordPage from '@/app/reset-password/page';

const loc = (hash = '') => ({ hash, href: 'http://localhost/reset-password' });

beforeEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, writable: true, value: loc() });
  h.state.getSession = { data: { session: null } };
  h.state.update = { error: null };
  h.state.authCb = null;
  h.state.push.mockClear();
  h.state.unsubscribe.mockClear();
});

describe('/reset-password', () => {
  it('session + fragment type=recovery : ouvre le formulaire', async () => {
    Object.defineProperty(window, 'location', { configurable: true, writable: true, value: loc('#type=recovery&access_token=x') });
    h.state.getSession = { data: { session: { access_token: 'x' } } };
    render(<ResetPasswordPage />);

    await waitFor(() => expect(screen.getByLabelText('Nouveau mot de passe')).toBeInTheDocument());
  });

  it('sans preuve de récupération : lien invalide, aucun formulaire', async () => {
    h.state.getSession = { data: { session: { access_token: 'x' } } }; // session normale, PAS de fragment
    render(<ResetPasswordPage />);

    await waitFor(() => expect(screen.getByText(/invalide ou a expiré/)).toBeInTheDocument());
    expect(screen.queryByLabelText('Nouveau mot de passe')).toBeNull();
  });

  it('l’événement PASSWORD_RECOVERY ouvre le formulaire', async () => {
    render(<ResetPasswordPage />);
    // getSession répond « pas de session », mais l'événement arrive.
    act(() => { h.state.authCb?.('PASSWORD_RECOVERY'); });
    await waitFor(() => expect(screen.getByLabelText('Nouveau mot de passe')).toBeInTheDocument());
  });

  it('refuse deux mots de passe différents', async () => {
    h.state.getSession = { data: { session: {} } };
    Object.defineProperty(window, 'location', { configurable: true, writable: true, value: loc('#type=recovery') });
    render(<ResetPasswordPage />);
    await screen.findByLabelText('Nouveau mot de passe');

    fireEvent.change(screen.getByLabelText('Nouveau mot de passe'), { target: { value: 'secret1' } });
    fireEvent.change(screen.getByLabelText('Confirmer'), { target: { value: 'secret2' } });
    fireEvent.click(screen.getByRole('button', { name: /Enregistrer le mot de passe/ }));

    expect(screen.getByText(/ne correspondent pas/)).toBeInTheDocument();
  });

  it('enregistre et redirige vers l’accueil', async () => {
    h.state.getSession = { data: { session: {} } };
    Object.defineProperty(window, 'location', { configurable: true, writable: true, value: loc('#type=recovery') });
    render(<ResetPasswordPage />);
    await screen.findByLabelText('Nouveau mot de passe');

    fireEvent.change(screen.getByLabelText('Nouveau mot de passe'), { target: { value: 'secret1' } });
    fireEvent.change(screen.getByLabelText('Confirmer'), { target: { value: 'secret1' } });
    fireEvent.click(screen.getByRole('button', { name: /Enregistrer le mot de passe/ }));

    await waitFor(() => expect(h.state.push).toHaveBeenCalledWith('/'));
  });

  it('affiche l’erreur de mise à jour', async () => {
    h.state.getSession = { data: { session: {} } };
    h.state.update = { error: { message: 'mot de passe trop faible' } };
    Object.defineProperty(window, 'location', { configurable: true, writable: true, value: loc('#type=recovery') });
    render(<ResetPasswordPage />);
    await screen.findByLabelText('Nouveau mot de passe');

    fireEvent.change(screen.getByLabelText('Nouveau mot de passe'), { target: { value: 'secret1' } });
    fireEvent.change(screen.getByLabelText('Confirmer'), { target: { value: 'secret1' } });
    fireEvent.click(screen.getByRole('button', { name: /Enregistrer le mot de passe/ }));

    await waitFor(() => expect(screen.getByText('mot de passe trop faible')).toBeInTheDocument());
    expect(h.state.push).not.toHaveBeenCalled();
  });
});
