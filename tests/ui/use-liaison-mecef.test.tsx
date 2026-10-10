import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

/**
 * Verrou e-MECeF (côté navigateur).
 *
 * La valeur NAÎT à false et ne passe à true QUE sur un verdict explicite du
 * serveur. Absence de session, échec réseau, réponse non-OK, réponse ambiguë :
 * tout laisse le verrou FERMÉ. Jamais l'inverse.
 */

const h = vi.hoisted(() => {
  const state = {
    session: null as null | { access_token: string },
    fetch: vi.fn(),
  };
  const supabase = { auth: { getSession: async () => ({ data: { session: state.session } }) } };
  return { state, supabase };
});

vi.mock('@/components/providers/SupabaseProvider', () => ({ useSupabase: () => ({ supabase: h.supabase }) }));

import { useLiaisonMecef } from '@/lib/hooks/useLiaisonMecef';

const json = (body: unknown, ok = true) => ({ ok, json: async () => body });

beforeEach(() => {
  h.state.session = { access_token: 'tok' };
  h.state.fetch.mockReset();
  h.state.fetch.mockImplementation(async () => json({ branche: true }));
  vi.stubGlobal('fetch', h.state.fetch);
});

describe('useLiaisonMecef', () => {
  it('sans session : verrou fermé, aucune requête', async () => {
    h.state.session = null;
    const { result } = renderHook(() => useLiaisonMecef());
    await waitFor(() => expect(h.state.fetch).not.toHaveBeenCalled());
    expect(result.current).toBe(false);
  });

  it('ouvre le verrou sur un verdict explicite du serveur', async () => {
    const { result } = renderHook(() => useLiaisonMecef());
    await waitFor(() => expect(result.current).toBe(true));
    // Le jeton de session part dans l'en-tête.
    expect(h.state.fetch).toHaveBeenCalledWith('/api/mecef/status', { headers: { Authorization: 'Bearer tok' } });
  });

  it('réponse non-OK : verrou fermé', async () => {
    h.state.fetch.mockImplementation(async () => json({ branche: true }, false));
    const { result } = renderHook(() => useLiaisonMecef());
    await waitFor(() => expect(h.state.fetch).toHaveBeenCalled());
    expect(result.current).toBe(false);
  });

  it('réponse ambiguë (branche absente) : verrou fermé', async () => {
    h.state.fetch.mockImplementation(async () => json({}));
    const { result } = renderHook(() => useLiaisonMecef());
    await waitFor(() => expect(h.state.fetch).toHaveBeenCalled());
    expect(result.current).toBe(false);
  });

  it('panne réseau : verrou fermé, pas d’exception', async () => {
    h.state.fetch.mockImplementation(async () => { throw new Error('offline'); });
    const { result } = renderHook(() => useLiaisonMecef());
    await waitFor(() => expect(h.state.fetch).toHaveBeenCalled());
    expect(result.current).toBe(false);
  });
});
