import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Journal d'activité : écriture best-effort.
 *
 * Une écriture qui échoue ne doit JAMAIS remonter (elle ne doit pas casser la
 * vente qu'elle journalise) — c'est la propriété qui compte.
 */
const h = vi.hoisted(() => ({ insert: vi.fn() }));

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: () => ({
      insert: h.insert,
      delete: () => ({ eq: () => ({ lt: () => Promise.resolve({ error: null }) }) }),
    }),
  }),
}));

import { logActivity } from '@/lib/utils/activity';

beforeEach(() => h.insert.mockReset());

describe('logActivity', () => {
  it('écrit une entrée avec l’acteur et l’action', async () => {
    h.insert.mockReturnValue({ error: null });
    await logActivity({ ownerId: 'o1', actorId: 'u1', actorEmail: 'a@b.c', action: 'sale', description: 'Vente test' });
    expect(h.insert).toHaveBeenCalledWith(expect.objectContaining({
      business_owner_id: 'o1', actor_id: 'u1', actor_email: 'a@b.c', action: 'sale', description: 'Vente test',
    }));
  });

  it('ne lève pas quand l’écriture échoue', async () => {
    h.insert.mockReturnValue({ error: { message: 'boom' } });
    const silence = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      logActivity({ ownerId: 'o1', actorId: 'u1', actorEmail: 'a@b.c', action: 'x', description: 'y' })
    ).resolves.toBeUndefined();
    silence.mockRestore();
  });

  it('utilise l’email comme nom quand actorName est absent', async () => {
    h.insert.mockReturnValue({ error: null });
    await logActivity({ ownerId: 'o1', actorId: 'u1', actorEmail: 'a@b.c', action: 'sale', description: 'Vente' });
    expect(h.insert).toHaveBeenCalledWith(expect.objectContaining({ actor_name: 'a@b.c' }));
  });

  it('déclenche la purge échantillonnée sans lever', async () => {
    h.insert.mockReturnValue({ error: null });
    const rnd = vi.spyOn(Math, 'random').mockReturnValue(0); // force la purge
    await expect(
      logActivity({ ownerId: 'o1', actorId: 'u1', actorEmail: 'a@b.c', action: 'sale', description: 'Vente' })
    ).resolves.toBeUndefined();
    rnd.mockRestore();
  });
});
