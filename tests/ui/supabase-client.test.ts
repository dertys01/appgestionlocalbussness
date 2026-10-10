import { describe, it, expect, vi } from 'vitest';

/**
 * createClient() est un singleton : une seule instance Supabase par onglet.
 *
 * En recréer une par appel multipliait les connexions (realtime, auth) et
 * pouvait perdre l'état de session.
 */
const h = vi.hoisted(() => ({ createClient: vi.fn(() => ({ tag: 'client-unique' })) }));
vi.mock('@supabase/supabase-js', () => ({ createClient: h.createClient }));

import { createClient } from '@/lib/supabase/client';

describe('supabase/client', () => {
  it('ne construit qu’une instance, réutilisée', () => {
    const a = createClient();
    const b = createClient();

    expect(a).toBe(b);
    expect(h.createClient).toHaveBeenCalledTimes(1);
    expect(h.createClient).toHaveBeenCalledWith(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    );
  });
});
