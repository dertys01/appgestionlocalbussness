import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';

/**
 * Enregistreur du service worker.
 *
 * Règle : RIEN en développement (un SW actif en local fige les ressources et
 * brouille les recettes), et un échec d'enregistrement ne doit jamais gêner
 * l'application.
 */

import { EnregistreurPWA } from '@/components/pwa/EnregistreurPWA';

const register = vi.fn(() => Promise.resolve());

const avecServiceWorker = () =>
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { register } });
const sansServiceWorker = () =>
  delete (navigator as unknown as Record<string, unknown>).serviceWorker;

afterEach(() => {
  vi.unstubAllEnvs();
  register.mockClear();
  register.mockImplementation(() => Promise.resolve());
});

describe('EnregistreurPWA', () => {
  it('ne fait rien hors production', () => {
    vi.stubEnv('NODE_ENV', 'test');
    avecServiceWorker();
    render(<EnregistreurPWA />);
    expect(register).not.toHaveBeenCalled();
  });

  it('enregistre le service worker en production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    avecServiceWorker();
    render(<EnregistreurPWA />);
    await waitFor(() => expect(register).toHaveBeenCalledWith('/sw.js', { updateViaCache: 'none' }));
  });

  it('un échec d’enregistrement ne fait pas planter', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    register.mockImplementationOnce(() => Promise.reject(new Error('pas de SW')));
    avecServiceWorker();
    expect(() => render(<EnregistreurPWA />)).not.toThrow();
    await waitFor(() => expect(register).toHaveBeenCalled());
  });

  it('navigateur sans service worker : aucun effet', () => {
    vi.stubEnv('NODE_ENV', 'production');
    sansServiceWorker();
    render(<EnregistreurPWA />);
    expect(register).not.toHaveBeenCalled();
  });
});
