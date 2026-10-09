import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ConnexionPage from '@/app/connexion/page';

/**
 * /connexion — le formulaire de connexion a quitté la racine (P8).
 *
 * Deux comportements à tenir : le formulaire s'y trouve, et une session déjà
 * ouverte (invitation acceptée, mot de passe réinitialisé, connexion fraîche)
 * n'y reste pas — la page ramène à la racine, qui montre l'application.
 */

const replace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn(), prefetch: vi.fn() }),
}));

let session: { user: object | null; loading: boolean };
vi.mock('@/components/providers/SupabaseProvider', () => ({
  useSupabase: () => session,
}));

beforeEach(() => {
  replace.mockClear();
  session = { user: null, loading: false };
});

describe('/connexion', () => {
  it('sans session : montre le formulaire', () => {
    render(<ConnexionPage />);
    expect(screen.getByLabelText('Mot de passe')).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
  });

  it('session ouverte : pas de formulaire, retour à la racine', () => {
    session = { user: { id: 'u1' }, loading: false };
    render(<ConnexionPage />);
    expect(screen.queryByLabelText('Mot de passe')).toBeNull();
    expect(replace).toHaveBeenCalledWith('/');
  });

  it('session encore en cours de vérification : on attend, sans redirection', () => {
    session = { user: null, loading: true };
    render(<ConnexionPage />);
    expect(replace).not.toHaveBeenCalled();
    // LoginPage gère lui-même son état de chargement de formulaire.
    expect(screen.getByLabelText('Mot de passe')).toBeTruthy();
  });
});
