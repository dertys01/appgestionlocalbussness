import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

import { ErrorBoundary } from '@/components/ErrorBoundary';

function Boom(): never {
  throw new Error('boum');
}

describe('ErrorBoundary', () => {
  it('rend les enfants quand tout va bien', () => {
    render(<ErrorBoundary zone="ok"><p>contenu visible</p></ErrorBoundary>);
    expect(screen.getByText('contenu visible')).toBeInTheDocument();
  });

  it('affiche un repli au lieu de propager l’erreur', () => {
    // React journalise l'erreur capturée : on la tait pour un test lisible.
    const silence = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<ErrorBoundary zone="pos"><Boom /></ErrorBoundary>);
    expect(screen.getByText(/n'a pas pu s'afficher/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Réessayer/i })).toBeInTheDocument();
    silence.mockRestore();
  });
});
