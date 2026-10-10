import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

/**
 * Les deux frontières d'erreur de l'App Router.
 *
 * Le dernier filet ne doit montrer AUCUN détail technique à l'utilisateur, mais
 * doit transmettre la trace (Sentry) et laisser réessayer.
 */
const h = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ captureException: h.captureException }));

import AppError from '@/app/error';
import GlobalError from '@/app/global-error';

describe('/error (route)', () => {
  it('message générique, trace envoyée, aucun détail technique, et Réessayer', () => {
    const reset = vi.fn();
    const err = Object.assign(new Error('secret interne'), { digest: 'd-1' });
    render(<AppError error={err} reset={reset} />);

    expect(screen.getByText(/Une erreur est survenue/)).toBeInTheDocument();
    expect(screen.queryByText(/secret interne/)).toBeNull();
    expect(h.captureException).toHaveBeenCalledWith(err);

    fireEvent.click(screen.getByRole('button', { name: /Réessayer/ }));
    expect(reset).toHaveBeenCalledTimes(1);
  });
});

describe('/global-error (layout racine)', () => {
  it('affiche un message autonome et réessaie', () => {
    const reset = vi.fn();
    render(<GlobalError error={new Error('x')} reset={reset} />);

    expect(screen.getByText(/Une erreur est survenue/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Réessayer/ }));
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
